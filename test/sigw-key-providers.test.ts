/*
 * 1つの sigw キーに、プロバイダごとに API キー(プロバイダキー)を登録する(migrations/0007、docs/design.md 3.2)。
 * マイグレーションでの移し替え、中継でのプロバイダキーの選び方、API キーの登録・差し替え・外す、BobertGateway の GET /sigw/key
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api/router.ts";
import type { SigwKeyJson } from "../src/api/types.ts";
import { createSession } from "../src/db/sessions.ts";
import { decryptText, encryptText, sha256Hex } from "../src/lib/crypto.ts";
import { clearAuthCache } from "../src/proxy/auth.ts";
import { handleBobertRequest } from "../src/proxy/bobert.ts";
import { handleProxy } from "../src/proxy/handler.ts";
import { PROVIDERS, type ProviderSpec } from "../src/proxy/providers.ts";
import { FakeD1 } from "./fake-d1.ts";

const SECRET = "test-secret";
const SIGW_TOKEN = "sgk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaWXYZ";
const PERSONAL_TOKEN = "sgu_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
// 発行する人(U1)、Anthropic の所有者(U2)、OpenRouter と OpenAI の所有者(U3)
const U1 = "100000000000000001";
const U2 = "100000000000000002";
const U3 = "100000000000000003";

function fakeCtx() {
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => pending.push(promise),
		passThroughOnException: () => {},
		props: {},
	} as unknown as ExecutionContext;
	return { ctx, settle: () => Promise.all(pending) };
}

async function seedUsers(db: FakeD1): Promise<void> {
	const now = Date.now();
	db.rows(
		"INSERT INTO users (id, name, personal_token_hash, created_at, updated_at) VALUES (?, 'U1', ?, ?, ?), (?, 'U2', NULL, ?, ?), (?, 'U3', NULL, ?, ?)",
		U1,
		await sha256Hex(PERSONAL_TOKEN),
		now,
		now,
		U2,
		now,
		now,
		U3,
		now,
		now,
	);
}

async function seedProviderKey(
	db: FakeD1,
	id: string,
	owner: string,
	provider: string,
	options: { delegatedOnly?: boolean; disabled?: boolean } = {},
): Promise<void> {
	db.rows(
		"INSERT INTO provider_keys (id, owner_id, provider, label, encrypted_key, key_hint, created_at, disabled_at, delegated_only) VALUES (?, ?, ?, ?, ?, '…real', ?, ?, ?)",
		id,
		owner,
		provider,
		`${provider}-key`,
		await encryptText(SECRET, `real-${id}`),
		Date.now(),
		options.disabled ? Date.now() : null,
		options.delegatedOnly ? 1 : 0,
	);
}

describe("マイグレーション 0007", () => {
	it("sigw_keys.provider_key_id を、sigw キー1つにつき1行の結び付きに移す", () => {
		const db = new FakeD1({ before: "0007" });
		db.sqlite.exec(`
			INSERT INTO users (id, name, created_at, updated_at) VALUES ('u1', 'A', 1, 1), ('u2', 'B', 1, 1);
			INSERT INTO provider_keys (id, owner_id, provider, label, encrypted_key, key_hint, created_at, disabled_at, delegated_only) VALUES
				('pk-ant', 'u1', 'anthropic', 'main', 'enc', '…aaaa', 10, NULL, 1),
				('pk-or', 'u2', 'openrouter', 'main', 'enc', '…bbbb', 11, 500, 0);
			INSERT INTO sigw_keys (id, provider_key_id, created_by, purpose, token_hash, token_hint, allowed_models,
				monthly_limit_nano_usd, expires_at, created_at, updated_at, revoked_at) VALUES
				('sk1', 'pk-ant', 'u2', 'Bobert', 'h1', 'sgk_abc…xyz', '["claude-*"]', 5000000000, NULL, 100, 101, NULL),
				('sk2', 'pk-or', 'u1', '記事', 'h2', 'sgk_def…uvw', NULL, NULL, 9999, 200, 201, NULL),
				('sk3', 'pk-ant', 'u1', '古い', 'h3', 'sgk_ghi…rst', NULL, NULL, NULL, 300, 301, 400);
			INSERT INTO usage_events (id, month, created_at, user_id, sigw_key_id, provider_key_id, owner_id, provider, method, path, status, cost_nano_usd)
				VALUES ('e1', '2026-11', 1000, 'u2', 'sk1', 'pk-ant', 'u1', 'anthropic', 'POST', '/v1/messages', 200, 123);
			INSERT INTO agent_sessions (id, user_id, sigw_key_id, provider_key_id, owner_id, created_at)
				VALUES ('sesn_1', 'u2', 'sk1', 'pk-ant', 'u1', 1000);
		`);
		const before = db.rows(
			"SELECT id, created_by, purpose, token_hash, token_hint, allowed_models, monthly_limit_nano_usd, expires_at, created_at, updated_at, revoked_at FROM sigw_keys ORDER BY id",
		);
		const usageBefore = db.rows("SELECT * FROM usage_events");
		const sessionsBefore = db.rows("SELECT * FROM agent_sessions");

		// 0008 からは列が増えるので、0007 までを流して比べる
		db.migrate({ before: "0008" });

		expect(db.rows("SELECT * FROM sigw_keys ORDER BY id")).toEqual(before);
		expect(
			db.rows(
				"SELECT sigw_key_id, provider, provider_key_id, created_at FROM sigw_key_providers ORDER BY sigw_key_id",
			),
		).toEqual([
			{
				sigw_key_id: "sk1",
				provider: "anthropic",
				provider_key_id: "pk-ant",
				created_at: 100,
			},
			{
				sigw_key_id: "sk2",
				provider: "openrouter",
				provider_key_id: "pk-or",
				created_at: 200,
			},
			{
				sigw_key_id: "sk3",
				provider: "anthropic",
				provider_key_id: "pk-ant",
				created_at: 300,
			},
		]);
		expect(db.rows("SELECT * FROM usage_events")).toEqual(usageBefore);
		expect(db.rows("SELECT * FROM agent_sessions")).toEqual(sessionsBefore);
		expect(
			db
				.rows("PRAGMA table_info(sigw_keys)")
				.map((column) => column.name)
				.includes("provider_key_id"),
		).toBe(false);
		expect(db.rows("PRAGMA foreign_key_check")).toEqual([]);
		expect(
			db.rows(
				"SELECT name FROM sqlite_master WHERE name IN ('sigw_key_providers_move', 'sigw_keys_new', 'sigw_keys_provider_key')",
			),
		).toEqual([]);
		// プロバイダごとに1つまで。ない sigw キーには結び付けられない
		expect(() =>
			db.rows(
				"INSERT INTO sigw_key_providers VALUES ('sk1', 'anthropic', 'pk-ant', 1)",
			),
		).toThrow();
		expect(() =>
			db.rows(
				"INSERT INTO sigw_key_providers VALUES ('nope', 'openrouter', 'pk-or', 1)",
			),
		).toThrow();
	});
});

interface Upstream {
	url: string;
	headers: Headers;
}

let upstreamCalls: Upstream[] = [];

beforeEach(() => {
	clearAuthCache();
	upstreamCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit) => {
			upstreamCalls.push({ url, headers: new Headers(init.headers) });
			return Response.json(
				{ model: "m", usage: { input_tokens: 10, output_tokens: 5 } },
				{ headers: { "content-type": "application/json" } },
			);
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** U1 が発行し、Anthropic(U2)と OpenRouter(U3)を結び付けた sigw キー */
async function proxySetup(
	options: { anthropicDelegatedOnly?: boolean; limitNano?: number | null } = {},
) {
	const db = new FakeD1();
	await seedUsers(db);
	await seedProviderKey(db, "pk-ant", U2, "anthropic", {
		delegatedOnly: options.anthropicDelegatedOnly,
	});
	await seedProviderKey(db, "pk-or", U3, "openrouter");
	const now = Date.now();
	db.rows(
		"INSERT INTO sigw_keys (id, created_by, purpose, token_hash, token_hint, monthly_limit_nano_usd, created_at, updated_at) VALUES ('sk', ?, 'いろいろ', ?, 'sgk_aaa…XYZ', ?, ?, ?)",
		U1,
		await sha256Hex(SIGW_TOKEN),
		options.limitNano ?? null,
		now,
		now,
	);
	db.rows(
		"INSERT INTO sigw_key_providers VALUES ('sk', 'anthropic', 'pk-ant', ?), ('sk', 'openrouter', 'pk-or', ?)",
		now,
		now,
	);
	const env = {
		DB: db.asD1(),
		KEY_ENCRYPTION_SECRET: SECRET,
	} as unknown as Env;
	return { db, env };
}

