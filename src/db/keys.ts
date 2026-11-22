/*
 * sigw キーと、sigw キーに登録する API キー(プロバイダキー、provider_keys)。docs/design.md 3.2、3.3
 * - sigw キーは誰でも発行できる。API キーは、sigw キーごとに、プロバイダごとに1つまで登録する(sigw_key_providers)
 * - API キーは、登録した sigw キーだけのもの。ほかの sigw キーとは共有しない。登録した人が所有者(精算で払った人)になる。
 *   キーそのものは暗号化して保存し、画面には末尾4文字だけ出す
 * - 代理専用は、API キーを登録するときに決める。あとから公開の入口で使えるようにはしない
 * - sigw キーの変更・無効化・削除と、API キーの登録・差し替え・外すのは、発行した人と、API キーを登録した人ができる(canEditSigwKey)
 * - 外した・差し替えた API キーは削除する。削除しても行は残し、秘密の値(暗号化したキー、トークンのハッシュ)だけを消す。
 *   過去の使用量に名前を出すため。削除したキーは、一覧にも出さない
 */

import {
	encryptText,
	newId,
	newToken,
	sha256Hex,
	TOKEN_PREFIX,
	tokenHint,
} from "../lib/crypto.ts";
import { badRequest, forbidden, notFound } from "../lib/errors.ts";
import {
	isProviderId,
	PROVIDER_IDS,
	PROVIDERS,
	type ProviderId,
} from "../proxy/providers.ts";

/** sigw キーに登録する API キー(プロバイダキー)。登録した人が所有者になる */
export interface NewApiKey {
	provider: string;
	apiKey: string;
	/** 代理専用にする(BobertGateway からだけ使える)。登録したあとは変えられない */
	delegatedOnly?: boolean;
}

interface ValidApiKey {
	provider: ProviderId;
	apiKey: string;
	delegatedOnly: boolean;
}

function validateApiKey(input: NewApiKey): ValidApiKey {
	if (!isProviderId(input.provider)) {
		throw badRequest(`プロバイダ ${input.provider} には対応していません`);
	}
	const apiKey = input.apiKey.trim();
	if (apiKey.length < 8 || /\s/.test(apiKey)) {
		throw badRequest("API キーの形が正しくありません");
	}
	return {
		provider: input.provider,
		apiKey,
		delegatedOnly: input.delegatedOnly === true,
	};
}

/**
 * プロバイダキーの行を足す文と、その ID。名前(label)は sigw キーの目的にする。画面には出さない
 */
async function insertProviderKey(
	db: D1Database,
	encryptionSecret: string,
	input: ValidApiKey & { ownerId: string; label: string },
	now: number,
): Promise<{ id: string; statement: D1PreparedStatement }> {
	const id = newId();
	const statement = db
		.prepare(
			"INSERT INTO provider_keys (id, owner_id, provider, label, encrypted_key, key_hint, created_at, delegated_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.bind(
			id,
			input.ownerId,
			input.provider,
			input.label.slice(0, 60),
			await encryptText(encryptionSecret, input.apiKey),
			`…${input.apiKey.slice(-4)}`,
			now,
			input.delegatedOnly ? 1 : 0,
		);
	return { id, statement };
}

/**
 * どの(削除していない)sigw キーにも結び付いていないプロバイダキーを削除する文。ids のうち、当てはまるものだけを消す。
 * 外したり差し替えたりしたあとに、同じバッチの最後に流す。
 * - 無効にして deleted_at を入れる。一覧にも出さず、中継でも使わない
 * - 暗号化したキーは、Managed Agents のセッションが動いていなければ、すぐ消す(空の文字列にする)。
 *   動いていれば残し、セッションが終わってから Cron が消す(purgeDeletedProviderKeys)。
 *   Cron がこのキーで、セッションの使用量を読むため(docs/design.md 3.3、5.3)
 * - 0009 より前に作った、2つ以上の sigw キーに結び付いたキーは、ほかの sigw キーに結び付いているあいだは消さない
 */
function deleteUnlinkedProviderKeys(
	db: D1Database,
	ids: string[],
	now: number,
): D1PreparedStatement[] {
	if (ids.length === 0) {
		return [];
	}
	return [
		db
			.prepare(
				`UPDATE provider_keys SET deleted_at = ?, disabled_at = COALESCE(disabled_at, ?),
					encrypted_key = CASE
						WHEN EXISTS (SELECT 1 FROM agent_sessions a WHERE a.provider_key_id = provider_keys.id AND a.ended_at IS NULL)
						THEN encrypted_key ELSE '' END
				 WHERE id IN (${ids.map(() => "?").join(", ")}) AND deleted_at IS NULL
					AND NOT EXISTS (
						SELECT 1 FROM sigw_key_providers l JOIN sigw_keys s ON s.id = l.sigw_key_id
						WHERE l.provider_key_id = provider_keys.id AND s.deleted_at IS NULL
					)`,
			)
			.bind(now, now, ...ids),
	];
}

