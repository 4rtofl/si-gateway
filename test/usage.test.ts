import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../src/proxy/providers.ts";
import {
	collectFromJson,
	collectFromSse,
	normalizeOpenAiUsage,
	SseParser,
} from "../src/proxy/usage.ts";
import { sse, streamOf } from "./helpers.ts";

describe("OpenAI の使用量", () => {
	it("Chat Completions のストリーミングで、最後のチャンクの usage を読む", async () => {
		const body = sse(
			[
				{
					model: "gpt-4.1-2025-04-14",
					choices: [{ delta: { content: "Hi" } }],
					usage: null,
				},
				{
					model: "gpt-4.1-2025-04-14",
					choices: [{ delta: { content: "!" } }],
					usage: null,
				},
				{
					model: "gpt-4.1-2025-04-14",
					choices: [],
					usage: {
						prompt_tokens: 120,
						completion_tokens: 30,
						total_tokens: 150,
						prompt_tokens_details: { cached_tokens: 100 },
					},
				},
			],
			true,
		);
		// チャンクの区切りを、イベントの途中にする
		const report = await collectFromSse(
			streamOf([body.slice(0, 37), body.slice(37, 200), body.slice(200)]),
			"openai",
		);
		expect(report.model).toBe("gpt-4.1-2025-04-14");
		expect(report.usage).toEqual({
			inputTokens: 20,
			cacheReadTokens: 100,
			cacheWriteTokens: 0,
			cacheWrite1hTokens: 0,
			outputTokens: 30,
			webSearchRequests: 0,
		});
		expect(report.complete).toBe(true);
	});

	it("使用量のチャンクが来なければ、途中で終わったものとする", async () => {
		const body = sse([
			{ model: "gpt-4.1", choices: [{ delta: { content: "Hi" } }] },
		]);
		const report = await collectFromSse(streamOf([body]), "openai");
		expect(report.found).toBe(false);
		expect(report.complete).toBe(false);
	});

	it("Responses API の response.completed を読む", async () => {
		const body = sse([
			{ type: "response.created", response: { model: "gpt-5", usage: null } },
			{ type: "response.output_text.delta", delta: "x" },
			{
				type: "response.completed",
				response: {
					model: "gpt-5",
					service_tier: "flex",
					usage: {
						input_tokens: 1000,
						input_tokens_details: { cached_tokens: 400 },
						output_tokens: 250,
						output_tokens_details: { reasoning_tokens: 200 },
					},
				},
			},
		]);
		const report = await collectFromSse(streamOf([body]), "openai");
		expect(report.usage.inputTokens).toBe(600);
		expect(report.usage.cacheReadTokens).toBe(400);
		expect(report.usage.outputTokens).toBe(250);
		expect(report.serviceTier).toBe("flex");
		expect(report.complete).toBe(true);
	});

	it("xAI のように推論のトークンが completion_tokens に入っていなければ、合計との差を出力に足す", () => {
		const usage = normalizeOpenAiUsage({
			prompt_tokens: 100,
			completion_tokens: 50,
			total_tokens: 350,
			completion_tokens_details: { reasoning_tokens: 200 },
		});
		expect(usage.outputTokens).toBe(250);
	});

	it("OpenRouter の usage.cost を実費として読む", () => {
		const report = collectFromJson(
			JSON.stringify({
				model: "anthropic/claude-sonnet-4.5",
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
					cost: 0.00123,
				},
			}),
			"openai",
		);
		expect(report.providerCostNano).toBe(1_230_000);
		expect(report.complete).toBe(true);
	});

	it("Embeddings の使用量を読む", () => {
		const report = collectFromJson(
			JSON.stringify({
				model: "text-embedding-3-small",
				usage: { prompt_tokens: 8, total_tokens: 8 },
			}),
			"openai",
		);
		expect(report.usage.inputTokens).toBe(8);
		expect(report.usage.outputTokens).toBe(0);
	});
});

