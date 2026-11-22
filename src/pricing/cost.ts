/*
 * 使用量と単価から料金を計算する。
 */

import type { Usage } from "../proxy/usage.ts";
import type { Price } from "./types.ts";

const LONG_CONTEXT_THRESHOLD = 200_000;

/** 料金(nano USD)を計算する */
export function computeCostNano(
	usage: Usage,
	price: Price,
	serviceTier: string | null = null,
): number {
	const p: Price =
		serviceTier && price.tiers?.[serviceTier]
			? { ...price, ...price.tiers[serviceTier] }
			: price;
	const totalInput =
		usage.inputTokens +
		usage.cacheReadTokens +
		usage.cacheWriteTokens +
		usage.cacheWrite1hTokens;
	const long =
		totalInput > LONG_CONTEXT_THRESHOLD && p.inputAbove200k !== undefined;
	const input = long ? (p.inputAbove200k ?? p.input) : p.input;
	const output = long ? (p.outputAbove200k ?? p.output) : p.output;
	const cacheRead = long
		? (p.cacheReadAbove200k ?? p.cacheRead ?? input)
		: (p.cacheRead ?? input);
	const cacheWrite = long
		? (p.cacheWriteAbove200k ?? p.cacheWrite ?? input)
		: (p.cacheWrite ?? input);
	const cacheWrite1h = p.cacheWrite1h ?? input * 2;
	const usd =
		usage.inputTokens * input +
		usage.cacheReadTokens * cacheRead +
		usage.cacheWriteTokens * cacheWrite +
		usage.cacheWrite1hTokens * cacheWrite1h +
		usage.outputTokens * output;
	return Math.round(usd * 1e9);
}

/**
 * 20万トークンを超えたときの単価を外した単価。Managed Agents のセッションの使用量は、
 * 多くの呼び出しの累計の差なので、合計が20万を超えても1回の呼び出しが長いとは限らない
 */
export function withoutLongContext(price: Price): Price {
	return {
		...price,
		inputAbove200k: undefined,
		outputAbove200k: undefined,
		cacheReadAbove200k: undefined,
		cacheWriteAbove200k: undefined,
	};
}

/**
 * 単価表でモデルを探すときの候補。完全一致のあと、日付を外した名前を試す。
 * 例: claude-sonnet-4-5-20250929 → claude-sonnet-4-5、gpt-4o-2024-08-06 → gpt-4o
 */
export function modelCandidates(model: string): string[] {
	const candidates = [model];
	const add = (value: string) => {
		if (value && !candidates.includes(value)) {
			candidates.push(value);
		}
	};
	add(model.toLowerCase());
	add(model.replace(/-\d{4}-\d{2}-\d{2}$/, ""));
	add(model.replace(/-\d{8}$/, ""));
	add(model.replace(/@\d{8}$/, ""));
	// OpenRouter の「:free」「:beta」などの接尾辞
	add(model.replace(/:[a-z-]+$/, ""));
	return candidates;
}

/** 単価の検索。prices は「モデル名 → 単価」 */
export function findPrice(
	prices: ReadonlyMap<string, Price>,
	model: string,
): Price | null {
	for (const candidate of modelCandidates(model)) {
		const price = prices.get(candidate);
		if (price) {
			return price;
		}
	}
	return null;
}