const PATHS: Record<string, string> = {
	anthropic: "/v1/messages",
	openrouter: "/api/v1/chat/completions",
	openai: "/v1/chat/completions",
};

async function callPublic(env: Env, provider: ProviderSpec) {
	const { ctx, settle } = fakeCtx();
	const response = await handleProxy(
		new Request(`https://sigw/${provider.id}${PATHS[provider.id]}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${SIGW_TOKEN}.${PERSONAL_TOKEN}`,
			},
			body: JSON.stringify({ model: "m" }),
		}),
		env,
		ctx,
		provider,
		PATHS[provider.id] ?? "/",
		"",
	);
	await settle();
	return response;
}

describe("中継でのプロバイダキーの選び方", () => {
	it("パスのプロバイダに結び付いたプロバイダキーを使い、その持ち主で記録する", async () => {
		const { db, env } = await proxySetup();
		expect((await callPublic(env, PROVIDERS.anthropic)).status).toBe(200);
		expect((await callPublic(env, PROVIDERS.openrouter)).status).toBe(200);

		expect(upstreamCalls.map((call) => call.url)).toEqual([
			"https://api.anthropic.com/v1/messages",
			"https://openrouter.ai/api/v1/chat/completions",
		]);
		expect(upstreamCalls[0]?.headers.get("x-api-key")).toBe("real-pk-ant");
		expect(upstreamCalls[1]?.headers.get("authorization")).toBe(
			"Bearer real-pk-or",
		);
		expect(
			db.rows(
				"SELECT provider, provider_key_id, owner_id, sigw_key_id, user_id FROM usage_events ORDER BY provider",
			),
		).toEqual([
			{
				provider: "anthropic",
				provider_key_id: "pk-ant",
				owner_id: U2,
				sigw_key_id: "sk",
				user_id: U1,
			},
			{
				provider: "openrouter",
				provider_key_id: "pk-or",
				owner_id: U3,
				sigw_key_id: "sk",
				user_id: U1,
			},
		]);
	});

	it("結び付いていないプロバイダは 400 で断り、呼べるプロバイダを伝える", async () => {
		const { env } = await proxySetup();
		const response = await callPublic(env, PROVIDERS.openai);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { message: string } };
		expect(body.error.message).toContain("OpenAI");
		expect(body.error.message).toContain("/anthropic、/openrouter");
		expect(upstreamCalls).toHaveLength(0);
	});

	it("月の上限額は、全プロバイダの合計で数える", async () => {
		const { db, env } = await proxySetup({ limitNano: 1000 });
		db.rows(
			"INSERT INTO usage_events (id, month, created_at, user_id, sigw_key_id, provider_key_id, owner_id, provider, method, path, status, cost_nano_usd) VALUES ('e1', ?, ?, ?, 'sk', 'pk-ant', ?, 'anthropic', 'POST', '/v1/messages', 200, 1000)",
			new Intl.DateTimeFormat("sv-SE", {
				timeZone: "Asia/Tokyo",
				year: "numeric",
				month: "2-digit",
			}).format(new Date()),
			Date.now(),
			U1,
			U2,
		);
		expect((await callPublic(env, PROVIDERS.openrouter)).status).toBe(429);
	});

	it("無効にしたプロバイダキーのプロバイダだけを断る", async () => {
		const { db, env } = await proxySetup();
		db.rows("UPDATE provider_keys SET disabled_at = 1 WHERE id = 'pk-or'");
		const refused = await callPublic(env, PROVIDERS.openrouter);
		expect(refused.status).toBe(401);
		const body = (await refused.json()) as { error: { message: string } };
		expect(body.error.message).toContain("OpenRouter");
		expect((await callPublic(env, PROVIDERS.anthropic)).status).toBe(200);
		expect(upstreamCalls).toHaveLength(1);
	});

	it("代理専用のプロバイダキーを使う呼び出しだけを、公開の入口で断る", async () => {
		const { env } = await proxySetup({ anthropicDelegatedOnly: true });
		const refused = await callPublic(env, PROVIDERS.anthropic);
		expect(refused.status).toBe(403);
		expect((await callPublic(env, PROVIDERS.openrouter)).status).toBe(200);

		const { ctx, settle } = fakeCtx();
		const delegated = await handleBobertRequest(
			new Request("https://sigw/anthropic/v1/messages", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-api-key": SIGW_TOKEN,
					"x-sigw-user": U2,
				},
				body: JSON.stringify({ model: "m" }),
			}),
			env,
			ctx,
		);
		await settle();
		expect(delegated.status).toBe(200);
		expect(upstreamCalls.map((call) => call.url)).toEqual([
			"https://openrouter.ai/api/v1/chat/completions",
			"https://api.anthropic.com/v1/messages",
		]);
	});
});

