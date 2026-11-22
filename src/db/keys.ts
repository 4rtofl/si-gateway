/*
 * プロバイダキーと sigw キー。
 * - プロバイダキーは、所有者だけが無効にできる。キーそのものは暗号化して保存し、画面には末尾4文字だけ出す
 * - 代理専用のプロバイダキーは、登録するときに決める。あとから公開の入口で使えるようにはしない
 * - sigw キーは誰でも発行できる。プロバイダごとに1つずつ、プロバイダキーを結び付ける(sigw_key_providers)
 * - sigw キーの変更と無効化は、発行した人と、結び付いたプロバイダキーの所有者ができる
 * - 削除は、無効化と同じ人ができる。秘密の値(暗号化したキー、トークンのハッシュ)だけを消し、行は残す。
 *   過去の使用量に名前を出すため。削除したキーは、一覧にも出さない(docs/design.md 3.3)
 */

import {
	encryptText,
	newId,
	newToken,
	sha256Hex,
	TOKEN_PREFIX,
	tokenHint,
} from "../lib/crypto.ts";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.ts";
import {
	isProviderId,
	PROVIDER_IDS,
	PROVIDERS,
	type ProviderId,
} from "../proxy/providers.ts";

export interface ProviderKey {
	id: string;
	ownerId: string;
	ownerName: string;
	provider: ProviderId;
	label: string;
	keyHint: string;
	createdAt: number;
	disabledAt: number | null;
	/** 結び付いた、有効な sigw キーの数 */
	activeSigwKeys: number;
	/** 代理専用。このプロバイダキーを使う呼び出しは、BobertGateway からしか使えない */
	delegatedOnly: boolean;
}

export async function listProviderKeys(db: D1Database): Promise<ProviderKey[]> {
	const { results } = await db
		.prepare(
			`SELECT p.id, p.owner_id, u.name AS owner_name, p.provider, p.label, p.key_hint, p.created_at, p.disabled_at, p.delegated_only,
				(SELECT COUNT(*) FROM sigw_key_providers l JOIN sigw_keys s ON s.id = l.sigw_key_id
					WHERE l.provider_key_id = p.id AND s.revoked_at IS NULL) AS active_sigw_keys
			 FROM provider_keys p JOIN users u ON u.id = p.owner_id
			 WHERE p.deleted_at IS NULL
			 ORDER BY p.disabled_at IS NOT NULL, p.created_at`,
		)
		.all<{
			id: string;
			owner_id: string;
			owner_name: string;
			provider: ProviderId;
			label: string;
			key_hint: string;
			created_at: number;
			disabled_at: number | null;
			delegated_only: number;
			active_sigw_keys: number;
		}>();
	return results.map((row) => ({
		id: row.id,
		ownerId: row.owner_id,
		ownerName: row.owner_name,
		provider: row.provider,
		label: row.label,
		keyHint: row.key_hint,
		createdAt: row.created_at,
		disabledAt: row.disabled_at,
		activeSigwKeys: row.active_sigw_keys,
		delegatedOnly: row.delegated_only === 1,
	}));
}

export interface NewProviderKey {
	ownerId: string;
	provider: string;
	label: string;
	apiKey: string;
	/** 代理専用にする(BobertGateway からだけ使える)。登録したあとは変えられない */
	delegatedOnly?: boolean;
}

export async function createProviderKey(
	db: D1Database,
	encryptionSecret: string,
	input: NewProviderKey,
): Promise<string> {
	if (!isProviderId(input.provider)) {
		throw badRequest(`プロバイダ ${input.provider} には対応していません`);
	}
	const apiKey = input.apiKey.trim();
	if (apiKey.length < 8 || /\s/.test(apiKey)) {
		throw badRequest("API キーの形が正しくありません");
	}
	const label = input.label.trim() || "メイン";
	if (label.length > 60) {
		throw badRequest("名前は60文字までにしてください");
	}
	const id = newId();
	await db
		.prepare(
			"INSERT INTO provider_keys (id, owner_id, provider, label, encrypted_key, key_hint, created_at, delegated_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			id,
			input.ownerId,
			input.provider,
			label,
			await encryptText(encryptionSecret, apiKey),
			`…${apiKey.slice(-4)}`,
			Date.now(),
			input.delegatedOnly ? 1 : 0,
		)
		.run();
	return id;
}