describe("Anthropic の使用量", () => {
	it("message_start と message_delta を合わせ、1時間キャッシュを分ける", async () => {
		const body = [
			"event: message_start\n",
			`data: ${JSON.stringify({
				type: "message_start",
				message: {
					model: "claude-sonnet-4-5-20250929",
					usage: {
						input_tokens: 12,
						cache_creation_input_tokens: 3000,
						cache_read_input_tokens: 5000,
						cache_creation: {
							ephemeral_5m_input_tokens: 1000,
							ephemeral_1h_input_tokens: 2000,
						},
						output_tokens: 1,
					},
				},
			})}\n\n`,
			`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { text: "こんにちは" } })}\n\n`,
			`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 420 } })}\n\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
		].join("");
		const report = await collectFromSse(streamOf([body]), "anthropic");
		expect(report.model).toBe("claude-sonnet-4-5-20250929");
		expect(report.usage).toEqual({
			inputTokens: 12,
			cacheReadTokens: 5000,
			cacheWriteTokens: 1000,
			cacheWrite1hTokens: 2000,
			outputTokens: 420,
			webSearchRequests: 0,
		});
		expect(report.complete).toBe(true);
	});

	it("ストリーミングでない応答を読む", () => {
		const report = collectFromJson(
			JSON.stringify({
				type: "message",
				model: "claude-haiku-4-5",
				usage: { input_tokens: 50, output_tokens: 10 },
			}),
			"anthropic",
		);
		expect(report.usage.inputTokens).toBe(50);
		expect(report.usage.outputTokens).toBe(10);
		expect(report.complete).toBe(true);
	});

	it("Web 検索の回数を、message_delta の累計で読む", async () => {
		const body = sse([
			{
				type: "message_start",
				message: {
					model: "claude-sonnet-4-5",
					usage: {
						input_tokens: 100,
						output_tokens: 1,
						server_tool_use: { web_search_requests: 0 },
					},
				},
			},
			{
				type: "message_delta",
				usage: {
					output_tokens: 50,
					server_tool_use: { web_search_requests: 1 },
				},
			},
			{
				type: "message_delta",
				usage: {
					output_tokens: 300,
					server_tool_use: { web_search_requests: 3 },
				},
			},
			// server_tool_use が書かれていなければ、前の値を残す
			{ type: "message_delta", usage: { output_tokens: 320 } },
			{ type: "message_stop" },
		]);
		const report = await collectFromSse(streamOf([body]), "anthropic");
		expect(report.usage.webSearchRequests).toBe(3);
		expect(report.usage.outputTokens).toBe(320);
	});

	it("ストリーミングでない応答の Web 検索の回数を読む", () => {
		const report = collectFromJson(
			JSON.stringify({
				type: "message",
				model: "claude-sonnet-4-5",
				usage: {
					input_tokens: 50,
					output_tokens: 10,
					server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
				},
			}),
			"anthropic",
		);
		expect(report.usage.webSearchRequests).toBe(2);
	});

	it("count_tokens の応答は使用量として数えない", () => {
		const report = collectFromJson(
			JSON.stringify({ input_tokens: 999 }),
			"anthropic",
		);
		expect(report.found).toBe(false);
	});
});

describe("TypeSafe の使用量", () => {
	it("System One の応答の usage.input_tokens と usage.output_tokens を読む", () => {
		const report = collectFromJson(
			JSON.stringify({
				model: "jev-1.14.0",
				answers: { ok: { type: "noul", noul: 0.9 } },
				usage: { input_tokens: 1234, output_tokens: 5 },
			}),
			PROVIDERS.typesafe.usageStyle,
		);
		expect(report).toMatchObject({
			model: "jev-1.14.0",
			found: true,
			complete: true,
			usage: { inputTokens: 1234, cacheReadTokens: 0, outputTokens: 5 },
		});
	});

	it("モデルの一覧(GET /v1/models)は使用量なしとして読む", () => {
		const report = collectFromJson(
			JSON.stringify({ object: "list", data: [{ id: "jev-latest" }] }),
			PROVIDERS.typesafe.usageStyle,
		);
		expect(report.found).toBe(false);
	});
});

describe("SseParser", () => {
	it("マルチバイト文字がチャンクの境目で割れても読める", () => {
		const data: string[] = [];
		const parser = new SseParser((value) => data.push(value));
		const bytes = new TextEncoder().encode('data: {"t":"日本語"}\r\n\r\n');
		parser.push(bytes.slice(0, 13));
		parser.push(bytes.slice(13));
		parser.end();
		expect(data).toEqual(['{"t":"日本語"}']);
	});

	it("コメントの行を読み飛ばす", () => {
		const data: string[] = [];
		const parser = new SseParser((value) => data.push(value));
		parser.push(
			new TextEncoder().encode(": OPENROUTER PROCESSING\n\ndata: 1\n\n"),
		);
		parser.end();
		expect(data).toEqual(["1"]);
	});
});
