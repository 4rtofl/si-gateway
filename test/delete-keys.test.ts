/*
 * プロバイダキーと sigw キーの削除(migrations/0008、docs/design.md 3.3)。
 * 秘密の値を消して行を残すこと、一覧から消えること、中継と BobertGateway で使えなくなること、
 * 動いているエージェントのセッションがあると断ること、使用量に名前が残ること
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "../src/api/router.ts";
import type {
	ProviderKeyJson,
	SigwKeyJson,
	UsageOverviewJson,
} from "../src/api/types.ts";
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
const SESSION_MESSAGE =
	"このプロバイダキーで動いているエージェントのセッションがあります。セッションが終わってから削除してください。";

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

beforeEach(() => {
	clearAuthCache();
	upstreamCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			upstreamCalls.push(url);
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
	const call = async (user: string, method: string, path: string) => {
		const response = await handleApi(
			new Request(`https://portal/api${path}`, {
				method,
				headers: { authorization: `Bearer ${tokens[user]}` },
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

describe("プロバイダキーの削除", () => {
	it("所有者だけが削除できる", async () => {
		const { db, call } = await setup();
		const refused = await call(U1, "POST", "/provider-keys/pk-ant/delete");
		expect(refused.status).toBe(403);
		expect(
			db.rows("SELECT deleted_at FROM provider_keys WHERE id = 'pk-ant'"),
		).toEqual([{ deleted_at: null }]);
		expect((await call(U2, "POST", "/provider-keys/nope/delete")).status).toBe(
			404,
		);
	});

	it("暗号化したキーを消し、無効にして、結び付いた sigw キーから外し、一覧から消す", async () => {
		const { db, env, call } = await setup();
		// 削除する前は、Anthropic を呼べる
		expect((await callPublic(env, PROVIDERS.anthropic)).status).toBe(200);
		clearAuthCache();

		expect(
			(await call(U2, "POST", "/provider-keys/pk-ant/delete")).status,
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
		expect(
			db.rows(
				"SELECT provider_key_id FROM sigw_key_providers WHERE sigw_key_id = 'sk'",
			),
		).toEqual([{ provider_key_id: "pk-or" }]);

		const list = (await call(U2, "GET", "/provider-keys"))
			.body as ProviderKeyJson[];
		expect(list.map((key) => key.id)).toEqual(["pk-or"]);
		const key = (await call(U1, "GET", "/sigw-keys/sk")).body as SigwKeyJson;
		expect(key.providerKeys.map((item) => item.id)).toEqual(["pk-or"]);

		// 有効に戻す・もう一度削除する・sigw キーに足すことはできない
		expect(
			(await call(U2, "POST", "/provider-keys/pk-ant/enable")).status,
		).toBe(404);
		expect(
			(await call(U2, "POST", "/provider-keys/pk-ant/delete")).status,
		).toBe(404);

		// 中継では、Anthropic は結び付いていないプロバイダになる。ほかのプロバイダは呼べる
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

	it("動いているエージェントのセッションがあると断り、何も変えない", async () => {
		const { db, call } = await setup();
		db.rows(
			"INSERT INTO agent_sessions (id, user_id, sigw_key_id, provider_key_id, owner_id, created_at) VALUES ('sesn_1', ?, 'sk', 'pk-ant', ?, 1)",
			U1,
			U2,
		);
		const before = db.rows("SELECT * FROM provider_keys WHERE id = 'pk-ant'");

		const refused = await call(U2, "POST", "/provider-keys/pk-ant/delete");
		expect(refused).toEqual({ status: 409, body: { error: SESSION_MESSAGE } });
		expect(db.rows("SELECT * FROM provider_keys WHERE id = 'pk-ant'")).toEqual(
			before,
		);
		expect(
			db.rows(
				"SELECT COUNT(*) AS n FROM sigw_key_providers WHERE provider_key_id = 'pk-ant'",
			),
		).toEqual([{ n: 1 }]);

		// セッションを読み終えたら、削除できる
		db.rows(
			"UPDATE agent_sessions SET ended_at = 2, end_reason = 'terminated'",
		);
		expect(
			(await call(U2, "POST", "/provider-keys/pk-ant/delete")).status,
		).toBe(200);
	});

	it("Cron は、削除したプロバイダキーを復号しない", async () => {
		const { db, env } = await setup();
		db.rows(
			"UPDATE provider_keys SET encrypted_key = '', deleted_at = 1 WHERE id = 'pk-ant'",
		);
		db.rows(
			"INSERT INTO agent_sessions (id, user_id, sigw_key_id, provider_key_id, owner_id, created_at) VALUES ('sesn_1', ?, 'sk', 'pk-ant', ?, 1)",
			U1,
			U2,
		);
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const counts = await pollAgentSessions(env, "https://sigw");
		expect(counts.error).toBe(1);
		expect(upstreamCalls).toEqual([]);
		// 復号に失敗したのではなく、読まなかった
		expect(errors).not.toHaveBeenCalled();
		errors.mockRestore();
	});
});

describe("sigw キーの削除", () => {
	it("発行した人と、結び付いたプロバイダキーの所有者だけが削除できる", async () => {
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
