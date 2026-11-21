import { newToken, sha256Hex, TOKEN_PREFIX, tokenHint } from "../lib/crypto.ts";

export interface User {
	id: string;
	name: string;
	avatar: string | null;
	personalTokenHint: string | null;
}

interface UserRow {
	id: string;
	name: string;
	avatar: string | null;
	personal_token_hint: string | null;
}

function toUser(row: UserRow): User {
	return {
		id: row.id,
		name: row.name,
		avatar: row.avatar,
		personalTokenHint: row.personal_token_hint,
	};
}

export async function getUser(
	db: D1Database,
	id: string,
): Promise<User | null> {
	const row = await db
		.prepare(
			"SELECT id, name, avatar, personal_token_hint FROM users WHERE id = ?",
		)
		.bind(id)
		.first<UserRow>();
	return row ? toUser(row) : null;
}

export async function listUsers(db: D1Database): Promise<User[]> {
	const { results } = await db
		.prepare(
			"SELECT id, name, avatar, personal_token_hint FROM users ORDER BY created_at",
		)
		.all<UserRow>();
	return results.map(toUser);
}

/** ログインしたときに、ユーザーを作るか、表示名とアイコンを新しくする */
export async function upsertUser(
	db: D1Database,
	user: { id: string; name: string; avatar: string | null },
	now = Date.now(),
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO users (id, name, avatar, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
			 ON CONFLICT (id) DO UPDATE SET name = ?2, avatar = ?3, updated_at = ?4`,
		)
		.bind(user.id, user.name, user.avatar, now)
		.run();
}

/** 個人トークンを発行し直す。発行したトークン(平文)を返す。古いトークンは使えなくなる */
export async function rotatePersonalToken(
	db: D1Database,
	userId: string,
): Promise<string> {
	const token = newToken(TOKEN_PREFIX.personal);
	await db
		.prepare(
			"UPDATE users SET personal_token_hash = ?, personal_token_hint = ?, updated_at = ? WHERE id = ?",
		)
		.bind(await sha256Hex(token), tokenHint(token), Date.now(), userId)
		.run();
	return token;
}