describe("sigw キーの API キーの登録・差し替え・外す(API)", () => {
	async function apiSetup() {
		const db = new FakeD1();
		await seedUsers(db);
		const env = {
			DB: db.asD1(),
			KEY_ENCRYPTION_SECRET: SECRET,
			ALLOWED_DISCORD_IDS: [U1, U2, U3].join(","),
		} as unknown as Env;
		const tokens: Record<string, string> = {
			[U1]: await createSession(env.DB, U1, "cli"),
			[U2]: await createSession(env.DB, U2, "cli"),
			[U3]: await createSession(env.DB, U3, "cli"),
		};
		const call = async (
			user: string,
			method: string,
			path: string,
			body?: unknown,
		) => {
			const response = await handleApi(
				new Request(`https://portal/api${path}`, {
					method,
					headers: {
						authorization: `Bearer ${tokens[user]}`,
						...(body === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				}),
				env,
				fakeCtx().ctx,
			);
			return {
				status: response.status,
				text: await response.clone().text(),
				body: (await response.json()) as Record<string, unknown>,
			};
		};
		const settings = {
			purpose: "Bobert",
			allowedModels: null,
			monthlyLimitUsd: null,
			expiresOn: null,
		};
		/** U1 が、Anthropic の API キーだけを入れて発行した sigw キー */
		const issue = async () => {
			const created = await call(U1, "POST", "/sigw-keys", {
				...settings,
				apiKeys: [{ provider: "anthropic", apiKey: "sk-ant-first-AAAA" }],
			});
			expect(created.status).toBe(200);
			return {
				id: String(created.body.id),
				token: String(created.body.token),
			};
		};
		const get = async (user: string, id: string) =>
			(await call(user, "GET", `/sigw-keys/${id}`))
				.body as unknown as SigwKeyJson;
		const decrypt = async (providerKeyId: string) => {
			const [row] = db.rows(
				"SELECT encrypted_key FROM provider_keys WHERE id = ?",
				providerKeyId,
			);
			return decryptText(SECRET, String(row?.encrypted_key));
		};
		return { db, env, call, settings, issue, get, decrypt };
	}

	it("発行のときに、プロバイダごとに API キーを登録する。発行した人が所有者になり、キーの中身は返さない", async () => {
		const { db, call, settings, get, decrypt } = await apiSetup();
		const created = await call(U1, "POST", "/sigw-keys", {
			...settings,
			apiKeys: [
				{ provider: "openrouter", apiKey: "sk-or-secret-WXYZ" },
				{
					provider: "anthropic",
					apiKey: "  sk-ant-secret-abcd  ",
					delegatedOnly: true,
				},
			],
		});
		expect(created.status).toBe(200);
		const id = String(created.body.id);
		const key = await get(U1, id);
		// プロバイダの並びの順。末尾4文字と登録した人だけを返す
		expect(
			key.providerKeys.map((item) => [
				item.provider,
				item.keyLast4,
				item.ownerName,
				item.delegatedOnly,
				item.disabled,
			]),
		).toEqual([
			["anthropic", "abcd", "U1", true, false],
			["openrouter", "WXYZ", "U1", false, false],
		]);
		expect(key.editable).toBe(true);
		const listed = await call(U1, "GET", "/sigw-keys");
		expect(listed.text).not.toContain("secret");
		expect((await call(U1, "GET", `/sigw-keys/${id}`)).text).not.toContain(
			"secret",
		);
		// プロバイダキーの行は、sigw キーの目的を名前にして、暗号化して保存する
		const rows = db.rows(
			"SELECT id, owner_id, provider, label, key_hint, delegated_only FROM provider_keys ORDER BY provider",
		);
		expect(
			rows.map((row) => [
				row.provider,
				row.owner_id,
				row.label,
				row.key_hint,
				row.delegated_only,
			]),
		).toEqual([
			["anthropic", U1, "Bobert", "…abcd", 1],
			["openrouter", U1, "Bobert", "…WXYZ", 0],
		]);
		expect(await decrypt(String(rows[0]?.id))).toBe("sk-ant-secret-abcd");
	});

	it("発行のときの API キーは、プロバイダごとに1つまで。0個でも発行できる。前の CLI の形は断る", async () => {
		const { db, call, settings, get } = await apiSetup();
		const twoAnthropic = await call(U1, "POST", "/sigw-keys", {
			...settings,
			apiKeys: [
				{ provider: "anthropic", apiKey: "sk-ant-1-aaaaaa" },
				{ provider: "anthropic", apiKey: "sk-ant-2-bbbbbb" },
			],
		});
		expect(twoAnthropic.status).toBe(400);
		const unknown = await call(U1, "POST", "/sigw-keys", {
			...settings,
			apiKeys: [{ provider: "gemini", apiKey: "sk-gem-aaaaaaaa" }],
		});
		expect(unknown.status).toBe(400);
		const short = await call(U1, "POST", "/sigw-keys", {
			...settings,
			apiKeys: [{ provider: "anthropic", apiKey: "short" }],
		});
		expect(short.status).toBe(400);
		expect(db.rows("SELECT COUNT(*) AS n FROM sigw_keys")).toEqual([{ n: 0 }]);
		expect(db.rows("SELECT COUNT(*) AS n FROM provider_keys")).toEqual([
			{ n: 0 },
		]);

		// CLI(sigw keys create)は API キーなしで発行し、あとで set-provider で登録する
		const empty = await call(U1, "POST", "/sigw-keys", settings);
		expect(empty.status).toBe(200);
		expect((await get(U1, String(empty.body.id))).providerKeys).toEqual([]);

		const legacy = await call(U1, "POST", "/sigw-keys", {
			...settings,
			providerKeyIds: ["pk-ant"],
		});
		expect(legacy.status).toBe(400);
	});

	it("プロバイダキーの API(/provider-keys)と、前の足し外しの API はなくなった", async () => {
		const { call, issue } = await apiSetup();
		const { id } = await issue();
		expect((await call(U1, "GET", "/provider-keys")).status).toBe(404);
		expect(
			(
				await call(U1, "POST", "/provider-keys", {
					provider: "anthropic",
					apiKey: "sk-ant-xxxxxxxx",
				})
			).status,
		).toBe(404);
		expect(
			(
				await call(U1, "POST", `/sigw-keys/${id}/provider-keys`, {
					providerKeyId: "x",
				})
			).status,
		).toBe(404);
	});

	it("登録していないプロバイダに登録すると、登録した人が所有者になる", async () => {
		const { db, call, issue, get, decrypt } = await apiSetup();
		const { id } = await issue();
		const put = (user: string, provider: string, body: unknown) =>
			call(user, "PUT", `/sigw-keys/${id}/providers/${provider}`, body);

		// U2 は発行した人でも、API キーを登録した人でもない
		expect(
			(await put(U2, "openrouter", { apiKey: "sk-or-u2-key-0001" })).status,
		).toBe(403);
		expect(
			(await put(U1, "gemini", { apiKey: "sk-gem-aaaaaaaa" })).status,
		).toBe(400);
		expect((await put(U1, "openrouter", { apiKey: "bad key" })).status).toBe(
			400,
		);
		expect(
			(
				await put(U1, "openrouter", {
					apiKey: "sk-or-u1-key-0002",
					delegatedOnly: true,
				})
			).status,
		).toBe(200);
		const key = await get(U1, id);
		const openrouter = key.providerKeys.find(
			(item) => item.provider === "openrouter",
		);
		expect(openrouter).toMatchObject({
			keyLast4: "0002",
			ownerId: U1,
			delegatedOnly: true,
		});
		expect(await decrypt(String(openrouter?.id))).toBe("sk-or-u1-key-0002");
		expect(
			db.rows(
				"SELECT COUNT(*) AS n FROM provider_keys WHERE deleted_at IS NULL",
			),
		).toEqual([{ n: 2 }]);
	});

	it("差し替えると、新しいキーを結び付け、前のキーは外して削除する", async () => {
		const { db, call, issue, get } = await apiSetup();
		const { id } = await issue();
		const before = (await get(U1, id)).providerKeys[0];
		expect(
			(
				await call(U1, "PUT", `/sigw-keys/${id}/providers/anthropic`, {
					apiKey: "sk-ant-second-BBBB",
				})
			).status,
		).toBe(200);
		const after = (await get(U1, id)).providerKeys;
		expect(after).toHaveLength(1);
		expect(after[0]?.keyLast4).toBe("BBBB");
		expect(after[0]?.id).not.toBe(before?.id);

		const [old] = db.rows(
			"SELECT encrypted_key, key_hint, disabled_at, deleted_at FROM provider_keys WHERE id = ?",
			before?.id,
		);
		expect(old).toMatchObject({ encrypted_key: "", key_hint: "…AAAA" });
		expect(old?.disabled_at).not.toBeNull();
		expect(old?.deleted_at).not.toBeNull();
	});

	it("外すと、外したキーを削除する。登録していなければ何もしない。最後の1つも外せる", async () => {
		const { db, call, issue, get } = await apiSetup();
		const { id } = await issue();
		const providerKeyId = (await get(U1, id)).providerKeys[0]?.id;
		const remove = (user: string, provider: string) =>
			call(user, "DELETE", `/sigw-keys/${id}/providers/${provider}`);

		expect((await remove(U2, "anthropic")).status).toBe(403);
		expect((await remove(U1, "openrouter")).status).toBe(200);
		expect((await remove(U1, "anthropic")).status).toBe(200);
		const key = await get(U1, id);
		expect(key.providerKeys).toEqual([]);
		expect(
			db.rows(
				"SELECT encrypted_key, deleted_at IS NOT NULL AS deleted FROM provider_keys WHERE id = ?",
				providerKeyId,
			),
		).toEqual([{ encrypted_key: "", deleted: 1 }]);
		expect(db.rows("SELECT COUNT(*) AS n FROM sigw_key_providers")).toEqual([
			{ n: 0 },
		]);
		// 外したあとも、sigw キーは発行した人が変えられる
		expect((await get(U1, id)).editable).toBe(true);
	});

	it("変えられるのは、発行した人と、API キーを登録した人", async () => {
		const { call, issue, get, settings } = await apiSetup();
		const { id } = await issue();
		const patch = (user: string) =>
			call(user, "PATCH", `/sigw-keys/${id}`, { ...settings, purpose: "新" });
		expect((await patch(U2)).status).toBe(403);
		expect((await get(U2, id)).editable).toBe(false);

		// U1 が、U2 から受け取ったキーを登録しても、所有者は U1。U2 は変えられないまま
		await call(U1, "PUT", `/sigw-keys/${id}/providers/openai`, {
			apiKey: "sk-openai-xxxxxxxx",
		});
		expect((await patch(U2)).status).toBe(403);

		// U2 は、API キーの登録もできない
		expect(
			(
				await call(U2, "PUT", `/sigw-keys/${id}/providers/xai`, {
					apiKey: "sk-xai-xxxxxxxx",
				})
			).status,
		).toBe(403);
	});

	it("API キーを登録した人(発行した人でない)は、ほかのキーも登録・差し替え・外すことができる", async () => {
		const { db, call, issue, get } = await apiSetup();
		const { id } = await issue();
		// 0009 より前のデータのように、U2 のキーが結び付いている
		await seedProviderKey(db, "pk-u2", U2, "openrouter");
		db.rows(
			"INSERT INTO sigw_key_providers VALUES (?, 'openrouter', 'pk-u2', 1)",
			id,
		);
		expect((await get(U2, id)).editable).toBe(true);
		expect(
			(
				await call(U2, "PUT", `/sigw-keys/${id}/providers/anthropic`, {
					apiKey: "sk-ant-by-u2-CCCC",
				})
			).status,
		).toBe(200);
		expect(
			(await call(U2, "DELETE", `/sigw-keys/${id}/providers/openrouter`))
				.status,
		).toBe(200);
		const key = await get(U1, id);
		expect(
			key.providerKeys.map((item) => [item.provider, item.ownerId]),
		).toEqual([["anthropic", U2]]);
		// U3 は関わっていない
		expect(
			(await call(U3, "DELETE", `/sigw-keys/${id}/providers/anthropic`)).status,
		).toBe(403);
	});

	it("無効にした sigw キーには、登録も差し替えも外すこともできない", async () => {
		const { call, issue } = await apiSetup();
		const { id } = await issue();
		expect((await call(U1, "DELETE", `/sigw-keys/${id}`)).status).toBe(200);
		expect(
			(
				await call(U1, "PUT", `/sigw-keys/${id}/providers/openai`, {
					apiKey: "sk-openai-xxxxxxxx",
				})
			).status,
		).toBe(400);
		expect(
			(await call(U1, "DELETE", `/sigw-keys/${id}/providers/anthropic`)).status,
		).toBe(400);
		expect(
			(
				await call(U1, "PUT", "/sigw-keys/nope/providers/openai", {
					apiKey: "sk-openai-xxxxxxxx",
				})
			).status,
		).toBe(404);
	});

	it("差し替えたキーは、キャッシュを読み直すと中継で使われ、前のキーはもう使われない", async () => {
		const { db, env, call, issue } = await apiSetup();
		db.rows(
			"UPDATE users SET personal_token_hash = ? WHERE id = ?",
			await sha256Hex(PERSONAL_TOKEN),
			U1,
		);
		const { id, token } = await issue();
		const send = async () => {
			const { ctx, settle } = fakeCtx();
			const response = await handleProxy(
				new Request("https://sigw/anthropic/v1/messages", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}.${PERSONAL_TOKEN}`,
					},
					body: JSON.stringify({ model: "m" }),
				}),
				env,
				ctx,
				PROVIDERS.anthropic,
				"/v1/messages",
				"",
			);
			await settle();
			return response;
		};
		expect((await send()).status).toBe(200);
		await call(U1, "PUT", `/sigw-keys/${id}/providers/anthropic`, {
			apiKey: "sk-ant-second-BBBB",
		});
		clearAuthCache();
		expect((await send()).status).toBe(200);
		expect(upstreamCalls.map((item) => item.headers.get("x-api-key"))).toEqual([
			"sk-ant-first-AAAA",
			"sk-ant-second-BBBB",
		]);

		await call(U1, "DELETE", `/sigw-keys/${id}/providers/anthropic`);
		clearAuthCache();
		expect((await send()).status).toBe(400);
		expect(upstreamCalls).toHaveLength(2);
		// 使用量は、それぞれのキーの所有者で記録している
		expect(
			db.rows("SELECT owner_id FROM usage_events").map((row) => row.owner_id),
		).toEqual([U1, U1]);
	});
});

describe("BobertGateway の GET /sigw/key", () => {
	async function keySetup() {
		const db = new FakeD1();
		await seedUsers(db);
		await seedProviderKey(db, "pk-ts", U2, "typesafe");
		await seedProviderKey(db, "pk-or", U3, "openrouter");
		await seedProviderKey(db, "pk-ant", U2, "anthropic", {
			delegatedOnly: true,
		});
		await seedProviderKey(db, "pk-oai", U3, "openai", { disabled: true });
		const now = Date.now();
		db.rows(
			"INSERT INTO sigw_keys (id, created_by, purpose, token_hash, token_hint, created_at, updated_at) VALUES ('sk', ?, 'Bobert', ?, 'sgk_aaa…XYZ', ?, ?)",
			U1,
			await sha256Hex(SIGW_TOKEN),
			now,
			now,
		);
		db.rows(
			"INSERT INTO sigw_key_providers VALUES ('sk', 'typesafe', 'pk-ts', ?), ('sk', 'openrouter', 'pk-or', ?), ('sk', 'anthropic', 'pk-ant', ?), ('sk', 'openai', 'pk-oai', ?)",
			now,
			now,
			now,
			now,
		);
		const env = {
			DB: db.asD1(),
			KEY_ENCRYPTION_SECRET: SECRET,
		} as unknown as Env;
		const get = (headers: Record<string, string>, method = "GET") =>
			handleBobertRequest(
				new Request("https://sigw/sigw/key", { method, headers }),
				env,
				fakeCtx().ctx,
			);
		return { db, get };
	}

	it("末尾4文字と、呼べるプロバイダ(無効なキーを除き、決まった順)を返す", async () => {
		const { get } = await keySetup();
		const variants: Record<string, string>[] = [
			{ "x-api-key": SIGW_TOKEN },
			{ authorization: `Bearer ${SIGW_TOKEN}` },
			{ "x-api-key": SIGW_TOKEN, "x-sigw-user": U2 },
		];
		for (const headers of variants) {
			const response = await get(headers);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				last4: "WXYZ",
				providers: ["anthropic", "openrouter", "typesafe"],
			});
		}
		expect(upstreamCalls).toHaveLength(0);
	});

	it("プロバイダキーの中身は返さない", async () => {
		const { get } = await keySetup();
		const text = await (await get({ "x-api-key": SIGW_TOKEN })).text();
		expect(text).not.toContain("real-");
		expect(text).not.toContain("…real");
	});

	it("無効・期限切れ・ない sigw キーと、メンバーでない x-sigw-user は 401", async () => {
		const { db, get } = await keySetup();
		const expectAuthError = async (response: Response) => {
			expect(response.status).toBe(401);
			const body = (await response.json()) as {
				error: { type: string; message: string };
			};
			expect(body.error.type).toBe("authentication_error");
			expect(body.error.message.startsWith("[sigw] ")).toBe(true);
		};
		await expectAuthError(await get({}));
		await expectAuthError(
			await get({ "x-api-key": "sgk_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }),
		);
		await expectAuthError(
			await get({ "x-api-key": SIGW_TOKEN, "x-sigw-user": "999" }),
		);
		await expectAuthError(
			await get({ "x-api-key": SIGW_TOKEN, "x-sigw-user": "alice" }),
		);
		db.rows("UPDATE sigw_keys SET expires_at = 1");
		await expectAuthError(await get({ "x-api-key": SIGW_TOKEN }));
		db.rows("UPDATE sigw_keys SET expires_at = NULL, revoked_at = 1");
		await expectAuthError(await get({ "x-api-key": SIGW_TOKEN }));
	});

	it("GET のほかは受け付けない", async () => {
		const { get } = await keySetup();
		expect((await get({ "x-api-key": SIGW_TOKEN }, "POST")).status).toBe(405);
	});
});

// src/index.ts を Node.js で読むため、Workers の実行環境にしかないものを差し替える
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("../src/web/cli-dist.ts", () => ({ handleCliHost: vi.fn() }));

describe("公開の入口の /sigw/key", () => {
	it("どのホストでも 404 にする(Web UI の画面も返さない)", async () => {
		const { default: worker } = await import("../src/index.ts");
		const assets = vi.fn(async () => new Response("<html>"));
		for (const host of ["si.sigw.4rtofl.org", "portal.sigw.4rtofl.org"]) {
			const response = await worker.fetch(
				new Request(`https://${host}/sigw/key`, {
					headers: { "x-api-key": SIGW_TOKEN },
				}) as Request<unknown, IncomingRequestCfProperties>,
				{
					DB: new FakeD1().asD1(),
					PROXY_HOST: "si.sigw.4rtofl.org",
					ASSETS: { fetch: assets },
				} as unknown as Env,
				fakeCtx().ctx,
			);
			expect(response.status).toBe(404);
		}
		expect(assets).not.toHaveBeenCalled();
	});
});
