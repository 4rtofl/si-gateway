/*
 * 中継のときの認証。sigw キーと個人トークンから、使うプロバイダキーと利用者を決める。
 * Bobert からの代理の呼び出し(BobertGateway)では、個人トークンの代わりに x-sigw-user の Discord ID で利用者を決める。
 *
 * ストリーミングを速くするため、D1 から読んだ結果を isolate のメモリに置く(stale-while-revalidate)。
 * - 読んでから30秒までは、そのまま使う
 * - 30秒を過ぎたら、手元の値で応答しつつ、裏で読み直す(ctx.waitUntil)
 * - 10分を過ぎた値は使わず、読み直すのを待つ
 * そのため、sigw キーの無効化などは、遅くとも「30秒後の次の呼び出しの、さらに次」から効く。
 */

import { parseModels } from "../db/keys.ts";
import { decryptText, sha256Hex } from "../lib/crypto.ts";
import { monthOf } from "../lib/time.ts";
import type { ProviderId } from "./providers.ts";

export const FRESH_MS = 30_000;
export const MAX_STALE_MS = 10 * 60_000;
/** 見つからなかった結果を覚えておく時間。発行したばかりのキーがすぐ使えるよう短くする */
const NEGATIVE_MS = 5_000;

/** 代理の呼び出しで、利用者の Discord ID を受け取るヘッダー。プロバイダには転送しない */
export const DELEGATED_USER_HEADER = "x-sigw-user";

/**
 * 呼び出しの資格情報。公開の入口では個人トークンで、BobertGateway では Discord ID で利用者を決める
 */
export type Credential =
	| { sigwToken: string; personalToken: string }
	| { sigwToken: string; discordId: string };

/** Authorization: Bearer か x-api-key の値を、「.」で区切った部分に分ける */
function credentialParts(headers: Headers): string[] {
	const authorization = headers.get("authorization");
	const raw =
		authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? headers.get("x-api-key");
	return raw ? raw.trim().split(".") : [];
}

/** ヘッダーから「sgk_….sgu_…」を取り出す。Authorization: Bearer と x-api-key の両方を見る */
export function parseCredential(
	headers: Headers,
): { sigwToken: string; personalToken: string } | null {
	let sigwToken: string | null = null;
	let personalToken: string | null = null;
	for (const part of credentialParts(headers)) {
		if (part.startsWith("sgk_")) sigwToken = part;
		else if (part.startsWith("sgu_")) personalToken = part;
	}
	return sigwToken && personalToken ? { sigwToken, personalToken } : null;
}

/**
 * 代理の呼び出し(BobertGateway)のヘッダーから、sigw キーを取り出す。
 * 個人トークンは使わないので、sgk_… のほかの部分は見ない
 */
export function parseDelegatedSigwToken(headers: Headers): string | null {
	return (
		credentialParts(headers).find((part) => part.startsWith("sgk_")) ?? null
	);
}

/** x-sigw-user から Discord ID を取り出す。Discord の ID(数字だけ)の形でなければ null */
export function parseDelegatedUser(headers: Headers): string | null {
	const value = headers.get(DELEGATED_USER_HEADER)?.trim();
	return value && /^\d{1,32}$/.test(value) ? value : null;
}

export interface KeyInfo {
	sigwKeyId: string;
	purpose: string;
	providerKeyId: string;
	provider: ProviderId;
	ownerId: string;
	/** 復号したプロバイダキー */
	apiKey: string;
	allowedModels: string[] | null;
	monthlyLimitNano: number | null;
	expiresAt: number | null;
	/** sigw キーかプロバイダキーが無効になっている */
	disabled: boolean;
	/** プロバイダキーが代理専用。公開の入口では使えず、BobertGateway からだけ使える */
	delegatedOnly: boolean;
}

interface Entry<T> {
	value: T;
	fetchedAt: number;
	refreshing: boolean;
}

const keyCache = new Map<string, Entry<KeyInfo | null>>();
const userCache = new Map<string, Entry<string | null>>();
const spendCache = new Map<string, Entry<number>>();

export function clearAuthCache(): void {
	keyCache.clear();
	userCache.clear();
	spendCache.clear();
}

function usable<T>(
	entry: Entry<T> | undefined,
	now: number,
): entry is Entry<T> {
	if (!entry) {
		return false;
	}
	const limit = entry.value === null ? NEGATIVE_MS : MAX_STALE_MS;
	return now - entry.fetchedAt < limit;
}

function stale<T>(entry: Entry<T>, now: number): boolean {
	return now - entry.fetchedAt >= FRESH_MS && !entry.refreshing;
}

export interface Resolved {
	key: KeyInfo | null;
	userId: string | null;
	/** sigw キーの今月の使用額(nano USD) */
	monthSpendNano: number;
	month: string;
}

interface LoadResult {
	key: KeyInfo | null;
	userId: string | null;
	spend: number;
}

interface KeyRow {
	id: string;
	purpose: string;
	provider_key_id: string;
	allowed_models: string | null;
	monthly_limit_nano_usd: number | null;
	expires_at: number | null;
	revoked_at: number | null;
	provider: ProviderId;
	owner_id: string;
	encrypted_key: string;
	disabled_at: number | null;
	delegated_only: number;
}

/** 利用者の引き方。個人トークンのハッシュか、Discord ID か */
type UserLookup = { hash: string } | { id: string };