/** 削除していないプロバイダキーの所有者かを確かめる */
async function requireProviderKeyOwner(
	db: D1Database,
	id: string,
	actorId: string,
): Promise<void> {
	const row = await db
		.prepare(
			"SELECT owner_id FROM provider_keys WHERE id = ? AND deleted_at IS NULL",
		)
		.bind(id)
		.first<{ owner_id: string }>();
	if (!row) {
		throw notFound("プロバイダキーが見つかりません");
	}
	if (row.owner_id !== actorId) {
		throw forbidden("プロバイダキーを変えられるのは、登録した人だけです");
	}
}

/** プロバイダキーを無効にする(enabled = false)か、有効に戻す。所有者だけができる */
export async function setProviderKeyEnabled(
	db: D1Database,
	id: string,
	actorId: string,
	enabled: boolean,
): Promise<void> {
	await requireProviderKeyOwner(db, id, actorId);
	await db
		.prepare("UPDATE provider_keys SET disabled_at = ? WHERE id = ?")
		.bind(enabled ? null : Date.now(), id)
		.run();
}

/**
 * プロバイダキーを削除する。所有者だけができる。
 * 暗号化したキーを消し(空の文字列にする)、無効にして、結び付いたすべての sigw キーから外す。
 * 名前と末尾4文字は残す。
 * Managed Agents のセッションが動いている(読むのをやめていない)あいだは断る。
 * Cron がこのキーでセッションの使用量を読むため(docs/design.md 5.3)
 */
export async function deleteProviderKey(
	db: D1Database,
	id: string,
	actorId: string,
): Promise<void> {
	await requireProviderKeyOwner(db, id, actorId);
	const now = Date.now();
	// セッションの確かめと削除を、同じトランザクションで行う。確かめたあとにセッションが増えても、消さないため
	const [deleted] = await db.batch([
		db
			.prepare(
				`UPDATE provider_keys SET encrypted_key = '', deleted_at = ?, disabled_at = COALESCE(disabled_at, ?)
				 WHERE id = ? AND deleted_at IS NULL
					AND NOT EXISTS (SELECT 1 FROM agent_sessions WHERE provider_key_id = ? AND ended_at IS NULL)`,
			)
			.bind(now, now, id, id),
		db
			.prepare(
				`UPDATE sigw_keys SET updated_at = ?
				 WHERE id IN (SELECT sigw_key_id FROM sigw_key_providers WHERE provider_key_id = ?)
					AND EXISTS (SELECT 1 FROM provider_keys WHERE id = ? AND deleted_at = ?)`,
			)
			.bind(now, id, id, now),
		db
			.prepare(
				`DELETE FROM sigw_key_providers WHERE provider_key_id = ?
					AND EXISTS (SELECT 1 FROM provider_keys WHERE id = ? AND deleted_at = ?)`,
			)
			.bind(id, id, now),
	]);
	if ((deleted?.meta.changes ?? 0) === 0) {
		throw conflict(
			"このプロバイダキーで動いているエージェントのセッションがあります。セッションが終わってから削除してください。",
		);
	}
}

/** sigw キーに結び付いたプロバイダキー。sigw キー1つに、プロバイダごとに1つまで */
export interface LinkedProviderKey {
	id: string;
	provider: ProviderId;
	label: string;
	ownerId: string;
	ownerName: string;
	/** プロバイダキーが無効。このプロバイダだけ呼べない */
	disabled: boolean;
	/** 代理専用。このプロバイダの呼び出しは、BobertGateway からしか使えない */
	delegatedOnly: boolean;
	/** 結び付けた時刻 */
	linkedAt: number;
}

export interface SigwKey {
	id: string;
	/** プロバイダの並び(PROVIDER_IDS)の順 */
	providerKeys: LinkedProviderKey[];
	createdBy: string;
	createdByName: string;
	purpose: string;
	tokenHint: string;
	allowedModels: string[] | null;
	monthlyLimitNano: number | null;
	expiresAt: number | null;
	createdAt: number;
	revokedAt: number | null;
	/** 削除した時刻。削除したキーは、使用量に名前を出すときにだけ返す(listSigwKeys の includeDeleted) */
	deletedAt: number | null;
}

interface SigwKeyRow {
	id: string;
	created_by: string;
	created_by_name: string;
	purpose: string;
	token_hint: string;
	allowed_models: string | null;
	monthly_limit_nano_usd: number | null;
	expires_at: number | null;
	created_at: number;
	revoked_at: number | null;
	deleted_at: number | null;
}

