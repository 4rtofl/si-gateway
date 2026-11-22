/*
 * Anthropic の Managed Agents のセッションの料金を記録する。docs/design.md「5.3 Managed Agents のセッション」
 *
 * 料金はセッションの中で発生し、中継した応答(POST /v1/sessions やイベントの送信)には出てこない。
 * そこで、POST /v1/sessions を中継したときにセッションを agent_sessions に記録し、
 * Cron(5分ごと)と DELETE /v1/sessions/{id} の中継の直前に GET /v1/sessions/{id} の usage(累計)を読んで、
 * 前回読んだ累計から増えた分を usage_events に書く。
 */

import {
	type AgentSession,
	type EndReason,
	endAgentSession,
	getAgentSession,
	insertAgentSession,
	listDueAgentSessions,
	type SessionTotals,
	saveSessionUsage,
} from "../db/agent-sessions.ts";
import type { UsageEventInput } from "../db/usage.ts";
import { decryptText } from "../lib/crypto.ts";
import {
	computeCostNano,
	findPrice,
	withoutLongContext,
} from "../pricing/cost.ts";
import { loadProviderPrices } from "../pricing/store.ts";
import type { Price } from "../pricing/types.ts";
import { PROVIDERS } from "./providers.ts";

/**
 * Cron から読むときに送る anthropic-beta。セッションを作ったときのヘッダーがあれば、そちらを使う。
 * @anthropic-ai/sdk 1.1.0 が Managed Agents の API に付けるものと同じ値
 */
export const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
const ANTHROPIC_VERSION = "2023-06-01";

/** 実行時間の単価(USD / 時間)。usage.active_seconds に掛ける */
export const RUNTIME_USD_PER_HOUR = 0.08;
/** 実行時間の行の model に入れる名前 */
export const RUNTIME_MODEL = "managed-agents-runtime";

/** 1回の Cron で読むセッションの上限 */
const POLL_LIMIT = 100;
/** 同時に読むセッションの数(Workers の同時接続の上限は6) */
const POLL_CONCURRENCY = 5;
/** DELETE の中継の前に、最後の分を読むのを待つ時間 */
export const DELETE_WAIT_MS = 3_000;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

/** 「/v1/sessions/{id}」と、その下のパス(/events など)から、セッション ID を取り出す */
export function sessionIdOf(path: string): string | null {
	return path.match(/^\/v1\/sessions\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1] ?? null;
}

/** DELETE /v1/sessions/{id}(セッションそのものの削除)か */
export function isSessionDelete(method: string, path: string): boolean {
	return method === "DELETE" && /^\/v1\/sessions\/[A-Za-z0-9_-]+$/.test(path);
}

export interface SessionSnapshot {
	id: string | null;
	status: string | null;
	model: string | null;
	totals: SessionTotals;
}

/** セッション(GET /v1/sessions/{id} や POST /v1/sessions の応答)から、累計と状態とモデルを読む */
export function readSession(body: unknown): SessionSnapshot | null {
	if (!isObject(body) || body.type !== "session") {
		return null;
	}
	const usage = isObject(body.usage) ? body.usage : {};
	const cacheCreation = isObject(usage.cache_creation)
		? usage.cache_creation
		: {};
	const agent = isObject(body.agent) ? body.agent : {};
	// agent.model は { id, effort, … }。文字列で返ってきても読めるようにしておく
	const model = isObject(agent.model)
		? typeof agent.model.id === "string"
			? agent.model.id
			: null
		: typeof agent.model === "string"
			? agent.model
			: null;
	return {
		id: typeof body.id === "string" ? body.id : null,
		status: typeof body.status === "string" ? body.status : null,
		model,
		totals: {
			inputTokens: num(usage.input_tokens),
			cacheReadTokens: num(usage.cache_read_input_tokens),
			cacheWriteTokens: num(cacheCreation.ephemeral_5m_input_tokens),
			cacheWrite1hTokens: num(cacheCreation.ephemeral_1h_input_tokens),
			outputTokens: num(usage.output_tokens),
			activeSeconds: num(usage.active_seconds),
		},
	};
}

/**
 * 前回の累計と今回の累計から、増えた分を出す。累計が減った項目は0とし、累計は前回の値のままにする
 * (次に読んだときに、同じ分を二重に数えないため)
 */
export function diffTotals(
	previous: SessionTotals,
	next: SessionTotals,
): { delta: SessionTotals; totals: SessionTotals } {
	const keys = Object.keys(previous) as (keyof SessionTotals)[];
	const delta = {} as SessionTotals;
	const totals = {} as SessionTotals;
	for (const key of keys) {
		totals[key] = Math.max(previous[key], next[key]);
		delta[key] = totals[key] - previous[key];
	}
	return { delta, totals };
}

