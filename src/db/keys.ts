/*
 * プロバイダキーと sigw キー。
 * - プロバイダキーは、所有者だけが無効にできる。キーそのものは暗号化して保存し、画面には末尾4文字だけ出す
 * - 代理専用のプロバイダキーは、登録するときに決める。あとから公開の入口で使えるようにはしない
 * - sigw キーは誰でも発行できる。変更と無効化は、発行した人とプロバイダキーの所有者ができる
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
import { isProviderId, type ProviderId } from "../proxy/providers.ts";

export interface ProviderKey {
	id: string;
	ownerId: string;
	ownerName: string;
	provider: ProviderId;
	label: string;
	keyHint: string;
	createdAt: number;
	disabledAt: number | null;
	/** 有効な sigw キーの数 */
	activeSigwKeys: number;
	/** 代理専用。これにつながる sigw キーは、BobertGateway からしか使えない */
	delegatedOnly: boolean;
}

export async function listProviderKeys(db: D1Database): Promise<ProviderKey[]> {
	const { results } = await db
		.prepare(
			`SELECT p.id, p.owner_id, u.name AS owner_name, p.provider, p.label, p.key_hint, p.created_at, p.disabled_at, p.delegated_only,
				(SELECT COUNT(*) FROM sigw_keys s WHERE s.provider_key_id = p.id AND s.revoked_at IS NULL) AS active_sigw_keys
			 FROM provider_keys p JOIN users u ON u.id = p.owner_id
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

/** プロバイダキーを無効にする(enabled = false)か、有効に戻す。所有者だけができる */
export async function setProviderKeyEnabled(
	db: D1Database,
	id: string,
	actorId: string,
	enabled: boolean,
): Promise<void> {
	const row = await db
		.prepare("SELECT owner_id FROM provider_keys WHERE id = ?")
		.bind(id)
		.first<{ owner_id: string }>();
	if (!row) {
		throw notFound("プロバイダキーが見つかりません");
	}
	if (row.owner_id !== actorId) {
		throw forbidden("プロバイダキーを変えられるのは、登録した人だけです");
	}
	await db
		.prepare("UPDATE provider_keys SET disabled_at = ? WHERE id = ?")
		.bind(enabled ? null : Date.now(), id)
		.run();
}

export interface SigwKey {
	id: string;
	providerKeyId: string;
	provider: ProviderId;
	providerKeyLabel: string;
	ownerId: string;
	ownerName: string;
	createdBy: string;
	createdByName: string;
	purpose: string;
	tokenHint: string;
	allowedModels: string[] | null;
	monthlyLimitNano: number | null;
	expiresAt: number | null;
	createdAt: number;
	revokedAt: number | null;
	providerKeyDisabled: boolean;
}

interface SigwKeyRow {
	id: string;
	provider_key_id: string;
	provider: ProviderId;
	provider_key_label: string;
	owner_id: string;
	owner_name: string;
	created_by: string;
	created_by_name: string;
	purpose: string;
	token_hint: string;
	allowed_models: string | null;
	monthly_limit_nano_usd: number | null;
	expires_at: number | null;
	created_at: number;
	revoked_at: number | null;
	provider_key_disabled_at: number | null;
}

const SIGW_KEY_SELECT = `SELECT s.id, s.provider_key_id, p.provider, p.label AS provider_key_label, p.owner_id, o.name AS owner_name,
	s.created_by, c.name AS created_by_name, s.purpose, s.token_hint, s.allowed_models, s.monthly_limit_nano_usd,
	s.expires_at, s.created_at, s.revoked_at, p.disabled_at AS provider_key_disabled_at
	FROM sigw_keys s
	JOIN provider_keys p ON p.id = s.provider_key_id
	JOIN users o ON o.id = p.owner_id
	JOIN users c ON c.id = s.created_by`;

function toSigwKey(row: SigwKeyRow): SigwKey {
	return {
		id: row.id,
		providerKeyId: row.provider_key_id,
		provider: row.provider,
		providerKeyLabel: row.provider_key_label,
		ownerId: row.owner_id,
		ownerName: row.owner_name,
		createdBy: row.created_by,
		createdByName: row.created_by_name,
		purpose: row.purpose,
		tokenHint: row.token_hint,
		allowedModels: parseModels(row.allowed_models),
		monthlyLimitNano: row.monthly_limit_nano_usd,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		revokedAt: row.revoked_at,
		providerKeyDisabled: row.provider_key_disabled_at !== null,
	};
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

export async function listSigwKeys(db: D1Database): Promise<SigwKey[]> {
	const { results } = await db
		.prepare(
			`${SIGW_KEY_SELECT} ORDER BY s.revoked_at IS NOT NULL, s.created_at DESC`,
		)
		.all<SigwKeyRow>();
	return results.map(toSigwKey);
}

export async function getSigwKey(
	db: D1Database,
	id: string,
): Promise<SigwKey | null> {
	const row = await db
		.prepare(`${SIGW_KEY_SELECT} WHERE s.id = ?`)
		.bind(id)
		.first<SigwKeyRow>();
	return row ? toSigwKey(row) : null;
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

/** sigw キーを発行する。発行したトークン(平文)を返す。トークンはこのときにしか見られない */
export async function createSigwKey(
	db: D1Database,
	input: SigwKeySettings & { providerKeyId: string; createdBy: string },
): Promise<{ id: string; token: string }> {
	const settings = validateSettings(input);
	const providerKey = await db
		.prepare("SELECT disabled_at FROM provider_keys WHERE id = ?")
		.bind(input.providerKeyId)
		.first<{ disabled_at: number | null }>();
	if (!providerKey) {
		throw notFound("プロバイダキーが見つかりません");
	}
	if (providerKey.disabled_at !== null) {
		throw badRequest(
			"無効になっているプロバイダキーには、sigw キーを発行できません",
		);
	}
	const id = newId();
	const token = newToken(TOKEN_PREFIX.sigwKey);
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO sigw_keys (id, provider_key_id, created_by, purpose, token_hash, token_hint, allowed_models,
				monthly_limit_nano_usd, expires_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			input.providerKeyId,
			input.createdBy,
			settings.purpose,
			await sha256Hex(token),
			tokenHint(token),
			settings.allowedModels ? JSON.stringify(settings.allowedModels) : null,
			settings.monthlyLimitNano,
			settings.expiresAt,
			now,
			now,
		)
		.run();
	return { id, token };
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
	if (key.createdBy !== actorId && key.ownerId !== actorId) {
		throw forbidden(
			"sigw キーを変えられるのは、発行した人とプロバイダキーの所有者だけです",
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