/**
 * 削除したプロバイダキーのうち、暗号化したキーが残っていて、動いているセッションがなくなったものから、キーを消す。
 * Managed Agents のセッションを読む Cron(5分ごと)が、読み終えたあとに呼ぶ。消した数を返す
 */
export async function purgeDeletedProviderKeys(
	db: D1Database,
): Promise<number> {
	const result = await db
		.prepare(
			`UPDATE provider_keys SET encrypted_key = ''
			 WHERE deleted_at IS NOT NULL AND encrypted_key <> ''
				AND NOT EXISTS (SELECT 1 FROM agent_sessions a WHERE a.provider_key_id = provider_keys.id AND a.ended_at IS NULL)`,
		)
		.run();
	return result.meta.changes ?? 0;
}

/**
 * sigw キーに登録した API キー(プロバイダキー)。sigw キー1つに、プロバイダごとに1つまで。
 * API キーは、登録した sigw キーだけのもの(docs/design.md 3.2)
 */
export interface LinkedProviderKey {
	id: string;
	provider: ProviderId;
	/** 末尾4文字 */
	keyLast4: string;
	/** 登録した人。精算では、この人が払った人になる */
	ownerId: string;
	ownerName: string;
	/** プロバイダキーが無効。このプロバイダだけ呼べない(0009 より前に無効にしたキーだけ) */
	disabled: boolean;
	/** 代理専用。このプロバイダの呼び出しは、BobertGateway からしか使えない */
	delegatedOnly: boolean;
	/** 登録した時刻 */
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
	key_hint: string;
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

const LINK_SELECT = `SELECT l.sigw_key_id, l.provider_key_id, l.provider, p.key_hint, p.owner_id, o.name AS owner_name,
	p.disabled_at, p.delegated_only, l.created_at AS linked_at
	FROM sigw_key_providers l
	JOIN provider_keys p ON p.id = l.provider_key_id
	JOIN users o ON o.id = p.owner_id
	WHERE p.deleted_at IS NULL`;

function toLinked(row: LinkRow): LinkedProviderKey {
	return {
		id: row.provider_key_id,
		provider: row.provider,
		keyLast4: row.key_hint.replace(/^…/, ""),
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
		db.prepare(`${LINK_SELECT} AND l.sigw_key_id = ?`).bind(id),
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

function providerLabel(provider: ProviderId): string {
	return PROVIDERS[provider]?.label ?? provider;
}

/** sigw_key_providers に結び付きを足すか、そのプロバイダの結び付きを差し替える文 */
function linkStatement(
	db: D1Database,
	sigwKeyId: string,
	provider: ProviderId,
	providerKeyId: string,
	now: number,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO sigw_key_providers (sigw_key_id, provider, provider_key_id, created_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT (sigw_key_id, provider) DO UPDATE SET provider_key_id = excluded.provider_key_id, created_at = excluded.created_at`,
		)
		.bind(sigwKeyId, provider, providerKeyId, now);
}

/**
 * sigw キーを発行する。発行したトークン(平文)を返す。トークンはこのときにしか見られない。
 * apiKeys は、一緒に登録する API キー。プロバイダごとに1つまで。発行した人が、どのキーの所有者にもなる。
 * API では0個でも発行できる(CLI は発行したあとで set-provider で登録する)。Web UI では1つ以上を求める
 */
export async function createSigwKey(
	db: D1Database,
	encryptionSecret: string,
	input: SigwKeySettings & { apiKeys: NewApiKey[]; createdBy: string },
): Promise<{ id: string; token: string }> {
	const settings = validateSettings(input);
	const apiKeys = input.apiKeys.map(validateApiKey);
	const seen = new Set<ProviderId>();
	for (const apiKey of apiKeys) {
		if (seen.has(apiKey.provider)) {
			throw badRequest(
				`${providerLabel(apiKey.provider)} の API キーは1つだけ入れてください`,
			);
		}
		seen.add(apiKey.provider);
	}
	const id = newId();
	const token = newToken(TOKEN_PREFIX.sigwKey);
	const now = Date.now();
	const statements: D1PreparedStatement[] = [
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
	];
	for (const apiKey of apiKeys) {
		const inserted = await insertProviderKey(
			db,
			encryptionSecret,
			{ ...apiKey, ownerId: input.createdBy, label: settings.purpose },
			now,
		);
		statements.push(
			inserted.statement,
			linkStatement(db, id, apiKey.provider, inserted.id, now),
		);
	}
	await db.batch(statements);
	return { id, token };
}

/**
 * sigw キーを変えられる人か。発行した人と、登録した API キーの所有者(登録した人)。
 * 設定の変更、無効化、削除、API キーの登録・差し替え・外すのは、すべてこの人たち
 */
export function canEditSigwKey(
	key: Pick<SigwKey, "createdBy" | "providerKeys">,
	actorId: string,
): boolean {
	return (
		key.createdBy === actorId ||
		key.providerKeys.some((providerKey) => providerKey.ownerId === actorId)
	);
}

async function requireEditable(
	db: D1Database,
	id: string,
	actorId: string,
): Promise<SigwKey> {
	const key = await getSigwKey(db, id);
	if (!key) {
		throw notFound("sigw キーが見つかりません");
	}
	if (!canEditSigwKey(key, actorId)) {
		throw forbidden(
			"sigw キーを変えられるのは、発行した人と、API キーを登録した人だけです",
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
 * sigw キーに、そのプロバイダの API キーを登録する。登録済みなら差し替え、前のキーは削除する。
 * 登録した人が、新しいキーの所有者になる。無効にした sigw キーには登録できない
 */
export async function setSigwKeyProvider(
	db: D1Database,
	encryptionSecret: string,
	id: string,
	actorId: string,
	input: NewApiKey,
): Promise<void> {
	const key = await requireEditable(db, id, actorId);
	if (key.revokedAt !== null) {
		throw badRequest("無効にした sigw キーは変えられません");
	}
	const apiKey = validateApiKey(input);
	const previous = key.providerKeys.find(
		(item) => item.provider === apiKey.provider,
	);
	const now = Date.now();
	const inserted = await insertProviderKey(
		db,
		encryptionSecret,
		{ ...apiKey, ownerId: actorId, label: key.purpose },
		now,
	);
	await db.batch([
		inserted.statement,
		linkStatement(db, id, apiKey.provider, inserted.id, now),
		db
			.prepare("UPDATE sigw_keys SET updated_at = ? WHERE id = ?")
			.bind(now, id),
		...deleteUnlinkedProviderKeys(db, previous ? [previous.id] : [], now),
	]);
}

/**
 * sigw キーから、そのプロバイダの API キーを外して削除する。登録していなければ何もしない。
 * 最後の1つも外せる(sigw キーは「API キーが未登録」になる)
 */
export async function removeSigwKeyProvider(
	db: D1Database,
	id: string,
	actorId: string,
	provider: string,
): Promise<void> {
	if (!isProviderId(provider)) {
		throw badRequest(`プロバイダ ${provider} には対応していません`);
	}
	const key = await requireEditable(db, id, actorId);
	if (key.revokedAt !== null) {
		throw badRequest("無効にした sigw キーは変えられません");
	}
	const current = key.providerKeys.find((item) => item.provider === provider);
	if (!current) {
		return;
	}
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				"DELETE FROM sigw_key_providers WHERE sigw_key_id = ? AND provider = ?",
			)
			.bind(id, provider),
		db
			.prepare("UPDATE sigw_keys SET updated_at = ? WHERE id = ?")
			.bind(now, id),
		...deleteUnlinkedProviderKeys(db, [current.id], now),
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
 * sigw キーを削除する。無効化と同じ人ができる。
 * トークンのハッシュを、どのトークンとも一致しない値(deleted: と ID)にして、無効にする。目的などは残す。
 * 登録した API キーも、外して削除する(動いているセッションがあれば、暗号化したキーは Cron があとで消す)
 */
export async function deleteSigwKey(
	db: D1Database,
	id: string,
	actorId: string,
): Promise<void> {
	const key = await requireEditable(db, id, actorId);
	const now = Date.now();
	await db.batch([
		db
			.prepare(
				`UPDATE sigw_keys SET token_hash = 'deleted:' || id, deleted_at = ?, revoked_at = COALESCE(revoked_at, ?), updated_at = ?
				 WHERE id = ? AND deleted_at IS NULL`,
			)
			.bind(now, now, now, id),
		db.prepare("DELETE FROM sigw_key_providers WHERE sigw_key_id = ?").bind(id),
		...deleteUnlinkedProviderKeys(
			db,
			key.providerKeys.map((providerKey) => providerKey.id),
			now,
		),
	]);
}
