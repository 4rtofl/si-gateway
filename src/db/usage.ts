/*
 * 使用量(中継した呼び出し1回が1行)の記録と集計。
 */

import { newId } from "../lib/crypto.ts";
import { monthOf } from "../lib/time.ts";
import type { Usage } from "../proxy/usage.ts";

export interface UsageEventInput {
	createdAt: number;
	userId: string;
	sigwKeyId: string;
	providerKeyId: string;
	ownerId: string;
	provider: string;
	method: string;
	path: string;
	model: string | null;
	stream: boolean;
	status: number;
	usage: Usage;
	serviceTier: string | null;
	costNano: number | null;
	costSource: "provider" | "pricing" | "none" | null;
	incomplete: boolean;
	ttfbMs: number | null;
	durationMs: number;
	upstreamRequestId: string | null;
	error: string | null;
	/** 代理の呼び出し(BobertGateway)なら 'bobert'、公開の入口なら null */
	via: "bobert" | null;
}

export async function insertUsageEvent(
	db: D1Database,
	event: UsageEventInput,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO usage_events (id, month, created_at, user_id, sigw_key_id, provider_key_id, owner_id, provider, method, path,
				model, stream, status, input_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, output_tokens,
				service_tier, cost_nano_usd, cost_source, incomplete, ttfb_ms, duration_ms, upstream_request_id, error, via)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			newId(),
			monthOf(event.createdAt),
			event.createdAt,
			event.userId,
			event.sigwKeyId,
			event.providerKeyId,
			event.ownerId,
			event.provider,
			event.method,
			event.path.slice(0, 200),
			event.model,
			event.stream ? 1 : 0,
			event.status,
			event.usage.inputTokens,
			event.usage.cacheReadTokens,
			event.usage.cacheWriteTokens,
			event.usage.cacheWrite1hTokens,
			event.usage.outputTokens,
			event.serviceTier,
			event.costNano,
			event.costSource,
			event.incomplete ? 1 : 0,
			event.ttfbMs,
			event.durationMs,
			event.upstreamRequestId,
			event.error ? event.error.slice(0, 500) : null,
			event.via,
		)
		.run();
}

export type UsageGroup = "user" | "owner" | "user_owner" | "key" | "model";

export interface UsageSummaryRow {
	userId: string | null;
	ownerId: string | null;
	sigwKeyId: string | null;
	provider: string | null;
	model: string | null;
	requests: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	costNano: number;
	/** 料金が不明な呼び出しの数 */
	unpriced: number;
	errors: number;
}

const GROUP_COLUMNS: Record<UsageGroup, string[]> = {
	user: ["user_id"],
	owner: ["owner_id"],
	user_owner: ["user_id", "owner_id"],
	key: ["sigw_key_id"],
	model: ["provider", "model"],
};

/** 月の使用量を、group ごとに集計する */
export async function summarizeUsage(
	db: D1Database,
	month: string,
	group: UsageGroup,
): Promise<UsageSummaryRow[]> {
	const columns = GROUP_COLUMNS[group];
	const { results } = await db
		.prepare(
			`SELECT ${columns.join(", ")}, COUNT(*) AS requests,
				SUM(input_tokens) AS input_tokens, SUM(cache_read_tokens) AS cache_read_tokens,
				SUM(cache_write_tokens + cache_write_1h_tokens) AS cache_write_tokens, SUM(output_tokens) AS output_tokens,
				COALESCE(SUM(cost_nano_usd), 0) AS cost, SUM(cost_nano_usd IS NULL) AS unpriced, SUM(status >= 400) AS errors
			 FROM usage_events WHERE month = ? GROUP BY ${columns.join(", ")} ORDER BY cost DESC`,
		)
		.bind(month)
		.all<Record<string, string | number | null>>();
	return results.map((row) => ({
		userId: (row.user_id as string | undefined) ?? null,
		ownerId: (row.owner_id as string | undefined) ?? null,
		sigwKeyId: (row.sigw_key_id as string | undefined) ?? null,
		provider: (row.provider as string | undefined) ?? null,
		model: (row.model as string | undefined) ?? null,
		requests: Number(row.requests),
		inputTokens: Number(row.input_tokens),
		cacheReadTokens: Number(row.cache_read_tokens),
		cacheWriteTokens: Number(row.cache_write_tokens),
		outputTokens: Number(row.output_tokens),
		costNano: Number(row.cost),
		unpriced: Number(row.unpriced),
		errors: Number(row.errors),
	}));
}

