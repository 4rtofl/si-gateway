/*
 * CLI のブラウザでのログイン(sigw auth login)。OAuth 2.0 のデバイス認可(RFC 8628)と同じ流れ。
 * 1. CLI が始める(startCliLogin)。CLI は device code を持ち、ブラウザで確認用のコードの画面を開く
 * 2. Web UI にログインした本人が、コードを確かめて許可する(decideCliLogin)
 * 3. CLI が device code で問い合わせ(pollCliLogin)、許可されていれば CLI トークンを受け取る
 */

import { newId, newToken, sha256Hex } from "../lib/crypto.ts";
import { AppError, notFound } from "../lib/errors.ts";
import { createSession } from "./sessions.ts";

export const CLI_LOGIN_TTL_MS = 10 * 60 * 1000;
/** 期限内のログインがこれ以上あるときは、新しく始めさせない(誰でも呼べる API なので) */
const MAX_PENDING = 20;
/** 読み違えやすい文字と母音(単語になるのを避ける)を除いた文字 */
const USER_CODE_CHARS = "BCDFGHJKLMNPQRSTVWXZ";

export type CliLoginStatus = "pending" | "approved" | "denied";

export interface CliLogin {
	userCode: string;
	clientName: string;
	status: CliLoginStatus;
	expiresAt: number;
}

function newUserCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	const chars = [...bytes].map(
		// 256 は 20 で割り切れないが、確認用のコードなので偏りは問題にならない
		(byte) => USER_CODE_CHARS[byte % USER_CODE_CHARS.length],
	);
	return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** 入力の揺れ(小文字、ハイフンなし)を吸収する */
export function normalizeUserCode(input: string): string {
	const letters = input.toUpperCase().replace(/[^A-Z]/g, "");
	return letters.length === 8
		? `${letters.slice(0, 4)}-${letters.slice(4)}`
		: letters;
}

export async function startCliLogin(
	db: D1Database,
	clientName: string,
	now = Date.now(),
): Promise<{ deviceCode: string; userCode: string; expiresAt: number }> {
	await db
		.prepare("DELETE FROM cli_logins WHERE expires_at <= ?")
		.bind(now)
		.run();
	const pending = await db
		.prepare("SELECT COUNT(*) AS n FROM cli_logins")
		.first<{ n: number }>();
	if ((pending?.n ?? 0) >= MAX_PENDING) {
		throw new AppError(
			429,
			"ログインの手続きが多すぎます。しばらくしてから試してください",
		);
	}
	const deviceCode = newToken("sgd_");
	const userCode = newUserCode();
	const expiresAt = now + CLI_LOGIN_TTL_MS;
	await db
		.prepare(
			"INSERT INTO cli_logins (id, device_code_hash, user_code, client_name, status, created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
		)
		.bind(
			newId(),
			await sha256Hex(deviceCode),
			userCode,
			clientName.slice(0, 100) || "CLI",
			now,
			expiresAt,
		)
		.run();
	return { deviceCode, userCode, expiresAt };
}

/** 画面に出すための情報。期限切れや、ないときは null */
export async function getCliLogin(
	db: D1Database,
	userCode: string,
	now = Date.now(),
): Promise<CliLogin | null> {
	const row = await db
		.prepare(
			"SELECT user_code, client_name, status, expires_at FROM cli_logins WHERE user_code = ? AND expires_at > ?",
		)
		.bind(normalizeUserCode(userCode), now)
		.first<{
			user_code: string;
			client_name: string;
			status: CliLoginStatus;
			expires_at: number;
		}>();
	return row
		? {
				userCode: row.user_code,
				clientName: row.client_name,
				status: row.status,
				expiresAt: row.expires_at,
			}
		: null;
}

/** 本人が許可・拒否する。決められるのは、まだ決めていないものだけ */
export async function decideCliLogin(
	db: D1Database,
	userCode: string,
	userId: string,
	approve: boolean,
	now = Date.now(),
): Promise<void> {
	const result = await db
		.prepare(
			"UPDATE cli_logins SET status = ?, user_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?",
		)
		.bind(
			approve ? "approved" : "denied",
			userId,
			normalizeUserCode(userCode),
			now,
		)
		.run();
	if (result.meta.changes === 0) {
		throw notFound(
			"このコードは期限が切れたか、もう使われています。ターミナルでやり直してください",
		);
	}
}

export type CliLoginPoll =
	| { status: "pending" }
	| { status: "denied" }
	| { status: "expired" }
	| { status: "approved"; token: string; userId: string };

/**
 * CLI からの問い合わせ。許可されていれば、行を消して CLI トークンを発行する。
 * 消すのと読むのを1つの文(DELETE … RETURNING)でするので、トークンは1回しか渡さない
 */
export async function pollCliLogin(
	db: D1Database,
	deviceCode: string,
	now = Date.now(),
): Promise<CliLoginPoll> {
	const hash = await sha256Hex(deviceCode);
	const taken = await db
		.prepare(
			"DELETE FROM cli_logins WHERE device_code_hash = ? AND status = 'approved' AND expires_at > ? RETURNING user_id, client_name",
		)
		.bind(hash, now)
		.first<{ user_id: string; client_name: string }>();
	if (taken) {
		const token = await createSession(
			db,
			taken.user_id,
			"cli",
			taken.client_name,
			now,
		);
		return { status: "approved", token, userId: taken.user_id };
	}
	const row = await db
		.prepare(
			"SELECT status FROM cli_logins WHERE device_code_hash = ? AND expires_at > ?",
		)
		.bind(hash, now)
		.first<{ status: CliLoginStatus }>();
	if (!row) {
		return { status: "expired" };
	}
	if (row.status === "denied") {
		await db
			.prepare("DELETE FROM cli_logins WHERE device_code_hash = ?")
			.bind(hash)
			.run();
		return { status: "denied" };
	}
	return { status: "pending" };
}