function userCacheKey(lookup: UserLookup): string {
	return "hash" in lookup ? `hash:${lookup.hash}` : `id:${lookup.id}`;
}

/** D1 から、sigw キー・利用者・今月の使用額を1回の往復で読む */
async function load(
	env: Env,
	sigwHash: string,
	lookup: UserLookup,
	month: string,
): Promise<LoadResult> {
	// 読み取りだけなので、最寄りのレプリカから読んでよい
	const db = env.DB.withSession("first-unconstrained");
	const [keyResult, userResult, spendResult] = await db.batch([
		db
			.prepare(
				`SELECT s.id, s.purpose, s.provider_key_id, s.allowed_models, s.monthly_limit_nano_usd, s.expires_at, s.revoked_at,
					p.provider, p.owner_id, p.encrypted_key, p.disabled_at, p.delegated_only
				 FROM sigw_keys s JOIN provider_keys p ON p.id = s.provider_key_id WHERE s.token_hash = ?`,
			)
			.bind(sigwHash),
		"hash" in lookup
			? db
					.prepare("SELECT id FROM users WHERE personal_token_hash = ?")
					.bind(lookup.hash)
			: db.prepare("SELECT id FROM users WHERE id = ?").bind(lookup.id),
		db
			.prepare(
				`SELECT COALESCE(SUM(cost_nano_usd), 0) AS cost FROM usage_events
				 WHERE sigw_key_id = (SELECT id FROM sigw_keys WHERE token_hash = ?) AND month = ?`,
			)
			.bind(sigwHash, month),
	]);
	const row = (keyResult?.results[0] as KeyRow | undefined) ?? null;
	const user = (userResult?.results[0] as { id: string } | undefined) ?? null;
	const spend =
		(spendResult?.results[0] as { cost: number } | undefined)?.cost ?? 0;
	let key: KeyInfo | null = null;
	if (row) {
		key = {
			sigwKeyId: row.id,
			purpose: row.purpose,
			providerKeyId: row.provider_key_id,
			provider: row.provider,
			ownerId: row.owner_id,
			apiKey: await decryptText(env.KEY_ENCRYPTION_SECRET, row.encrypted_key),
			allowedModels: parseModels(row.allowed_models),
			monthlyLimitNano: row.monthly_limit_nano_usd,
			expiresAt: row.expires_at,
			disabled: row.revoked_at !== null || row.disabled_at !== null,
			delegatedOnly: row.delegated_only === 1,
		};
	}
	return { key, userId: user?.id ?? null, spend };
}

function store(
	sigwHash: string,
	userKey: string,
	month: string,
	result: LoadResult,
	now: number,
): void {
	keyCache.set(sigwHash, {
		value: result.key,
		fetchedAt: now,
		refreshing: false,
	});
	userCache.set(userKey, {
		value: result.userId,
		fetchedAt: now,
		refreshing: false,
	});
	if (result.key) {
		spendCache.set(`${result.key.sigwKeyId}:${month}`, {
			value: result.spend,
			fetchedAt: now,
			refreshing: false,
		});
	}
}

/** 資格情報から、キーと利用者と今月の使用額を引く */
export async function resolveCredential(
	env: Env,
	ctx: ExecutionContext,
	credential: Credential,
	now = Date.now(),
): Promise<Resolved> {
	const [sigwHash, user] = await Promise.all([
		sha256Hex(credential.sigwToken),
		"personalToken" in credential
			? sha256Hex(credential.personalToken).then(
					(hash): UserLookup => ({ hash }),
				)
			: Promise.resolve<UserLookup>({ id: credential.discordId }),
	]);
	const userKey = userCacheKey(user);
	const month = monthOf(now);
	const keyEntry = keyCache.get(sigwHash);
	const userEntry = userCache.get(userKey);
	const spendEntry = keyEntry?.value
		? spendCache.get(`${keyEntry.value.sigwKeyId}:${month}`)
		: undefined;

	if (
		usable(keyEntry, now) &&
		usable(userEntry, now) &&
		(keyEntry.value === null || usable(spendEntry, now))
	) {
		if (
			stale(keyEntry, now) ||
			stale(userEntry, now) ||
			(spendEntry && stale(spendEntry, now))
		) {
			keyEntry.refreshing = true;
			userEntry.refreshing = true;
			if (spendEntry) spendEntry.refreshing = true;
			ctx.waitUntil(
				load(env, sigwHash, user, month)
					.then((result) => store(sigwHash, userKey, month, result, Date.now()))
					.catch((error) => {
						keyEntry.refreshing = false;
						userEntry.refreshing = false;
						if (spendEntry) spendEntry.refreshing = false;
						console.error("認証の情報を読み直せませんでした", error);
					}),
			);
		}
		return {
			key: keyEntry.value,
			userId: userEntry.value,
			monthSpendNano: spendEntry?.value ?? 0,
			month,
		};
	}

	const result = await load(env, sigwHash, user, month);
	store(sigwHash, userKey, month, result, now);
	return {
		key: result.key,
		userId: result.userId,
		monthSpendNano: result.spend,
		month,
	};
}

/** 呼び出しの料金を、手元の今月の使用額に足す(上限額の判定を、次に読み直すまでのあいだも正しくするため) */
export function addSpend(
	sigwKeyId: string,
	month: string,
	costNano: number,
): void {
	const entry = spendCache.get(`${sigwKeyId}:${month}`);
	if (entry) {
		entry.value += costNano;
	}
}