export interface DailyCostRow {
	/** 日本時間の日(1〜31) */
	day: number;
	userId: string;
	ownerId: string;
	costNano: number;
}

/** 月の料金を、日本時間の日 × 利用者 × 所有者ごとに集計する */
export async function dailyCosts(
	db: D1Database,
	month: string,
): Promise<DailyCostRow[]> {
	const { results } = await db
		.prepare(
			`SELECT CAST(strftime('%d', created_at / 1000 + 32400, 'unixepoch') AS INTEGER) AS day, user_id, owner_id,
				COALESCE(SUM(cost_nano_usd), 0) AS cost
			 FROM usage_events WHERE month = ? GROUP BY day, user_id, owner_id ORDER BY day`,
		)
		.bind(month)
		.all<{ day: number; user_id: string; owner_id: string; cost: number }>();
	return results.map((row) => ({
		day: row.day,
		userId: row.user_id,
		ownerId: row.owner_id,
		costNano: row.cost,
	}));
}

export interface UsageEvent {
	id: string;
	createdAt: number;
	userId: string;
	sigwKeyId: string;
	ownerId: string;
	provider: string;
	method: string;
	path: string;
	model: string | null;
	stream: boolean;
	status: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	costNano: number | null;
	costSource: string | null;
	incomplete: boolean;
	ttfbMs: number | null;
	durationMs: number | null;
	error: string | null;
	/** 代理の呼び出しなら 'bobert'、公開の入口なら null */
	via: string | null;
}

export interface UsageEventFilter {
	month?: string;
	userId?: string;
	sigwKeyId?: string;
	limit?: number;
}

export async function listUsageEvents(
	db: D1Database,
	filter: UsageEventFilter,
): Promise<UsageEvent[]> {
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (filter.month) {
		where.push("month = ?");
		params.push(filter.month);
	}
	if (filter.userId) {
		where.push("user_id = ?");
		params.push(filter.userId);
	}
	if (filter.sigwKeyId) {
		where.push("sigw_key_id = ?");
		params.push(filter.sigwKeyId);
	}
	params.push(Math.min(Math.max(filter.limit ?? 50, 1), 500));
	const { results } = await db
		.prepare(
			`SELECT * FROM usage_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
		)
		.bind(...params)
		.all<Record<string, string | number | null>>();
	return results.map((row) => ({
		id: String(row.id),
		createdAt: Number(row.created_at),
		userId: String(row.user_id),
		sigwKeyId: String(row.sigw_key_id),
		ownerId: String(row.owner_id),
		provider: String(row.provider),
		method: String(row.method),
		path: String(row.path),
		model: row.model === null ? null : String(row.model),
		stream: row.stream === 1,
		status: Number(row.status),
		inputTokens: Number(row.input_tokens),
		cacheReadTokens: Number(row.cache_read_tokens),
		cacheWriteTokens:
			Number(row.cache_write_tokens) + Number(row.cache_write_1h_tokens),
		outputTokens: Number(row.output_tokens),
		costNano: row.cost_nano_usd === null ? null : Number(row.cost_nano_usd),
		costSource: row.cost_source === null ? null : String(row.cost_source),
		incomplete: row.incomplete === 1,
		ttfbMs: row.ttfb_ms === null ? null : Number(row.ttfb_ms),
		durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
		error: row.error === null ? null : String(row.error),
		via: row.via == null ? null : String(row.via),
	}));
}

/** sigw キーの、その月の使用額(nano USD) */
export async function monthSpendForKey(
	db: D1Database | D1DatabaseSession,
	sigwKeyId: string,
	month: string,
): Promise<number> {
	const row = await db
		.prepare(
			"SELECT COALESCE(SUM(cost_nano_usd), 0) AS cost FROM usage_events WHERE sigw_key_id = ? AND month = ?",
		)
		.bind(sigwKeyId, month)
		.first<{ cost: number }>();
	return row?.cost ?? 0;
}
