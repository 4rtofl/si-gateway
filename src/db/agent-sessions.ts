/*
 * Managed Agents のセッション(D1 の agent_sessions)の読み書き。docs/design.md「5.3 Managed Agents のセッション」
 */

import { newId } from "../lib/crypto.ts";
import { type UsageEventInput, usageEventStatement } from "./usage.ts";

/** セッションの usage の累計。トークン数は Usage と同じ分け方 */
export interface SessionTotals {
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cacheWrite1hTokens: number;
	outputTokens: number;
	activeSeconds: number;
}

export interface AgentSession {
	id: string;
	userId: string;
	sigwKeyId: string;
	providerKeyId: string;
	ownerId: string;
	model: string | null;
	anthropicBeta: string | null;
	/** セッションを作ったリクエストの入口。代理の呼び出し(BobertGateway)なら 'bobert'、公開の入口なら null */
	via: "bobert" | null;
	createdAt: number;
	totals: SessionTotals;
	revision: string | null;
	status: string | null;
	lastPolledAt: number | null;
	touchedAt: number | null;
	endedAt: number | null;
}

export type EndReason = "terminated" | "deleted" | "not_found";

export function zeroTotals(): SessionTotals {
	return {
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cacheWrite1hTokens: 0,
		outputTokens: 0,
		activeSeconds: 0,
	};
}

/** idle のセッションでも、最後のリクエストからこの時間は、Cron のたびに読む */
export const TOUCH_GRACE_MS = 15 * 60_000;
/** idle のセッションも、この時間に1回は読む(sigw を通さずに動かされたときのため) */
export const IDLE_POLL_MS = 6 * 60 * 60_000;

interface Row {
	id: string;
	user_id: string;
	sigw_key_id: string;
	provider_key_id: string;
	owner_id: string;
	model: string | null;
	anthropic_beta: string | null;
	via: string | null;
	created_at: number;
	input_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	cache_write_1h_tokens: number;
	output_tokens: number;
	active_seconds: number;
	revision: string | null;
	status: string | null;
	last_polled_at: number | null;
	touched_at: number | null;
	ended_at: number | null;
}

function fromRow(row: Row): AgentSession {
	return {
		id: row.id,
		userId: row.user_id,
		sigwKeyId: row.sigw_key_id,
		providerKeyId: row.provider_key_id,
		ownerId: row.owner_id,
		model: row.model,
		anthropicBeta: row.anthropic_beta,
		via: row.via === "bobert" ? "bobert" : null,
		createdAt: row.created_at,
		totals: {
			inputTokens: row.input_tokens,
			cacheReadTokens: row.cache_read_tokens,
			cacheWriteTokens: row.cache_write_tokens,
			cacheWrite1hTokens: row.cache_write_1h_tokens,
			outputTokens: row.output_tokens,
			activeSeconds: row.active_seconds,
		},
		revision: row.revision,
		status: row.status,
		lastPolledAt: row.last_polled_at,
		touchedAt: row.touched_at,
		endedAt: row.ended_at,
	};
}

export interface NewAgentSession {
	id: string;
	userId: string;
	sigwKeyId: string;
	providerKeyId: string;
	ownerId: string;
	model: string | null;
	anthropicBeta: string | null;
	via: "bobert" | null;
	status: string | null;
	createdAt: number;
}