/** 実行時間の累計(秒)の料金(nano USD) */
export function runtimeCostNano(activeSeconds: number): number {
	return Math.round((activeSeconds * RUNTIME_USD_PER_HOUR * 1e9) / 3600);
}

/**
 * 増えた分を usage_events の行にする。トークンの行(単価はセッションのモデル)と、実行時間の行に分ける。
 * 実行時間の料金は、丸めの誤差がたまらないよう、累計の料金の差にする。
 */
export function sessionEvents(
	session: AgentSession,
	model: string | null,
	previous: SessionTotals,
	totals: SessionTotals,
	price: Price | null,
	context: { method: string; createdAt: number },
): UsageEventInput[] {
	const delta = {
		inputTokens: totals.inputTokens - previous.inputTokens,
		cacheReadTokens: totals.cacheReadTokens - previous.cacheReadTokens,
		cacheWriteTokens: totals.cacheWriteTokens - previous.cacheWriteTokens,
		cacheWrite1hTokens: totals.cacheWrite1hTokens - previous.cacheWrite1hTokens,
		outputTokens: totals.outputTokens - previous.outputTokens,
	};
	const base = {
		createdAt: context.createdAt,
		userId: session.userId,
		sigwKeyId: session.sigwKeyId,
		providerKeyId: session.providerKeyId,
		ownerId: session.ownerId,
		provider: PROVIDERS.anthropic.id,
		method: context.method,
		path: `/v1/sessions/${session.id}`,
		stream: false,
		status: 200,
		serviceTier: null,
		incomplete: false,
		ttfbMs: null,
		durationMs: 0,
		upstreamRequestId: null,
		error: null,
		// セッションを作ったリクエストの入口を引き継ぐ(代理の呼び出しで作ったセッションなら 'bobert')
		via: session.via,
	};
	const events: UsageEventInput[] = [];
	const tokens =
		delta.inputTokens +
		delta.cacheReadTokens +
		delta.cacheWriteTokens +
		delta.cacheWrite1hTokens +
		delta.outputTokens;
	if (tokens > 0) {
		// 累計の差は多くの呼び出しの合計なので、20万トークンを超えたときの単価は使わない
		const costNano = price
			? computeCostNano(delta, withoutLongContext(price))
			: null;
		events.push({
			...base,
			model,
			usage: delta,
			costNano,
			costSource: costNano === null ? null : "pricing",
		});
	}
	const runtimeNano =
		runtimeCostNano(totals.activeSeconds) -
		runtimeCostNano(previous.activeSeconds);
	if (runtimeNano > 0) {
		events.push({
			...base,
			model: RUNTIME_MODEL,
			usage: {
				inputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cacheWrite1hTokens: 0,
				outputTokens: 0,
			},
			costNano: runtimeNano,
			costSource: "pricing",
		});
	}
	return events;
}

export interface PollTarget {
	env: Env;
	/** 転送先のオリジン(UPSTREAM_OVERRIDE を反映したもの) */
	origin: string;
	apiKey: string;
}

export type PollResult = "recorded" | "unchanged" | EndReason | "error";

/** GET /v1/sessions/{id} で累計を読み、増えた分を記録する */
export async function pollSession(
	target: PollTarget,
	session: AgentSession,
	method: "GET" | "DELETE",
	now = Date.now(),
	signal?: AbortSignal,
): Promise<PollResult> {
	const headers = new Headers({
		"x-api-key": target.apiKey,
		"anthropic-version": ANTHROPIC_VERSION,
		"anthropic-beta": session.anthropicBeta ?? MANAGED_AGENTS_BETA,
	});
	const response = await fetch(
		`${target.origin}/v1/sessions/${encodeURIComponent(session.id)}`,
		{ headers, signal },
	);
	if (response.status === 404) {
		await response.body?.cancel();
		await endAgentSession(target.env.DB, session.id, "not_found", now);
		return "not_found";
	}
	if (!response.ok) {
		const text = await response.text();
		console.error(
			`セッション ${session.id} を読めませんでした(${response.status})`,
			text.slice(0, 300),
		);
		return "error";
	}
	const snapshot = readSession(await response.json());
	if (!snapshot) {
		console.error(`セッション ${session.id} の応答の形が想定と違います`);
		return "error";
	}
	const model = snapshot.model ?? session.model;
	const { totals } = diffTotals(session.totals, snapshot.totals);
	const prices = model
		? await loadProviderPrices(target.env.DB, PROVIDERS.anthropic.id)
		: null;
	const price = prices && model ? findPrice(prices, model) : null;
	const events = sessionEvents(session, model, session.totals, totals, price, {
		method,
		createdAt: now,
	});
	const end: EndReason | null =
		snapshot.status === "terminated" ? "terminated" : null;
	const saved = await saveSessionUsage(target.env.DB, {
		session,
		totals,
		status: snapshot.status,
		polledAt: now,
		events,
		end,
	});
	if (end) {
		return end;
	}
	return saved && events.length > 0 ? "recorded" : "unchanged";
}

