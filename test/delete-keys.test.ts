/*
 * キーの削除(migrations/0008、0009、docs/design.md 3.3)。
 * 秘密の値を消して行を残すこと、一覧から消えること、中継と BobertGateway で使えなくなること、
 * 動いているエージェントのセッションがあっても断らず、セッションが終わってから Cron が暗号化したキーを消すこと、
 * 使用量に名前が残ること、0009 で結び付いていないプロバイダキーを削除すること
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api/router.ts";
import type { SigwKeyJson, UsageOverviewJson } from "../src/api/types.ts";
import {
	purgeDeletedProviderKeys,
	removeSigwKeyProvider,
	setSigwKeyProvider,
} from "../src/db/keys.ts";
import { createSession } from "../src/db/sessions.ts";
import { encryptText, sha256Hex } from "../src/lib/crypto.ts";
import { monthOf } from "../src/lib/time.ts";
import { pollAgentSessions } from "../src/proxy/agent-sessions.ts";
import { clearAuthCache } from "../src/proxy/auth.ts";
import { handleBobertRequest } from "../src/proxy/bobert.ts";
import { handleProxy } from "../src/proxy/handler.ts";
import { PROVIDERS, type ProviderSpec } from "../src/proxy/providers.ts";
import { FakeD1 } from "./fake-d1.ts";

const SECRET = "test-secret";
const SIGW_TOKEN = "sgk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaWXYZ";
const PERSONAL_TOKEN = "sgu_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
// sigw キーを発行した人(U1)、Anthropic のキーの所有者(U2)、OpenRouter のキーの所有者(U3)、どれにも関わらない人(U4)
const U1 = "100000000000000001";
const U2 = "100000000000000002";
const U3 = "100000000000000003";
const U4 = "100000000000000004";

function fakeCtx() {
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => pending.push(promise),
		passThroughOnException: () => {},
		props: {},
	} as unknown as ExecutionContext;
	return { ctx, settle: () => Promise.all(pending) };
}

let upstreamCalls: string[] = [];
/** 呼び出しごとの、プロバイダに渡したキー(x-api-key か Authorization) */
let upstreamKeys: string[] = [];
/** DELETE /v1/sessions/{id} に返すステータス */
let sessionDeleteStatus = 200;

beforeEach(() => {
	clearAuthCache();
	upstreamCalls = [];
	upstreamKeys = [];
	sessionDeleteStatus = 200;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			upstreamCalls.push(url);
			const headers = new Headers(init?.headers);
			upstreamKeys.push(
				headers.get("x-api-key") ??
					headers.get("authorization")?.replace(/^Bearer /, "") ??
					"",
			);
			// Managed Agents のセッション(GET /v1/sessions/{id})
			const session = url.match(/\/v1\/sessions\/([\w-]+)$/)?.[1];
			if (session && init?.method === "DELETE") {
				return Response.json({}, { status: sessionDeleteStatus });
			}
			if (session) {
				return Response.json({
					type: "session",
					id: session,
					status: "running",
					agent: { model: { id: "claude-sonnet-4-5" } },
					usage: { input_tokens: 100, output_tokens: 10 },
				});
			}
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

/** U1 が発行し、Anthropic(U2)と OpenRouter(U3)を結び付けた sigw キー sk と、使用量1件 */
async function setup() {
	const db = new FakeD1();
	const now = Date.now();
	db.rows(
		"INSERT INTO users (id, name, personal_token_hash, created_at, updated_at) VALUES (?, 'U1', ?, ?, ?), (?, 'U2', NULL, ?, ?), (?, 'U3', NULL, ?, ?), (?, 'U4', NULL, ?, ?)",
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
		U4,
		now,
		now,
	);
	for (const [id, owner, provider] of [
		["pk-ant", U2, "anthropic"],
		["pk-or", U3, "openrouter"],
	] as const) {
		db.rows(
			"INSERT INTO provider_keys (id, owner_id, provider, label, encrypted_key, key_hint, created_at) VALUES (?, ?, ?, ?, ?, '…real', ?)",
			id,
			owner,
			provider,
			`${provider}-key`,
			await encryptText(SECRET, `real-${id}`),
			now,
		);
	}
	db.rows(
		"INSERT INTO sigw_keys (id, created_by, purpose, token_hash, token_hint, created_at, updated_at) VALUES ('sk', ?, '記事要約', ?, 'sgk_aaa…XYZ', ?, ?)",
		U1,
		await sha256Hex(SIGW_TOKEN),
		now,
		now,
	);
	db.rows(
		"INSERT INTO sigw_key_providers VALUES ('sk', 'anthropic', 'pk-ant', ?), ('sk', 'openrouter', 'pk-or', ?)",
		now,
		now,
	);
	db.rows(
		"INSERT INTO usage_events (id, month, created_at, user_id, sigw_key_id, provider_key_id, owner_id, provider, method, path, status, cost_nano_usd) VALUES ('e1', ?, ?, ?, 'sk', 'pk-ant', ?, 'anthropic', 'POST', '/v1/messages', 200, 1000)",
		monthOf(now),
		now,
		U1,
		U2,
	);
	const env = {
		DB: db.asD1(),
		KEY_ENCRYPTION_SECRET: SECRET,
		ALLOWED_DISCORD_IDS: [U1, U2, U3, U4].join(","),
	} as unknown as Env;
	const tokens: Record<string, string> = {};
	for (const user of [U1, U2, U3, U4]) {
		tokens[user] = await createSession(env.DB, user, "cli");
	}
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
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			env,
			fakeCtx().ctx,
		);
		return {
			status: response.status,
			body: (await response.json()) as unknown,
		};
	};
	return { db, env, call };
}

