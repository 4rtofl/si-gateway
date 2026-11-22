/*
 * プロバイダの応答から使用量を取り出す。ストリーミング(SSE)とふつうの JSON の両方を扱う。
 * 取り出した使用量は、プロバイダによらず Usage の形にそろえる(docs/design.md 5.1)。
 */

import type { UsageStyle } from "./providers.ts";

export interface Usage {
	/** キャッシュを使わなかった入力 */
	inputTokens: number;
	/** キャッシュから読んだ入力 */
	cacheReadTokens: number;
	/** キャッシュに書いた入力(Anthropic の5分。OpenAI は0) */
	cacheWriteTokens: number;
	/** キャッシュに書いた入力(Anthropic の1時間) */
	cacheWrite1hTokens: number;
	/** 出力(推論のトークンを含む) */
	outputTokens: number;
	/** サーバー側の Web 検索の回数(Anthropic の usage.server_tool_use.web_search_requests) */
	webSearchRequests: number;
}

export interface UsageReport {
	usage: Usage;
	/** 応答に書かれていたモデル */
	model: string | null;
	/** 応答に実費が書かれていれば、その額(nano USD) */
	providerCostNano: number | null;
	serviceTier: string | null;
	/** 使用量を最後まで受け取れたか */
	complete: boolean;
	/** 使用量が1つでも見つかったか */
	found: boolean;
}

export function emptyUsage(): Usage {
	return {
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cacheWrite1hTokens: 0,
		outputTokens: 0,
		webSearchRequests: 0,
	};
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 応答の JSON(ストリーミングなら1つ1つのイベント)を受け取り、使用量を組み立てる */
export class UsageCollector {
	private readonly style: UsageStyle;
	private report: UsageReport = {
		usage: emptyUsage(),
		model: null,
		providerCostNano: null,
		serviceTier: null,
		complete: false,
		found: false,
	};

	constructor(style: UsageStyle) {
		this.style = style;
	}

	/** ストリーミングでないときの、応答の本文全体 */
	onBody(body: unknown): void {
		this.onEvent(body);
		if (this.report.found) {
			this.report.complete = true;
		}
	}

	/** SSE のイベント1つ分の JSON */
	onEvent(event: unknown): void {
		if (!isObject(event)) {
			return;
		}
		if (this.style === "anthropic") {
			this.onAnthropic(event);
		} else {
			this.onOpenAi(event);
		}
	}

	result(): UsageReport {
		return this.report;
	}

	private onOpenAi(event: Json): void {
		// Responses API のイベント(response.completed など)は、response の中に使用量がある
		const response = isObject(event.response) ? event.response : null;
		const target = response ?? event;
		if (typeof target.model === "string" && !this.report.model) {
			this.report.model = target.model;
		}
		if (typeof target.service_tier === "string") {
			this.report.serviceTier = target.service_tier;
		}
		const usage = target.usage;
		if (isObject(usage)) {
			this.report.usage = normalizeOpenAiUsage(usage);
			this.report.found = true;
			// OpenRouter は usage.cost に実費(USD)を書く
			if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) {
				this.report.providerCostNano = Math.round(usage.cost * 1e9);
			}
			// Chat Completions のストリーミングでは、使用量のチャンクが最後に来る
			if (!response || event.type === "response.completed") {
				this.report.complete = true;
			}
		}
		if (
			event.type === "response.incomplete" ||
			event.type === "response.failed"
		) {
			this.report.complete = true;
		}
	}

	private onAnthropic(event: Json): void {
		const message = isObject(event.message) ? event.message : null;
		if (event.type === "message_start" && message) {
			if (typeof message.model === "string") {
				this.report.model = message.model;
			}
			if (isObject(message.usage)) {
				this.mergeAnthropicUsage(message.usage);
			}
			return;
		}
		if (event.type === "message_delta" && isObject(event.usage)) {
			this.mergeAnthropicUsage(event.usage);
			return;
		}
		if (event.type === "message_stop") {
			this.report.complete = true;
			return;
		}
		// ストリーミングでない応答(type = "message")
		if (event.type === "message" && isObject(event.usage)) {
			if (typeof event.model === "string") {
				this.report.model = event.model;
			}
			this.mergeAnthropicUsage(event.usage);
		}
	}

	/** Anthropic の使用量を足し込む。message_delta の値は累計なので、書かれている項目だけを上書きする */
	private mergeAnthropicUsage(usage: Json): void {
		const current = this.report.usage;
		if (typeof usage.input_tokens === "number") {
			current.inputTokens = usage.input_tokens;
		}
		if (typeof usage.cache_read_input_tokens === "number") {
			current.cacheReadTokens = usage.cache_read_input_tokens;
		}
		if (typeof usage.cache_creation_input_tokens === "number") {
			const total = usage.cache_creation_input_tokens;
			const detail = isObject(usage.cache_creation)
				? usage.cache_creation
				: null;
			const oneHour = detail ? num(detail.ephemeral_1h_input_tokens) : 0;
			current.cacheWrite1hTokens = Math.min(oneHour, total);
			current.cacheWriteTokens = total - current.cacheWrite1hTokens;
		}
		if (typeof usage.output_tokens === "number") {
			current.outputTokens = usage.output_tokens;
		}
		// Web 検索の回数。message_start では0か書かれず、message_delta に累計が来る
		const serverTools = isObject(usage.server_tool_use)
			? usage.server_tool_use
			: null;
		if (serverTools && typeof serverTools.web_search_requests === "number") {
			current.webSearchRequests = num(serverTools.web_search_requests);
		}
		if (typeof usage.service_tier === "string") {
			this.report.serviceTier = usage.service_tier;
		}
		this.report.found = true;
	}
}

