/*
 * 1つの sigw キーに、プロバイダごとにプロバイダキーを結び付ける(migrations/0007、docs/design.md 3.2)。
 * マイグレーションでの移し替え、中継でのプロバイダキーの選び方、発行したあとの足し外し、BobertGateway の GET /sigw/key
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api/router.ts";
import type { SigwKeyJson } from "../src/api/types.ts";
import { createSession } from "../src/db/sessions.ts";
import { encryptText, sha256Hex } from "../src/lib/crypto.ts";
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

describe("sigw キーのプロバイダキーの足し外し(API)", () => {
	async function apiSetup() {
		const db = new FakeD1();
		await seedUsers(db);
		await seedProviderKey(db, "pk-ant", U2, "anthropic");
		await seedProviderKey(db, "pk-ant2", U3, "anthropic");
		await seedProviderKey(db, "pk-ts", U2, "typesafe");
		await seedProviderKey(db, "pk-or", U3, "openrouter");
		await seedProviderKey(db, "pk-oai", U3, "openai");
		await seedProviderKey(db, "pk-xai", U3, "xai", { disabled: true });
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
				body: (await response.json()) as Record<string, unknown>,
			};
		};
		const settings = {
			purpose: "Bobert",
			allowedModels: null,
			monthlyLimitUsd: null,
			expiresOn: null,
		};
		return { db, call, settings };
	}

	it("発行のときに、プロバイダごとに1つずつ結び付ける", async () => {
		const { call, settings } = await apiSetup();
		const created = await call(U1, "POST", "/sigw-keys", {
			...settings,
			providerKeyIds: ["pk-or", "pk-ant"],
		});
		expect(created.status).toBe(200);
		const key = (await call(U1, "GET", `/sigw-keys/${created.body.id}`))
			.body as unknown as SigwKeyJson;
		// プロバイダの並びの順
		expect(key.providerKeys.map((item) => [item.provider, item.id])).toEqual([
			["anthropic", "pk-ant"],
			["openrouter", "pk-or"],
		]);
		expect(key.providerKeys[0]?.ownerName).toBe("U2");

		const twoAnthropic = await call(U1, "POST", "/sigw-keys", {
			...settings,
			providerKeyIds: ["pk-ant", "pk-ant2"],
		});
		expect(twoAnthropic.status).toBe(400);
		const none = await call(U1, "POST", "/sigw-keys", {
			...settings,
			providerKeyIds: [],
		});
		expect(none.status).toBe(400);
		const disabled = await call(U1, "POST", "/sigw-keys", {
			...settings,
			providerKeyIds: ["pk-xai"],
		});
		expect(disabled.status).toBe(400);
		// 前の形(providerKeyId)も受け付ける
		const legacy = await call(U1, "POST", "/sigw-keys", {
			...settings,
			providerKeyId: "pk-oai",
		});
		expect(legacy.status).toBe(200);

		const providerKeys = (await call(U1, "GET", "/provider-keys"))
			.body as unknown as { id: string; activeSigwKeys: number }[];
		expect(
			providerKeys.find((item) => item.id === "pk-ant")?.activeSigwKeys,
		).toBe(1);
	});

	it("発行した人は誰のキーでも、所有者は自分のキーだけを足せる", async () => {
		const { db, call, settings } = await apiSetup();
		const { body } = await call(U1, "POST", "/sigw-keys", {
			...settings,
			providerKeyIds: ["pk-ant"],
		});
		const id = String(body.id);
		const add = (user: string, providerKeyId: string) =>
			call(user, "POST", `/sigw-keys/${id}/provider-keys`, { providerKeyId });

		// U3 は発行した人でも、結び付いたキーの所有者でもない
		expect((await add(U3, "pk-or")).status).toBe(403);
		// U2(Anthropic の所有者)は、ほかの人のキーを足せない
		expect((await add(U2, "pk-or")).status).toBe(403);
		// U2 は自分のキーを足せる
		expect((await add(U2, "pk-ts")).status).toBe(200);
		// 発行した人は、ほかの人のキーを足せる
		expect((await add(U1, "pk-or")).status).toBe(200);
		// 同じプロバイダは1つまで。無効なキーは足せない
		expect((await add(U1, "pk-ant2")).status).toBe(400);
		expect((await add(U1, "pk-xai")).status).toBe(400);
		expect((await add(U1, "pk-nope")).status).toBe(404);
		// U3 は OpenRouter の所有者になったので、自分のキーを足せる
		expect((await add(U3, "pk-oai")).status).toBe(200);

		expect(
			db
				.rows(
					"SELECT provider FROM sigw_key_providers WHERE sigw_key_id = ? ORDER BY provider",
					id,
				)
				.map((row) => row.provider),
		).toEqual(["anthropic", "openai", "openrouter", "typesafe"]);
	});

	it("外せるのは、発行した人と、そのキーの所有者。最後の1つは外せない", async () => {
		const { call, settings } = await apiSetup();
		const { body } = await call(U1, "POST", "/sigw-keys", {
			...settings,
			providerKeyIds: ["pk-ant", "pk-or"],
		});
		const id = String(body.id);
		const remove = (user: string, providerKeyId: string) =>
			call(user, "DELETE", `/sigw-keys/${id}/provider-keys/${providerKeyId}`);

		expect((await remove(U2, "pk-or")).status).toBe(403);
		expect((await remove(U3, "pk-or")).status).toBe(200);
		expect((await remove(U1, "pk-or")).status).toBe(404);
		expect((await remove(U1, "pk-ant")).status).toBe(400);

		await call(U1, "DELETE", `/sigw-keys/${id}`);
		expect(
			(
				await call(U1, "POST", `/sigw-keys/${id}/provider-keys`, {
					providerKeyId: "pk-or",
				})
			).status,
		).toBe(400);
	});

	it("結び付いたどのキーの所有者も、設定を変えられる", async () => {
		const { call, settings } = await apiSetup();
		const { body } = await call(U1, "POST", "/sigw-keys", {
			...settings,
			providerKeyIds: ["pk-ant"],
		});
		const id = String(body.id);
		const patch = (user: string) =>
			call(user, "PATCH", `/sigw-keys/${id}`, { ...settings, purpose: "新" });
		expect((await patch(U3)).status).toBe(403);
		await call(U1, "POST", `/sigw-keys/${id}/provider-keys`, {
			providerKeyId: "pk-or",
		});
		expect((await patch(U3)).status).toBe(200);
	});

	it("足したプロバイダキーは、キャッシュを読み直すと中継で使える", async () => {
		const { db, call, settings } = await apiSetup();
		db.rows(
			"UPDATE users SET personal_token_hash = ? WHERE id = ?",
			await sha256Hex(PERSONAL_TOKEN),
			U1,
		);
		const created = await call(U1, "POST", "/sigw-keys", {
			...settings,
			providerKeyIds: ["pk-ant"],
		});
		const env = {
			DB: db.asD1(),
			KEY_ENCRYPTION_SECRET: SECRET,
		} as unknown as Env;
		const request = () =>
			new Request("https://sigw/openrouter/api/v1/chat/completions", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${created.body.token}.${PERSONAL_TOKEN}`,
				},
				body: JSON.stringify({ model: "m" }),
			});
		const first = await handleProxy(
			request(),
			env,
			fakeCtx().ctx,
			PROVIDERS.openrouter,
			"/api/v1/chat/completions",
			"",
		);
		expect(first.status).toBe(400);
		await call(U1, "POST", `/sigw-keys/${created.body.id}/provider-keys`, {
			providerKeyId: "pk-or",
		});
		clearAuthCache();
		const second = await handleProxy(
			request(),
			env,
			fakeCtx().ctx,
			PROVIDERS.openrouter,
			"/api/v1/chat/completions",
			"",
		);
		expect(second.status).toBe(200);
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