const PATHS: Record<string, string> = {
	anthropic: "/v1/messages",
	openrouter: "/api/v1/chat/completions",
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

async function sigwKeyInfo(env: Env) {
	return handleBobertRequest(
		new Request("https://sigw/sigw/key", {
			headers: { "x-api-key": SIGW_TOKEN },
		}),
		env,
		fakeCtx().ctx,
	);
}

describe("マイグレーション 0008", () => {
	it("deleted_at を足すだけで、今までの行はそのまま残る", () => {
		const db = new FakeD1({ before: "0008" });
		db.sqlite.exec(`
			INSERT INTO users (id, name, created_at, updated_at) VALUES ('u1', 'A', 1, 1);
			INSERT INTO provider_keys (id, owner_id, provider, label, encrypted_key, key_hint, created_at, disabled_at, delegated_only)
				VALUES ('pk', 'u1', 'anthropic', 'main', 'enc', '…aaaa', 10, NULL, 0);
			INSERT INTO sigw_keys (id, created_by, purpose, token_hash, token_hint, created_at, updated_at, revoked_at)
				VALUES ('sk', 'u1', 'Bobert', 'h1', 'sgk_abc…xyz', 100, 101, NULL);
			INSERT INTO sigw_key_providers VALUES ('sk', 'anthropic', 'pk', 100);
		`);
		const providerKeys = db.rows("SELECT * FROM provider_keys");
		const sigwKeys = db.rows("SELECT * FROM sigw_keys");
		const links = db.rows("SELECT * FROM sigw_key_providers");

		db.migrate();

		expect(db.rows("SELECT * FROM provider_keys")).toEqual(
			providerKeys.map((row) => ({ ...row, deleted_at: null })),
		);
		expect(db.rows("SELECT * FROM sigw_keys")).toEqual(
			sigwKeys.map((row) => ({ ...row, deleted_at: null })),
		);
		expect(db.rows("SELECT * FROM sigw_key_providers")).toEqual(links);
		expect(db.rows("PRAGMA foreign_key_check")).toEqual([]);
	});
});

/** pk-ant(Anthropic)で動いている Managed Agents のセッション */
function startSession(db: FakeD1, providerKeyId = "pk-ant", id = "sesn_1") {
	db.rows(
		"INSERT INTO agent_sessions (id, user_id, sigw_key_id, provider_key_id, owner_id, created_at) VALUES (?, ?, 'sk', ?, ?, 1)",
		id,
		U1,
		providerKeyId,
		U2,
	);
}

function providerKeyRow(db: FakeD1, id: string) {
	return db.rows(
		"SELECT encrypted_key <> '' AS has_key, disabled_at IS NOT NULL AS disabled, deleted_at IS NOT NULL AS deleted FROM provider_keys WHERE id = ?",
		id,
	)[0];
}

describe("外した・差し替えた API キーの削除", () => {
	it("外すと、暗号化したキーを消し、無効にして、一覧と中継から消す", async () => {
		const { db, env, call } = await setup();
		expect((await callPublic(env, PROVIDERS.anthropic)).status).toBe(200);
		clearAuthCache();

		expect(
			(await call(U2, "DELETE", "/sigw-keys/sk/providers/anthropic")).status,
		).toBe(200);
		const [row] = db.rows(
			"SELECT label, key_hint, encrypted_key, disabled_at, deleted_at FROM provider_keys WHERE id = 'pk-ant'",
		);
		expect(row).toMatchObject({
			label: "anthropic-key",
			key_hint: "…real",
			encrypted_key: "",
		});
		expect(row?.disabled_at).not.toBeNull();
		expect(row?.deleted_at).not.toBeNull();
		const key = (await call(U1, "GET", "/sigw-keys/sk")).body as SigwKeyJson;
		expect(key.providerKeys.map((item) => item.id)).toEqual(["pk-or"]);

		upstreamCalls = [];
		expect((await callPublic(env, PROVIDERS.anthropic)).status).toBe(400);
		expect((await callPublic(env, PROVIDERS.openrouter)).status).toBe(200);
		expect(upstreamCalls).toEqual([
			"https://openrouter.ai/api/v1/chat/completions",
		]);
		expect(await (await sigwKeyInfo(env)).json()).toMatchObject({
			providers: ["openrouter"],
		});
		// 精算に使う使用量の行は、そのまま残る
		expect(
			db.rows(
				"SELECT provider_key_id, owner_id FROM usage_events WHERE id = 'e1'",
			),
		).toEqual([{ provider_key_id: "pk-ant", owner_id: U2 }]);
	});

	it("動いているセッションがあっても断らない。暗号化したキーはセッションが終わるまで残し、Cron がそのキーで読んでから消す", async () => {
		const { db, env, call } = await setup();
		startSession(db);
		expect(
			(await call(U2, "DELETE", "/sigw-keys/sk/providers/anthropic")).status,
		).toBe(200);
		expect(providerKeyRow(db, "pk-ant")).toEqual({
			has_key: 1,
			disabled: 1,
			deleted: 1,
		});
		expect(
			db.rows(
				"SELECT COUNT(*) AS n FROM sigw_key_providers WHERE provider_key_id = 'pk-ant'",
			),
		).toEqual([{ n: 0 }]);
		// 一覧にも中継にも出ない
		const key = (await call(U1, "GET", "/sigw-keys/sk")).body as SigwKeyJson;
		expect(key.providerKeys.map((item) => item.id)).toEqual(["pk-or"]);
		upstreamCalls = [];
		upstreamKeys = [];
		expect((await callPublic(env, PROVIDERS.anthropic)).status).toBe(400);
		expect(upstreamCalls).toEqual([]);

		// Cron は、削除したキーでセッションを読める
		const counts = await pollAgentSessions(env, "https://api.anthropic.com");
		expect(counts.recorded).toBe(1);
		expect(upstreamKeys).toEqual(["real-pk-ant"]);
		// セッションが動いているあいだは消さない
		expect(await purgeDeletedProviderKeys(env.DB)).toBe(0);
		expect(providerKeyRow(db, "pk-ant")?.has_key).toBe(1);

		db.rows(
			"UPDATE agent_sessions SET ended_at = 2, end_reason = 'terminated'",
		);
		expect(await purgeDeletedProviderKeys(env.DB)).toBe(1);
		expect(providerKeyRow(db, "pk-ant")).toEqual({
			has_key: 0,
			disabled: 1,
			deleted: 1,
		});
		expect(await purgeDeletedProviderKeys(env.DB)).toBe(0);
	});

	it("差し替えたときも、前のキーは同じように扱う", async () => {
		const { db, env, call } = await setup();
		startSession(db);
		expect(
			(
				await call(U1, "PUT", "/sigw-keys/sk/providers/anthropic", {
					apiKey: "sk-ant-new-key-NEW1",
				})
			).status,
		).toBe(200);
		expect(providerKeyRow(db, "pk-ant")).toEqual({
			has_key: 1,
			disabled: 1,
			deleted: 1,
		});
		upstreamKeys = [];
		expect((await callPublic(env, PROVIDERS.anthropic)).status).toBe(200);
		expect(upstreamKeys).toEqual(["sk-ant-new-key-NEW1"]);
		// 新しいキーは U1 のもの。使用量も U1 を所有者として記録する
		expect(
			db.rows("SELECT owner_id FROM usage_events WHERE id <> 'e1'"),
		).toEqual([{ owner_id: U1 }]);

		upstreamKeys = [];
		await pollAgentSessions(env, "https://api.anthropic.com");
		expect(upstreamKeys).toEqual(["real-pk-ant"]);
	});

	it("差し替えたあとのセッションの DELETE は、作ったときのキーで最後の分を読み、別のキーでの 404 では読むのをやめない", async () => {
		const { db, env, call } = await setup();
		startSession(db);
		await call(U1, "PUT", "/sigw-keys/sk/providers/anthropic", {
			apiKey: "sk-ant-new-key-NEW1",
		});
		sessionDeleteStatus = 404;
		upstreamCalls = [];
		upstreamKeys = [];
		const { ctx, settle } = fakeCtx();
		const response = await handleProxy(
			new Request("https://sigw/anthropic/v1/sessions/sesn_1", {
				method: "DELETE",
				headers: {
					authorization: `Bearer ${SIGW_TOKEN}.${PERSONAL_TOKEN}`,
				},
			}),
			env,
			ctx,
			PROVIDERS.anthropic,
			"/v1/sessions/sesn_1",
			"",
		);
		await settle();
		expect(response.status).toBe(404);
		expect(upstreamKeys).toEqual(["real-pk-ant", "sk-ant-new-key-NEW1"]);
		expect(
			db.rows("SELECT ended_at FROM agent_sessions WHERE id = 'sesn_1'"),
		).toEqual([{ ended_at: null }]);
	});

	it("中継は、削除したプロバイダキーを、暗号化したキーが残っていても使わない", async () => {
		const { db, env } = await setup();
		// 結び付きが残っていても、deleted_at があれば使わない
		db.rows("UPDATE provider_keys SET deleted_at = 1 WHERE id = 'pk-ant'");
		expect((await callPublic(env, PROVIDERS.anthropic)).status).toBe(400);
		expect(upstreamCalls).toEqual([]);
		expect(await (await sigwKeyInfo(env)).json()).toMatchObject({
			providers: ["openrouter"],
		});
	});

	it("Cron は、暗号化したキーを消したプロバイダキーを復号しない", async () => {
		const { db, env } = await setup();
		db.rows(
			"UPDATE provider_keys SET encrypted_key = '', deleted_at = 1 WHERE id = 'pk-ant'",
		);
		startSession(db);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const counts = await pollAgentSessions(env, "https://sigw");
		expect(counts.error).toBe(1);
		expect(upstreamCalls).toEqual([]);
		// 復号に失敗したのではなく、読まなかった
		expect(errors).not.toHaveBeenCalled();
		errors.mockRestore();
	});

	it("プロバイダキーの削除の API(/provider-keys/:id/delete)はなくなった", async () => {
		const { db, call } = await setup();
		expect(
			(await call(U2, "POST", "/provider-keys/pk-ant/delete")).status,
		).toBe(404);
		expect(providerKeyRow(db, "pk-ant")?.deleted).toBe(0);
	});
});

describe("sigw キーの削除", () => {
	it("発行した人と、API キーを登録した人だけが削除できる", async () => {
		const { db, call } = await setup();
		expect((await call(U4, "POST", "/sigw-keys/sk/delete")).status).toBe(403);
		expect(db.rows("SELECT deleted_at FROM sigw_keys")).toEqual([
			{ deleted_at: null },
		]);
		expect((await call(U3, "POST", "/sigw-keys/sk/delete")).status).toBe(200);
		expect((await call(U1, "POST", "/sigw-keys/sk/delete")).status).toBe(404);
	});

	it("トークンを使えなくし、無効にして、一覧から消す。目的は残す", async () => {
		const { db, env, call } = await setup();
		expect((await callPublic(env, PROVIDERS.anthropic)).status).toBe(200);
		clearAuthCache();

		expect((await call(U1, "POST", "/sigw-keys/sk/delete")).status).toBe(200);
		const [row] = db.rows(
			"SELECT purpose, token_hash, token_hint, revoked_at, deleted_at FROM sigw_keys WHERE id = 'sk'",
		);
		expect(row).toMatchObject({
			purpose: "記事要約",
			token_hash: "deleted:sk",
			token_hint: "sgk_aaa…XYZ",
		});
		expect(row?.revoked_at).not.toBeNull();
		expect(row?.deleted_at).not.toBeNull();

		expect((await call(U1, "GET", "/sigw-keys")).body).toEqual([]);
		expect((await call(U1, "GET", "/sigw-keys/sk")).status).toBe(404);
		// 前の CLI の無効化(DELETE /sigw-keys/:id)も、削除したキーには使えない
		expect((await call(U1, "DELETE", "/sigw-keys/sk")).status).toBe(404);

		upstreamCalls = [];
		expect((await callPublic(env, PROVIDERS.anthropic)).status).toBe(401);
		expect(upstreamCalls).toEqual([]);
		expect((await sigwKeyInfo(env)).status).toBe(401);
	});

	it("登録した API キーも削除する。動いているセッションのキーは、終わるまで暗号化したキーを残す", async () => {
		const { db, env, call } = await setup();
		startSession(db);
		expect((await call(U1, "POST", "/sigw-keys/sk/delete")).status).toBe(200);
		expect(db.rows("SELECT COUNT(*) AS n FROM sigw_key_providers")).toEqual([
			{ n: 0 },
		]);
		expect(providerKeyRow(db, "pk-ant")).toEqual({
			has_key: 1,
			disabled: 1,
			deleted: 1,
		});
		expect(providerKeyRow(db, "pk-or")).toEqual({
			has_key: 0,
			disabled: 1,
			deleted: 1,
		});
		db.rows("UPDATE agent_sessions SET ended_at = 2, end_reason = 'deleted'");
		expect(await purgeDeletedProviderKeys(env.DB)).toBe(1);
		expect(providerKeyRow(db, "pk-ant")?.has_key).toBe(0);
	});

	it("無効にした sigw キーも削除でき、DELETE /sigw-keys/:id は今までどおり無効にするだけ", async () => {
		const { db, call } = await setup();
		expect((await call(U1, "DELETE", "/sigw-keys/sk")).status).toBe(200);
		expect(
			db.rows(
				"SELECT token_hash = 'deleted:sk' AS gone, deleted_at FROM sigw_keys",
			),
		).toEqual([{ gone: 0, deleted_at: null }]);
		const revokedAt = db.rows("SELECT revoked_at FROM sigw_keys")[0]
			?.revoked_at;

		expect((await call(U1, "POST", "/sigw-keys/sk/delete")).status).toBe(200);
		// 無効にした時刻は変えない
		expect(db.rows("SELECT revoked_at FROM sigw_keys")).toEqual([
			{ revoked_at: revokedAt },
		]);
	});

	it("使用量の画面のために、includeDeleted=1 では削除したキーも返す", async () => {
		const { call } = await setup();
		await call(U1, "POST", "/sigw-keys/sk/delete");

		const keys = (await call(U2, "GET", "/sigw-keys?includeDeleted=1"))
			.body as SigwKeyJson[];
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatchObject({ id: "sk", purpose: "記事要約" });
		expect(keys[0]?.deletedAt).not.toBeNull();

		// 使用量の集計には、削除したキーの行も残る
		const usage = (await call(U2, "GET", "/usage")).body as UsageOverviewJson;
		expect(usage.byKey.map((row) => [row.sigwKeyId, row.costNano])).toEqual([
			["sk", 1000],
		]);
		expect(usage.pairs).toMatchObject([
			{ userId: U1, ownerId: U2, costNano: 1000 },
		]);
	});
});

describe("マイグレーション 0009", () => {
	function seed(db: FakeD1) {
		db.sqlite.exec(`
			INSERT INTO users (id, name, created_at, updated_at) VALUES ('u1', 'A', 1, 1), ('u2', 'B', 1, 1);
			INSERT INTO provider_keys (id, owner_id, provider, label, encrypted_key, key_hint, created_at, disabled_at, delegated_only, deleted_at) VALUES
				('pk-linked', 'u1', 'typesafe', 'main', 'enc-linked', '…aaaa', 10, NULL, 0, NULL),
				('pk-shared', 'u2', 'anthropic', 'main', 'enc-shared', '…bbbb', 10, NULL, 1, NULL),
				('pk-disabled', 'u2', 'openai', 'main', 'enc-disabled', '…cccc', 10, 20, 0, NULL),
				('pk-orphan', 'u1', 'openrouter', 'spare', 'enc-orphan', '…dddd', 10, NULL, 0, NULL),
				('pk-orphan-live', 'u2', 'anthropic', 'agents', 'enc-live', '…eeee', 10, 30, 0, NULL),
				('pk-orphan-ended', 'u2', 'anthropic', 'old', 'enc-ended', '…ffff', 10, NULL, 0, NULL),
				('pk-deleted-sigw', 'u1', 'xai', 'x', 'enc-x', '…gggg', 10, NULL, 0, NULL),
				('pk-already', 'u1', 'xai', 'gone', '', '…hhhh', 10, 5, 0, 5);
			INSERT INTO sigw_keys (id, created_by, purpose, token_hash, token_hint, created_at, updated_at, revoked_at, deleted_at) VALUES
				('sk1', 'u1', 'Bobert', 'h1', 'sgk_a…1', 100, 100, NULL, NULL),
				('sk2', 'u2', 'バッチ', 'h2', 'sgk_a…2', 100, 100, 150, NULL),
				('sk3', 'u1', '消した', 'deleted:sk3', 'sgk_a…3', 100, 100, 160, 160);
			INSERT INTO sigw_key_providers VALUES
				('sk1', 'typesafe', 'pk-linked', 100),
				('sk1', 'anthropic', 'pk-shared', 100),
				('sk2', 'anthropic', 'pk-shared', 100),
				('sk2', 'openai', 'pk-disabled', 100),
				('sk3', 'xai', 'pk-deleted-sigw', 100);
			INSERT INTO agent_sessions (id, user_id, sigw_key_id, provider_key_id, owner_id, created_at, ended_at) VALUES
				('sesn_live', 'u1', 'sk9', 'pk-orphan-live', 'u2', 1, NULL),
				('sesn_ended', 'u1', 'sk9', 'pk-orphan-ended', 'u2', 1, 2);
		`);
	}

	it("どの sigw キーにも結び付いていないプロバイダキーを削除し、動いているセッションのキーだけ暗号化したキーを残す", () => {
		const db = new FakeD1({ before: "0009" });
		seed(db);
		const before = db.rows("SELECT * FROM provider_keys ORDER BY id");
		const startedAt = Date.now();

		db.migrate();

		const after = db.rows("SELECT * FROM provider_keys ORDER BY id");
		const byId = new Map(after.map((row) => [row.id, row]));
		// 結び付いたキーと、すでに削除したキーは、そのまま
		for (const id of ["pk-linked", "pk-shared", "pk-disabled", "pk-already"]) {
			expect(byId.get(id)).toEqual(before.find((row) => row.id === id));
		}
		for (const id of ["pk-orphan", "pk-orphan-ended", "pk-deleted-sigw"]) {
			const row = byId.get(id);
			expect(row?.encrypted_key).toBe("");
			expect(Number(row?.deleted_at)).toBeGreaterThanOrEqual(startedAt - 1000);
			expect(row?.disabled_at).toBe(row?.deleted_at);
			// 名前と末尾4文字は残す
			expect(row?.key_hint).toBe(
				before.find((item) => item.id === id)?.key_hint,
			);
		}
		const live = byId.get("pk-orphan-live");
		expect(live?.encrypted_key).toBe("enc-live");
		expect(live?.deleted_at).not.toBeNull();
		// 前に無効にした時刻は変えない
		expect(live?.disabled_at).toBe(30);

		// 削除した sigw キーの結び付きだけを消す
		expect(
			db.rows(
				"SELECT sigw_key_id, provider FROM sigw_key_providers ORDER BY sigw_key_id, provider",
			),
		).toEqual([
			{ sigw_key_id: "sk1", provider: "anthropic" },
			{ sigw_key_id: "sk1", provider: "typesafe" },
			{ sigw_key_id: "sk2", provider: "anthropic" },
			{ sigw_key_id: "sk2", provider: "openai" },
		]);
		expect(db.rows("SELECT * FROM sigw_keys ORDER BY id")).toHaveLength(3);
		expect(db.rows("PRAGMA foreign_key_check")).toEqual([]);
	});

	it("2つの sigw キーに結び付いたキーは、片方で差し替えたり外したりしても、もう片方に結び付いているあいだは削除しない", async () => {
		const db = new FakeD1({ before: "0009" });
		seed(db);
		db.migrate();
		db.rows("UPDATE sigw_keys SET revoked_at = NULL WHERE id = 'sk2'");
		await setSigwKeyProvider(db.asD1(), SECRET, "sk1", "u1", {
			provider: "anthropic",
			apiKey: "sk-ant-new-key-NEW1",
		});
		expect(providerKeyRow(db, "pk-shared")).toEqual({
			has_key: 1,
			disabled: 0,
			deleted: 0,
		});
		await removeSigwKeyProvider(db.asD1(), "sk2", "u2", "anthropic");
		expect(providerKeyRow(db, "pk-shared")).toEqual({
			has_key: 0,
			disabled: 1,
			deleted: 1,
		});
	});
});
