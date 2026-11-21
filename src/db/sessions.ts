/*
 * Web UI のセッションと CLI トークン。どちらも、トークンのハッシュだけを保存する。
 */

import { newId, newToken, sha256Hex, TOKEN_PREFIX } from "../lib/crypto.ts";
import { notFound } from "../lib/errors.ts";
import type { User } from "./users.ts";

export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionKind = "web" | "cli";

export async function createSession(
	db: D1Database,
	userId: string,
	kind: SessionKind,
	label: string | null = null,
	now = Date.now(),
): Promise<string> {
	const token = newToken(
		kind === "web" ? TOKEN_PREFIX.session : TOKEN_PREFIX.cli,
	);
	await db
		.prepare(
			"INSERT INTO sessions (id, token_hash, user_id, kind, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			newId(),
			await sha256Hex(token),
			userId,
			kind,
			label,
			now,
			kind === "web" ? now + WEB_SESSION_TTL_MS : null,
		)
		.run();
	return token;
}

/** トークンからユーザーを探す。期限切れや、種類が違うときは null */
export async function findSessionUser(
	db: D1Database,
	token: string,
	kind: SessionKind,
	now = Date.now(),
): Promise<User | null> {
	const row = await db
		.prepare(
			`SELECT s.id AS session_id, s.last_used_at, u.id, u.name, u.avatar, u.personal_token_hint
			 FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.token_hash = ? AND s.kind = ? AND (s.expires_at IS NULL OR s.expires_at > ?)`,
		)
		.bind(await sha256Hex(token), kind, now)
		.first<{
			session_id: string;
			last_used_at: number | null;
			id: string;
			name: string;
			avatar: string | null;
			personal_token_hint: string | null;
		}>();
	if (!row) {
		return null;
	}
	// 最後に使った時刻は、1時間に1回だけ書く
	if (row.last_used_at === null || now - row.last_used_at > 60 * 60 * 1000) {
		await db
			.prepare("UPDATE sessions SET last_used_at = ? WHERE id = ?")
			.bind(now, row.session_id)
			.run();
	}
	return {
		id: row.id,
		name: row.name,
		avatar: row.avatar,
		personalTokenHint: row.personal_token_hint,
	};
}

export async function deleteSessionByToken(
	db: D1Database,
	token: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM sessions WHERE token_hash = ?")
		.bind(await sha256Hex(token))
		.run();
}

export interface CliToken {
	id: string;
	label: string | null;
	createdAt: number;
	lastUsedAt: number | null;
}

export async function listCliTokens(
	db: D1Database,
	userId: string,
): Promise<CliToken[]> {
	const { results } = await db
		.prepare(
			"SELECT id, label, created_at, last_used_at FROM sessions WHERE user_id = ? AND kind = 'cli' ORDER BY created_at DESC",
		)
		.bind(userId)
		.all<{
			id: string;
			label: string | null;
			created_at: number;
			last_used_at: number | null;
		}>();
	return results.map((row) => ({
		id: row.id,
		label: row.label,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
	}));
}

export async function deleteCliToken(
	db: D1Database,
	userId: string,
	id: string,
): Promise<void> {
	const result = await db
		.prepare(
			"DELETE FROM sessions WHERE id = ? AND user_id = ? AND kind = 'cli'",
		)
		.bind(id, userId)
		.run();
	if (result.meta.changes === 0) {
		throw notFound("CLI トークンが見つかりません");
	}
}

/** 期限の切れたセッションを消す(Cron から呼ぶ) */
export async function purgeExpiredSessions(
	db: D1Database,
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			"DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ?",
		)
		.bind(now)
		.run();
}