interface LinkRow {
	sigw_key_id: string;
	provider_key_id: string;
	provider: ProviderId;
	label: string;
	owner_id: string;
	owner_name: string;
	disabled_at: number | null;
	delegated_only: number;
	linked_at: number;
}

const SIGW_KEY_SELECT = `SELECT s.id, s.created_by, c.name AS created_by_name, s.purpose, s.token_hint, s.allowed_models,
	s.monthly_limit_nano_usd, s.expires_at, s.created_at, s.revoked_at, s.deleted_at
	FROM sigw_keys s
	JOIN users c ON c.id = s.created_by`;

const LINK_SELECT = `SELECT l.sigw_key_id, l.provider_key_id, l.provider, p.label, p.owner_id, o.name AS owner_name,
	p.disabled_at, p.delegated_only, l.created_at AS linked_at
	FROM sigw_key_providers l
	JOIN provider_keys p ON p.id = l.provider_key_id
	JOIN users o ON o.id = p.owner_id`;

function toLinked(row: LinkRow): LinkedProviderKey {
	return {
		id: row.provider_key_id,
		provider: row.provider,
		label: row.label,
		ownerId: row.owner_id,
		ownerName: row.owner_name,
		disabled: row.disabled_at !== null,
		delegatedOnly: row.delegated_only === 1,
		linkedAt: row.linked_at,
	};
}

function toSigwKeys(rows: SigwKeyRow[], links: LinkRow[]): SigwKey[] {
	const byKey = new Map<string, LinkedProviderKey[]>();
	for (const link of links) {
		const list = byKey.get(link.sigw_key_id) ?? [];
		list.push(toLinked(link));
		byKey.set(link.sigw_key_id, list);
	}
	const order = (provider: ProviderId) => PROVIDER_IDS.indexOf(provider);
	return rows.map((row) => ({
		id: row.id,
		providerKeys: (byKey.get(row.id) ?? []).sort(
			(a, b) => order(a.provider) - order(b.provider),
		),
		createdBy: row.created_by,
		createdByName: row.created_by_name,
		purpose: row.purpose,
		tokenHint: row.token_hint,
		allowedModels: parseModels(row.allowed_models),
		monthlyLimitNano: row.monthly_limit_nano_usd,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		revokedAt: row.revoked_at,
		deletedAt: row.deleted_at,
	}));
}

export function parseModels(json: string | null): string[] | null {
	if (json === null) {
		return null;
	}
	try {
		const value = JSON.parse(json) as unknown;
		return Array.isArray(value)
			? value.filter((v): v is string => typeof v === "string")
			: null;
	} catch {
		return null;
	}
}

/** sigw キーの一覧。includeDeleted なら、削除したキーも返す(使用量に名前を出すため) */
export async function listSigwKeys(
	db: D1Database,
	options: { includeDeleted?: boolean } = {},
): Promise<SigwKey[]> {
	const [keys, links] = await db.batch([
		db.prepare(
			`${SIGW_KEY_SELECT} ${options.includeDeleted ? "" : "WHERE s.deleted_at IS NULL"}
			 ORDER BY s.deleted_at IS NOT NULL, s.revoked_at IS NOT NULL, s.created_at DESC`,
		),
		db.prepare(LINK_SELECT),
	]);
	return toSigwKeys(
		(keys?.results ?? []) as SigwKeyRow[],
		(links?.results ?? []) as LinkRow[],
	);
}

/** 削除していない sigw キーを引く */
export async function getSigwKey(
	db: D1Database,
	id: string,
): Promise<SigwKey | null> {
	const [keys, links] = await db.batch([
		db
			.prepare(`${SIGW_KEY_SELECT} WHERE s.id = ? AND s.deleted_at IS NULL`)
			.bind(id),
		db.prepare(`${LINK_SELECT} WHERE l.sigw_key_id = ?`).bind(id),
	]);
	return (
		toSigwKeys(
			(keys?.results ?? []) as SigwKeyRow[],
			(links?.results ?? []) as LinkRow[],
		)[0] ?? null
	);
}

export interface SigwKeySettings {
	purpose: string;
	allowedModels: string[] | null;
	monthlyLimitNano: number | null;
	expiresAt: number | null;
}