/** POST /v1/sessions の応答(成功したもの)から、セッションを記録する */
export async function recordCreatedSession(
	env: Env,
	responseText: string,
	context: {
		userId: string;
		sigwKeyId: string;
		providerKeyId: string;
		ownerId: string;
		anthropicBeta: string | null;
		via: "bobert" | null;
		now: number;
	},
): Promise<void> {
	let body: unknown;
	try {
		body = JSON.parse(responseText);
	} catch {
		return;
	}
	const snapshot = readSession(body);
	if (!snapshot?.id) {
		return;
	}
	await insertAgentSession(env.DB, {
		id: snapshot.id,
		userId: context.userId,
		sigwKeyId: context.sigwKeyId,
		providerKeyId: context.providerKeyId,
		ownerId: context.ownerId,
		model: snapshot.model,
		anthropicBeta: context.anthropicBeta,
		via: context.via,
		status: snapshot.status,
		createdAt: context.now,
	});
}

/**
 * DELETE /v1/sessions/{id} を中継する前に、最後の分を読んで記録する。
 * 記録していないセッションなら何もしない。削除を遅らせすぎないよう、待つのは DELETE_WAIT_MS まで
 * (それを過ぎたら削除を中継し、読み終わるのは ctx.waitUntil に任せる)。
 */
export async function finalizeBeforeDelete(
	target: PollTarget,
	ctx: ExecutionContext,
	sessionId: string,
	now = Date.now(),
): Promise<void> {
	const work = (async () => {
		const session = await getAgentSession(target.env.DB, sessionId);
		if (!session || session.endedAt !== null) {
			return;
		}
		await pollSession(
			target,
			session,
			"DELETE",
			now,
			AbortSignal.timeout(10_000),
		);
	})().catch((error) => {
		console.error(
			`削除する前に、セッション ${sessionId} の使用量を記録できませんでした`,
			error,
		);
	});
	ctx.waitUntil(work);
	let timer: ReturnType<typeof setTimeout> | null = null;
	await Promise.race([
		work,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, DELETE_WAIT_MS);
		}),
	]);
	clearTimeout(timer);
}

/** DELETE /v1/sessions/{id} を中継したあと。削除できた(か、もうなかった)なら、読むのをやめる */
export async function afterSessionDelete(
	env: Env,
	sessionId: string,
	status: number,
	now = Date.now(),
): Promise<void> {
	if ((status >= 200 && status < 300) || status === 404) {
		await endAgentSession(env.DB, sessionId, "deleted", now);
	}
}

/** Cron(5分ごと): 動いているセッションを読み、増えた分を記録する */
export async function pollAgentSessions(
	env: Env,
	origin: string,
	now = Date.now(),
): Promise<Record<PollResult, number>> {
	const counts: Record<PollResult, number> = {
		recorded: 0,
		unchanged: 0,
		terminated: 0,
		deleted: 0,
		not_found: 0,
		error: 0,
	};
	const sessions = await listDueAgentSessions(env.DB, now, POLL_LIMIT);
	if (sessions.length === 0) {
		return counts;
	}
	const apiKeys = await loadApiKeys(env, [
		...new Set(sessions.map((session) => session.providerKeyId)),
	]);
	const queue = [...sessions];
	const worker = async () => {
		for (;;) {
			const session = queue.shift();
			if (!session) {
				return;
			}
			const apiKey = apiKeys.get(session.providerKeyId);
			if (!apiKey) {
				counts.error += 1;
				continue;
			}
			try {
				const result = await pollSession(
					{ env, origin, apiKey },
					session,
					"GET",
					now,
					AbortSignal.timeout(15_000),
				);
				counts[result] += 1;
			} catch (error) {
				counts.error += 1;
				console.error(`セッション ${session.id} を読めませんでした`, error);
			}
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(POLL_CONCURRENCY, sessions.length) }, worker),
	);
	return counts;
}

/** プロバイダキーを復号して返す。無効にしたキーも使う(セッションの料金は、無効にしたあとも発生するため) */
async function loadApiKeys(
	env: Env,
	ids: string[],
): Promise<Map<string, string>> {
	const keys = new Map<string, string>();
	const { results } = await env.DB.prepare(
		`SELECT id, encrypted_key FROM provider_keys WHERE id IN (${ids.map(() => "?").join(", ")})`,
	)
		.bind(...ids)
		.all<{ id: string; encrypted_key: string }>();
	for (const row of results) {
		try {
			keys.set(
				row.id,
				await decryptText(env.KEY_ENCRYPTION_SECRET, row.encrypted_key),
			);
		} catch (error) {
			console.error(`プロバイダキー ${row.id} を復号できませんでした`, error);
		}
	}
	return keys;
}