/** OpenAI 互換の usage を Usage にそろえる。Chat Completions と Responses の両方の書き方を受け付ける */
export function normalizeOpenAiUsage(usage: Json): Usage {
	const result = emptyUsage();
	if (typeof usage.prompt_tokens === "number") {
		const details = isObject(usage.prompt_tokens_details)
			? usage.prompt_tokens_details
			: {};
		const cached = Math.min(num(details.cached_tokens), usage.prompt_tokens);
		result.inputTokens = usage.prompt_tokens - cached;
		result.cacheReadTokens = cached;
		result.outputTokens = num(usage.completion_tokens);
		// 推論のトークンを completion_tokens に含めないプロバイダがある(xAI)。合計との差を出力に足す
		const total = num(usage.total_tokens);
		const counted = usage.prompt_tokens + result.outputTokens;
		if (total > counted) {
			result.outputTokens += total - counted;
		}
		return result;
	}
	if (typeof usage.input_tokens === "number") {
		const details = isObject(usage.input_tokens_details)
			? usage.input_tokens_details
			: {};
		const cached = Math.min(num(details.cached_tokens), usage.input_tokens);
		result.inputTokens = usage.input_tokens - cached;
		result.cacheReadTokens = cached;
		result.outputTokens = num(usage.output_tokens);
	}
	return result;
}

/**
 * SSE(Server-Sent Events)のバイト列を、イベントの data ごとに切り出す。
 * 応答の全部のイベントを JSON として読むと CPU を使うので、使用量に関わりそうなイベントだけを読む。
 */
export class SseParser {
	private readonly decoder = new TextDecoder();
	private buffer = "";
	private data: string[] = [];
	private readonly onData: (data: string) => void;

	constructor(onData: (data: string) => void) {
		this.onData = onData;
	}

	push(chunk: Uint8Array): void {
		this.buffer += this.decoder.decode(chunk, { stream: true });
		this.drain();
	}

	end(): void {
		this.buffer += this.decoder.decode();
		this.buffer += "\n\n";
		this.drain();
	}

	private drain(): void {
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) {
				line = line.slice(0, -1);
			}
			if (line === "") {
				if (this.data.length > 0) {
					this.onData(this.data.join("\n"));
					this.data = [];
				}
			} else if (line.startsWith("data:")) {
				this.data.push(line.slice(line[5] === " " ? 6 : 5));
			}
			newline = this.buffer.indexOf("\n");
		}
	}
}

/** そのイベントを JSON として読む必要があるか(使用量やモデル、終わりの印を含みそうか) */
export function isInterestingEvent(data: string, needModel: boolean): boolean {
	return (
		data.includes('"usage"') ||
		data.includes("message_stop") ||
		data.includes("response.incomplete") ||
		data.includes("response.failed") ||
		(needModel && data.includes('"model"'))
	);
}

/** SSE のストリームを最後まで読み、使用量を返す */
export async function collectFromSse(
	stream: ReadableStream<Uint8Array>,
	style: UsageStyle,
): Promise<UsageReport> {
	const collector = new UsageCollector(style);
	const parser = new SseParser((data) => {
		if (data === "[DONE]") {
			return;
		}
		if (!isInterestingEvent(data, collector.result().model === null)) {
			return;
		}
		try {
			collector.onEvent(JSON.parse(data));
		} catch {
			// JSON でないイベントは読み飛ばす
		}
	});
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			parser.push(value);
		}
		parser.end();
	} catch {
		// クライアントの切断などで途中で終わったら、それまでの分を返す
	}
	return collector.result();
}

/** JSON の本文から使用量を返す。JSON でなければ、使用量なしとして返す */
export function collectFromJson(text: string, style: UsageStyle): UsageReport {
	const collector = new UsageCollector(style);
	try {
		collector.onBody(JSON.parse(text));
	} catch {
		// JSON でない(音声のファイルなど)
	}
	return collector.result();
}