function validateSettings(settings: SigwKeySettings): SigwKeySettings {
	const purpose = settings.purpose.trim();
	if (purpose === "") {
		throw badRequest("目的を入れてください");
	}
	if (purpose.length > 80) {
		throw badRequest("目的は80文字までにしてください");
	}
	if (
		settings.monthlyLimitNano !== null &&
		(!Number.isSafeInteger(settings.monthlyLimitNano) ||
			settings.monthlyLimitNano <= 0)
	) {
		throw badRequest("月の上限額は0より大きい金額にしてください");
	}
	if (settings.allowedModels && settings.allowedModels.length > 50) {
		throw badRequest("モデルの制限は50個までにしてください");
	}
	return { ...settings, purpose };
}

interface ProviderKeyState {
	id: string;
	provider: ProviderId;
	owner_id: string;
	disabled_at: number | null;
}

async function providerKeyState(
	db: D1Database,
	id: string,
): Promise<ProviderKeyState> {
	const row = await db
		.prepare(
			"SELECT id, provider, owner_id, disabled_at FROM provider_keys WHERE id = ? AND deleted_at IS NULL",
		)
		.bind(id)
		.first<ProviderKeyState>();
	if (!row) {
		throw notFound("プロバイダキーが見つかりません");
	}
	return row;
}

function providerLabel(provider: ProviderId): string {
	return PROVIDERS[provider]?.label ?? provider;
}

function linkStatement(
	db: D1Database,
	sigwKeyId: string,
	providerKey: ProviderKeyState,
	now: number,
): D1PreparedStatement {
	return db
		.prepare(
			"INSERT INTO sigw_key_providers (sigw_key_id, provider, provider_key_id, created_at) VALUES (?, ?, ?, ?)",
		)
		.bind(sigwKeyId, providerKey.provider, providerKey.id, now);
}

/**
 * sigw キーを発行する。発行したトークン(平文)を返す。トークンはこのときにしか見られない。
 * providerKeyIds は結び付けるプロバイダキー。1つ以上で、プロバイダごとに1つまで
 */
