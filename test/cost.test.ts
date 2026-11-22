import { describe, expect, it } from "vitest";
import {
	computeCostNano,
	findPrice,
	modelCandidates,
} from "../src/pricing/cost.ts";
import { extractLiteLlmPrices } from "../src/pricing/store.ts";
import type { Price } from "../src/pricing/types.ts";
import { emptyUsage } from "../src/proxy/usage.ts";

const sonnet: Price = {
	input: 3e-6,
	output: 15e-6,
	cacheRead: 0.3e-6,
	cacheWrite: 3.75e-6,
	inputAbove200k: 6e-6,
	outputAbove200k: 22.5e-6,
};

describe("computeCostNano", () => {
	it("入力・キャッシュ・出力の単価を掛けて足す", () => {
		const usage = {
			...emptyUsage(),
			inputTokens: 1000,
			cacheReadTokens: 10_000,
			cacheWriteTokens: 2000,
			outputTokens: 500,
		};
		// 1000*3 + 10000*0.3 + 2000*3.75 + 500*15 = 3000 + 3000 + 7500 + 7500 = 21000 マイクロドル
		expect(computeCostNano(usage, sonnet)).toBe(21_000_000);
	});

	it("1時間キャッシュの単価がなければ、入力の2倍にする", () => {
		const usage = { ...emptyUsage(), cacheWrite1hTokens: 1000 };
		expect(computeCostNano(usage, sonnet)).toBe(6_000_000);
	});

	it("入力の合計が20万トークンを超えたら、長いコンテキストの単価にする", () => {
		const usage = { ...emptyUsage(), inputTokens: 250_000, outputTokens: 1000 };
		expect(computeCostNano(usage, sonnet)).toBe(1_522_500_000);
	});

	it("service_tier の単価があれば使う", () => {
		const price: Price = {
			input: 1e-6,
			output: 2e-6,
			tiers: { flex: { input: 0.5e-6, output: 1e-6 } },
		};
		const usage = { ...emptyUsage(), inputTokens: 1000, outputTokens: 1000 };
		expect(computeCostNano(usage, price, "flex")).toBe(1_500_000);
		expect(computeCostNano(usage, price, "default")).toBe(3_000_000);
	});

	it("Web 検索は、単価表の単価がなければ1回 $0.01 で足す", () => {
		const usage = { ...emptyUsage(), inputTokens: 1000, webSearchRequests: 3 };
		// 1000*3 マイクロドル + 3*0.01 ドル
		expect(computeCostNano(usage, sonnet)).toBe(3_000_000 + 30_000_000);
		expect(computeCostNano(usage, { ...sonnet, webSearch: 0.02 })).toBe(
			3_000_000 + 60_000_000,
		);
	});
});

describe("単価の検索", () => {
	it("日付を外した名前でも探す", () => {
		expect(modelCandidates("claude-sonnet-4-5-20250929")).toContain(
			"claude-sonnet-4-5",
		);
		expect(modelCandidates("gpt-4o-2024-08-06")).toContain("gpt-4o");
		const prices = new Map([["gpt-4o", { input: 1, output: 2 }]]);
		expect(findPrice(prices, "gpt-4o-2024-08-06")).toEqual({
			input: 1,
			output: 2,
		});
		expect(findPrice(prices, "gpt-5")).toBeNull();
	});

	it("TypeSafe の版の番号と -latest を外した名前でも探す", () => {
		const jev: Price = { input: 0.042e-6, output: 0 };
		const prices = new Map([["jev", jev]]);
		expect(findPrice(prices, "jev-1.14.0")).toEqual(jev);
		expect(findPrice(prices, "jev-latest")).toEqual(jev);
		const usage = { ...emptyUsage(), inputTokens: 1_000_000, outputTokens: 50 };
		expect(computeCostNano(usage, jev)).toBe(42_000_000);
	});
});

describe("LiteLLM の価格表", () => {
	it("対応するプロバイダの行だけを取り出し、接頭辞を外す", () => {
		const rows = extractLiteLlmPrices({
			sample_spec: { input_cost_per_token: 0 },
			"claude-sonnet-4-5": {
				litellm_provider: "anthropic",
				input_cost_per_token: 3e-6,
				output_cost_per_token: 15e-6,
				cache_creation_input_token_cost: 3.75e-6,
				cache_creation_input_token_cost_above_1hr: 6e-6,
				search_context_cost_per_query: {
					search_context_size_low: 0.01,
					search_context_size_medium: 0.01,
					search_context_size_high: 0.01,
				},
			},
			"xai/grok-4": {
				litellm_provider: "xai",
				input_cost_per_token: 3e-6,
				output_cost_per_token: 15e-6,
			},
			"openrouter/openai/gpt-4o": {
				litellm_provider: "openrouter",
				input_cost_per_token: 2.5e-6,
				output_cost_per_token: 10e-6,
			},
			"gpt-5": {
				litellm_provider: "openai",
				input_cost_per_token: 1.25e-6,
				output_cost_per_token: 10e-6,
				input_cost_per_token_flex: 0.625e-6,
			},
			"gemini-2.5-pro": {
				litellm_provider: "gemini",
				input_cost_per_token: 1e-6,
				output_cost_per_token: 1e-6,
			},
			"dall-e-3": { litellm_provider: "openai", output_cost_per_pixel: 1 },
			// TypeSafe は価格表から取り込まない(手で決めた単価を使う)
			"typesafe/jev": {
				litellm_provider: "typesafe",
				input_cost_per_token: 1,
				output_cost_per_token: 1,
			},
		});
		expect(rows.map((row) => `${row.provider}:${row.model}`).sort()).toEqual([
			"anthropic:claude-sonnet-4-5",
			"openai:gpt-5",
			"openrouter:openai/gpt-4o",
			"xai:grok-4",
		]);
		expect(
			rows.find((row) => row.model === "claude-sonnet-4-5")?.price.cacheWrite1h,
		).toBe(6e-6);
		expect(
			rows.find((row) => row.model === "claude-sonnet-4-5")?.price.webSearch,
		).toBe(0.01);
		expect(rows.find((row) => row.model === "grok-4")?.price.webSearch).toBe(
			undefined,
		);
		expect(rows.find((row) => row.model === "gpt-5")?.price.tiers).toEqual({
			flex: { input: 0.625e-6 },
		});
	});
});