/** POST /v1/sessions を中継したときに、累計を0にして記録する。同じ ID がすでにあれば何もしない */
export async function insertAgentSession(
	db: D1Database,
	session: NewAgentSession,
): Promise<void> {
	await db
		.prepare(
			`INSERT OR IGNORE INTO agent_sessions (id, user_id, sigw_key_id, provider_key_id, owner_id, model, anthropic_beta, via, status, created_at, touched_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			session.id,
			session.userId,
			session.sigwKeyId,
			session.providerKeyId,
			session.ownerId,
			session.model,
			session.anthropicBeta,
			session.via,
			session.status,
			session.createdAt,
			session.createdAt,
		)
		.run();
}

export async function getAgentSession(
	db: D1Database,
	id: string,
): Promise<AgentSession | null> {
	const row = await db
		.prepare("SELECT * FROM agent_sessions WHERE id = ?")
		.bind(id)
		.first<Row>();
	return row ? fromRow(row) : null;
}

/** セッションへのリクエストを中継したことを残す(idle のセッションが動き出すのを、Cron で見逃さないため) */
export async function touchAgentSession(
	db: D1Database,
	id: string,
	now: number,
): Promise<void> {
	await db
		.prepare(
			"UPDATE agent_sessions SET touched_at = ? WHERE id = ? AND ended_at IS NULL",
		)
		.bind(now, id)
		.run();
}

/**
 * Cron で読むセッション。次のどれかに当たるものを、前回読んだのが古い順に返す。
 * - まだ一度も読んでいない、または idle 以外(running、rescheduling)
 * - 最後のリクエストから TOUCH_GRACE_MS 以内
 * - 前回読んでから IDLE_POLL_MS 以上たった
 */
export async function listDueAgentSessions(
	db: D1Database,
	now: number,
	limit: number,
): Promise<AgentSession[]> {
	const { results } = await db
		.prepare(
			`SELECT * FROM agent_sessions
			 WHERE ended_at IS NULL AND (
				last_polled_at IS NULL OR status IS NULL OR status != 'idle'
				OR touched_at >= last_polled_at - ?
				OR last_polled_at <= ?
			 )
			 ORDER BY COALESCE(last_polled_at, 0) LIMIT ?`,
		)
		.bind(TOUCH_GRACE_MS, now - IDLE_POLL_MS, limit)
		.all<Row>();
	return results.map(fromRow);
}

export interface SessionUpdate {
	session: AgentSession;
	/** 読んだ累計(前回より減った項目は、前回の値のままにしておく) */
	totals: SessionTotals;
	status: string | null;
	polledAt: number;
	/** 足す使用量の行(増えた分) */
	events: UsageEventInput[];
	end: EndReason | null;
}

/**
 * 読んだ累計を保存し、増えた分の行を usage_events に足す。1つのトランザクション(D1 の batch)で行う。
 * 前回読んだときから revision が変わっていたら(ほかで先に記録していたら)、累計も行も書かない。
 * 行は「revision を新しい値に書き換えられたとき」だけ足すので、二重に記録しない。書いたら true を返す。
 */
export async function saveSessionUsage(
	db: D1Database,
	update: SessionUpdate,
): Promise<boolean> {
	const { session, totals } = update;
	const revision = newId();
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`UPDATE agent_sessions SET input_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cache_write_1h_tokens = ?,
					output_tokens = ?, active_seconds = ?, revision = ?, status = ?, last_polled_at = ?,
					ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, ?)
				 WHERE id = ? AND revision IS ?`,
			)
			.bind(
				totals.inputTokens,
				totals.cacheReadTokens,
				totals.cacheWriteTokens,
				totals.cacheWrite1hTokens,
				totals.outputTokens,
				totals.activeSeconds,
				revision,
				update.status,
				update.polledAt,
				update.end ? update.polledAt : null,
				update.end,
				session.id,
				session.revision,
			),
	];
	for (const event of update.events) {
		statements.push(
			usageEventStatement(db, event, {
				sql: "EXISTS (SELECT 1 FROM agent_sessions WHERE id = ? AND revision = ?)",
				params: [session.id, revision],
			}),
		);
	}
	const [result] = await db.batch(statements);
	return (result?.meta.changes ?? 0) > 0;
}

/** 読むのをやめる(削除した、見つからない) */
export async function endAgentSession(
	db: D1Database,
	id: string,
	reason: EndReason,
	now: number,
): Promise<void> {
	await db
		.prepare(
			"UPDATE agent_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL",
		)
		.bind(now, reason, id)
		.run();
}