export async function createSigwKey(
	db: D1Database,
	input: SigwKeySettings & { providerKeyIds: string[]; createdBy: string },
): Promise<{ id: string; token: string }> {
	const settings = validateSettings(input);
	const ids = [...new Set(input.providerKeyIds)];
	if (ids.length === 0) {
		throw badRequest("プロバイダキーを選んでください");
	}
	const providerKeys: ProviderKeyState[] = [];
	for (const providerKeyId of ids) {
		const providerKey = await providerKeyState(db, providerKeyId);
		if (providerKey.disabled_at !== null) {
			throw badRequest(
				"無効になっているプロバイダキーには、sigw キーを発行できません",
			);
		}
		if (providerKeys.some((item) => item.provider === providerKey.provider)) {
			throw badRequest(
				`${providerLabel(providerKey.provider)} のプロバイダキーは1つだけ選んでください`,
			);
		}
		providerKeys.push(providerKey);
	}
	const id = newId();
	const token = newToken(TOKEN_PREFIX.sigwKey);
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`INSERT INTO sigw_keys (id, created_by, purpose, token_hash, token_hint, allowed_models,
					monthly_limit_nano_usd, expires_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				input.createdBy,
				settings.purpose,
				await sha256Hex(token),
				tokenHint(token),
				settings.allowedModels ? JSON.stringify(settings.allowedModels) : null,
				settings.monthlyLimitNano,
				settings.expiresAt,
				now,
				now,
			),
		...providerKeys.map((providerKey) =>
			linkStatement(db, id, providerKey, now),
		),
	]);
	return { id, token };
}

/** 設定を変えられるのは、発行した人と、結び付いたプロバイダキーの所有者 */
async function requireEditable(
	db: D1Database,
	id: string,
	actorId: string,
): Promise<SigwKey> {
	const key = await getSigwKey(db, id);
	if (!key) {
		throw notFound("sigw キーが見つかりません");
	}
	if (
		key.createdBy !== actorId &&
		!key.providerKeys.some((providerKey) => providerKey.ownerId === actorId)
	) {
		throw forbidden(
			"sigw キーを変えられるのは、発行した人と、結び付いたプロバイダキーの所有者だけです",
		);
	}
	return key;
}

export async function updateSigwKey(
	db: D1Database,
	id: string,
	actorId: string,
	input: SigwKeySettings,
): Promise<void> {
	await requireEditable(db, id, actorId);
	const settings = validateSettings(input);
	await db
		.prepare(
			"UPDATE sigw_keys SET purpose = ?, allowed_models = ?, monthly_limit_nano_usd = ?, expires_at = ?, updated_at = ? WHERE id = ?",
		)
		.bind(
			settings.purpose,
			settings.allowedModels ? JSON.stringify(settings.allowedModels) : null,
			settings.monthlyLimitNano,
			settings.expiresAt,
			Date.now(),
			id,
		)
		.run();
}

/**
 * 発行したあとの sigw キーに、プロバイダキーを足す。
 * 足せるのは、sigw キーを変えられる人(requireEditable)のうち、
 * 足すプロバイダキーの所有者か、sigw キーを発行した人。
 * 発行した人は、誰のプロバイダキーでも足せる(発行し直せば同じことができるため)。
 * 所有者は自分のキーだけ足せる(ほかの人のキーを、自分が発行していない sigw キーに付けないため)
 */
export async function addSigwKeyProvider(
	db: D1Database,
	id: string,
	actorId: string,
	providerKeyId: string,
): Promise<void> {
	const key = await requireEditable(db, id, actorId);
	if (key.revokedAt !== null) {
		throw badRequest("無効にした sigw キーは変えられません");
	}
	const providerKey = await providerKeyState(db, providerKeyId);
	if (key.createdBy !== actorId && providerKey.owner_id !== actorId) {
		throw forbidden(
			"ほかの人のプロバイダキーを足せるのは、sigw キーを発行した人だけです",
		);
	}
	if (providerKey.disabled_at !== null) {
		throw badRequest("無効になっているプロバイダキーは足せません");
	}
	const current = key.providerKeys.find(
		(item) => item.provider === providerKey.provider,
	);
	if (current?.id === providerKey.id) {
		return;
	}
	if (current) {
		throw badRequest(
			`この sigw キーには、すでに ${providerLabel(providerKey.provider)} のプロバイダキーがあります。先に外してください`,
		);
	}
	const now = Date.now();
	await db.batch([
		linkStatement(db, id, providerKey, now),
		db
			.prepare("UPDATE sigw_keys SET updated_at = ? WHERE id = ?")
			.bind(now, id),
	]);
}

/**
 * sigw キーから、プロバイダキーを外す。外せるのは、sigw キーを発行した人と、外すプロバイダキーの所有者。
 * 最後の1つは外せない(使わないなら、sigw キーを無効にする)
 */
export async function removeSigwKeyProvider(
	db: D1Database,
	id: string,
	actorId: string,
	providerKeyId: string,
): Promise<void> {
	const key = await getSigwKey(db, id);
	if (!key) {
		throw notFound("sigw キーが見つかりません");
	}
	const link = key.providerKeys.find((item) => item.id === providerKeyId);
	if (!link) {
		throw notFound("この sigw キーには、そのプロバイダキーはありません");
	}
	if (key.createdBy !== actorId && link.ownerId !== actorId) {
		throw forbidden(
			"プロバイダキーを外せるのは、sigw キーを発行した人と、そのプロバイダキーの所有者だけです",
		);
	}
	if (key.revokedAt !== null) {
		throw badRequest("無効にした sigw キーは変えられません");
	}
	if (key.providerKeys.length === 1) {
		throw badRequest(
			"最後のプロバイダキーは外せません。使わないなら、sigw キーを無効にしてください",
		);
	}
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"DELETE FROM sigw_key_providers WHERE sigw_key_id = ? AND provider_key_id = ?",
			)
			.bind(id, providerKeyId),
		db
			.prepare("UPDATE sigw_keys SET updated_at = ? WHERE id = ?")
			.bind(now, id),
	]);
}

export async function revokeSigwKey(
	db: D1Database,
	id: string,
	actorId: string,
): Promise<void> {
	const key = await requireEditable(db, id, actorId);
	if (key.revokedAt !== null) {
		return;
	}
	await db
		.prepare("UPDATE sigw_keys SET revoked_at = ?, updated_at = ? WHERE id = ?")
		.bind(Date.now(), Date.now(), id)
		.run();
}

/**
 * sigw キーを削除する。無効化と同じく、発行した人と、結び付いたプロバイダキーの所有者ができる。
 * トークンのハッシュを、どのトークンとも一致しない値(deleted: と ID)にして、無効にする。目的などは残す
 */
export async function deleteSigwKey(
	db: D1Database,
	id: string,
	actorId: string,
): Promise<void> {
	await requireEditable(db, id, actorId);
	const now = Date.now();
	await db
		.prepare(
			`UPDATE sigw_keys SET token_hash = 'deleted:' || id, deleted_at = ?, revoked_at = COALESCE(revoked_at, ?), updated_at = ?
			 WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(now, now, now, id)
		.run();
}
