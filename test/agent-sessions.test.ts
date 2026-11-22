import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getAgentSession,
	listDueAgentSessions,
	saveSessionUsage,
	TOUCH_GRACE_MS,
	zeroTotals,
} from "../src/db/agent-sessions.ts";
import { encryptText, sha256Hex } from "../src/lib/crypto.ts";
import { clearPriceCache, repriceUnpriced } from "../src/pricing/store.ts";
import {
	diffTotals,
	MANAGED_AGENTS_BETA,
	pollAgentSessions,
	RUNTIME_MODEL,
	readSession,
	runtimeCostNano,
	sessionIdOf,
} from "../src/proxy/agent-sessions.ts";
import { clearAuthCache } from "../src/proxy/auth.ts";
import { handleProxy } from "../src/proxy/handler.ts";
import { PROVIDERS } from "../src/proxy/providers.ts";
import { FakeD1 } from "./fake-d1.ts";

const SECRET = "test-secret";
const ORIGIN = "https://fake-anthropic.test";
const SIGW_TOKEN = "sgk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PERSONAL_TOKEN = "sgu_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MODEL = "claude-opus-5-5";
// USD / トークン
const PRICE = {
	input: 5e-6,
	output: 25e-6,
	cacheRead: 0.5e-6,
	cacheWrite: 6.25e-6,
	cacheWrite1h: 10e-6,
	inputAbove200k: 10e-6,
	outputAbove200k: 50e-6,
};

interface FakeSession {
	status: string;
	usage: Record<string, unknown>;
}

/** 偽の Anthropic。セッションの状態を持ち、受けたリクエストを残す */
class FakeAnthropic {
	sessions = new Map<string, FakeSession>();
	calls: { method: string; path: string; headers: Headers }[] = [];
	nextId = 1;

	body(id: string, session: FakeSession) {
		return {
			type: "session",
			id,
			status: session.status,
			agent: { type: "agent", id: "agent_1", model: { id: MODEL } },
			usage: session.usage,
		};
	}

	fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		this.calls.push({ method, path: url.pathname, headers });
		if (headers.get("x-api-key") !== "sk-ant-real") {
			return Response.json({ type: "error" }, { status: 401 });
		}
		if (method === "POST" && url.pathname === "/v1/sessions") {
			const id = `sesn_${this.nextId++}`;
			const session = { status: "idle", usage: {} };
			this.sessions.set(id, session);
			return Response.json(this.body(id, session));
		}
		const id = sessionIdOf(url.pathname);
		const session = id ? this.sessions.get(id) : undefined;
		if (!id || !session) {
			return Response.json({ type: "error" }, { status: 404 });
		}
		if (method === "GET" && url.pathname === `/v1/sessions/${id}`) {
			return Response.json(this.body(id, session));
		}
		if (method === "DELETE") {
			this.sessions.delete(id);
			return Response.json({ type: "session_deleted", id });
		}
		return Response.json({ ok: true });
	};
}

let db: FakeD1;
let env: Env;
let upstream: FakeAnthropic;
let pending: Promise<unknown>[];
let ctx: ExecutionContext;

async function settle() {
	while (pending.length > 0) {
		await Promise.all(pending.splice(0));
	}
}

async function proxy(method: string, path: string, body?: unknown) {
	const request = new Request(`https://si.sigw.test/anthropic${path}`, {
		method,
		headers: {
			"x-api-key": `${SIGW_TOKEN}.${PERSONAL_TOKEN}`,
			"anthropic-version": "2023-06-01",
			"anthropic-beta": MANAGED_AGENTS_BETA,
			...(body ? { "content-type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const response = await handleProxy(
		request,
		env,
		ctx,
		PROVIDERS.anthropic,
		path,
		"?beta=true",
	);
	const text = await response.text();
	await settle();
	return { status: response.status, text };
}

function sessionEventsRows() {
	return db.rows(
		"SELECT * FROM usage_events WHERE path LIKE '/v1/sessions/%' AND (cost_nano_usd > 0 OR cost_nano_usd IS NULL) ORDER BY model",
	);
}

beforeEach(async () => {
	clearAuthCache();
	clearPriceCache();
	db = new FakeD1();
	upstream = new FakeAnthropic();
	vi.stubGlobal("fetch", upstream.fetch);
	pending = [];
	ctx = {
		waitUntil: (promise: Promise<unknown>) => {
			pending.push(promise);
		},
		passThroughOnException: () => {},
	} as unknown as ExecutionContext;
	env = {
		DB: db.asD1(),
		KEY_ENCRYPTION_SECRET: SECRET,
		UPSTREAM_OVERRIDE: JSON.stringify({ anthropic: ORIGIN }),
	} as unknown as Env;
	const now = Date.now();
	db.rows(
		"INSERT INTO users (id, name, personal_token_hash, created_at, updated_at) VALUES ('user1', 'A', ?, ?, ?), ('owner1', 'B', NULL, ?, ?)",
		await sha256Hex(PERSONAL_TOKEN),
		now,
		now,
		now,
		now,
	);
	db.rows(
		"INSERT INTO provider_keys (id, owner_id, provider, label, encrypted_key, key_hint, created_at) VALUES ('pk1', 'owner1', 'anthropic', 'k', ?, 'real', ?)",
		await encryptText(SECRET, "sk-ant-real"),
		now,
	);
	db.rows(
		"INSERT INTO sigw_keys (id, provider_key_id, created_by, purpose, token_hash, token_hint, created_at, updated_at) VALUES ('sk1', 'pk1', 'user1', 'Bobert', ?, 'aaaa', ?, ?)",
		await sha256Hex(SIGW_TOKEN),
		now,
		now,
	);
	db.rows(
		"INSERT INTO model_prices (provider, model, source, price, updated_at) VALUES ('anthropic', ?, 'manual', ?, ?)",
		MODEL,
		JSON.stringify(PRICE),
		now,
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("セッションの使用量の計算", () => {
	it("GET /v1/sessions/{id} の応答から、累計とモデルを読む", () => {
		const snapshot = readSession({
			type: "session",
			id: "sesn_1",
			status: "running",
			agent: { model: { id: MODEL, effort: "high" } },
			usage: {
				input_tokens: 10,
				output_tokens: 20,
				cache_read_input_tokens: 30,
				cache_creation: {
					ephemeral_5m_input_tokens: 40,
					ephemeral_1h_input_tokens: 50,
				},
				active_seconds: 12.5,
			},
		});
		expect(snapshot).toEqual({
			id: "sesn_1",
			status: "running",
			model: MODEL,
			totals: {
				inputTokens: 10,
				cacheReadTokens: 30,
				cacheWriteTokens: 40,
				cacheWrite1hTokens: 50,
				outputTokens: 20,
				activeSeconds: 12.5,
			},
		});
		expect(readSession({ type: "message" })).toBeNull();
	});

	it("前回との差を出す。累計が減った項目は0にして、前回の値を残す", () => {
		const previous = { ...zeroTotals(), inputTokens: 100, outputTokens: 50 };
		const next = { ...zeroTotals(), inputTokens: 150, outputTokens: 40 };
		expect(diffTotals(previous, next)).toEqual({
			delta: { ...zeroTotals(), inputTokens: 50 },
			totals: { ...zeroTotals(), inputTokens: 150, outputTokens: 50 },
		});
	});

	it("実行時間は1時間あたり $0.08", () => {
		expect(runtimeCostNano(3600)).toBe(80_000_000);
		expect(runtimeCostNano(90)).toBe(2_000_000);
	});
});

describe("POST /v1/sessions の中継", () => {
	it("作ったセッションを、利用者・キー・モデルと一緒に記録する", async () => {
		const { status, text } = await proxy("POST", "/v1/sessions", {
			agent: "agent_1",
			environment_id: "env_1",
		});
		expect(status).toBe(200);
		expect(JSON.parse(text).id).toBe("sesn_1");
		const session = await getAgentSession(env.DB, "sesn_1");
		expect(session).toMatchObject({
			userId: "user1",
			sigwKeyId: "sk1",
			providerKeyId: "pk1",
			ownerId: "owner1",
			model: MODEL,
			anthropicBeta: MANAGED_AGENTS_BETA,
			via: null,
			totals: zeroTotals(),
			endedAt: null,
		});
	});

	it("代理の呼び出しで作ったセッションも記録し、Cron で書く行にも入口を引き継ぐ", async () => {
		const member = "1148088717907595324";
		const now = Date.now();
		db.rows(
			"INSERT INTO users (id, name, personal_token_hash, created_at, updated_at) VALUES (?, 'C', NULL, ?, ?)",
			member,
			now,
			now,
		);
		const request = new Request("https://sigw/anthropic/v1/sessions", {
			method: "POST",
			headers: {
				"x-api-key": SIGW_TOKEN,
				"x-sigw-user": member,
				"anthropic-version": "2023-06-01",
				"anthropic-beta": MANAGED_AGENTS_BETA,
				"content-type": "application/json",
			},
			body: JSON.stringify({ agent: "agent_1" }),
		});
		const response = await handleProxy(
			request,
			env,
			ctx,
			PROVIDERS.anthropic,
			"/v1/sessions",
			"",
			"bobert",
		);
		expect(response.status).toBe(200);
		await response.text();
		await settle();
		expect(await getAgentSession(env.DB, "sesn_1")).toMatchObject({
			userId: member,
			via: "bobert",
		});

		const fake = upstream.sessions.get("sesn_1");
		if (!fake) throw new Error("セッションがない");
		fake.status = "running";
		fake.usage = { input_tokens: 100, active_seconds: 90 };
		await pollAgentSessions(env, ORIGIN);
		const rows = sessionEventsRows();
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row).toMatchObject({
				user_id: member,
				via: "bobert",
				web_search_requests: 0,
			});
		}
	});
});

describe("Cron でセッションを読む", () => {
	it("累計から前回との差を出し、トークンと実行時間の料金を記録する", async () => {
		await proxy("POST", "/v1/sessions", { agent: "agent_1" });
		const fake = upstream.sessions.get("sesn_1");
		if (!fake) throw new Error("セッションがない");
		fake.status = "running";
		fake.usage = {
			input_tokens: 1000,
			output_tokens: 500,
			cache_read_input_tokens: 2000,
			cache_creation: {
				ephemeral_5m_input_tokens: 300,
				ephemeral_1h_input_tokens: 400,
			},
			active_seconds: 90,
		};
		const counts = await pollAgentSessions(env, ORIGIN);
		expect(counts.recorded).toBe(1);
		const poll = upstream.calls.at(-1);
		expect(poll?.method).toBe("GET");
		expect(poll?.headers.get("anthropic-beta")).toBe(MANAGED_AGENTS_BETA);

		let rows = sessionEventsRows();
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			model: MODEL,
			user_id: "user1",
			owner_id: "owner1",
			sigw_key_id: "sk1",
			input_tokens: 1000,
			cache_read_tokens: 2000,
			cache_write_tokens: 300,
			cache_write_1h_tokens: 400,
			output_tokens: 500,
			// 1000×5 + 2000×0.5 + 300×6.25 + 400×10 + 500×25(USD / 100万トークン)
			cost_nano_usd: 24_375_000,
			cost_source: "pricing",
		});
		expect(rows[1]).toMatchObject({
			model: RUNTIME_MODEL,
			cost_nano_usd: 2_000_000,
		});

		// 2回目は、増えた分だけを足す
		fake.usage = {
			...fake.usage,
			input_tokens: 1200,
			active_seconds: 180,
		};
		await pollAgentSessions(env, ORIGIN, Date.now() + 1);
		rows = sessionEventsRows();
		expect(rows).toHaveLength(4);
		const added = rows.filter((row) => row.input_tokens === 200);
		expect(added).toHaveLength(1);
		expect(added[0]?.cost_nano_usd).toBe(1_000_000);
		expect(
			rows
				.filter((row) => row.model === RUNTIME_MODEL)
				.map((row) => row.cost_nano_usd),
		).toEqual([2_000_000, 2_000_000]);
	});

	it("単価がなければ料金を空にし、単価を足したあと長い入力の単価を使わずに計算し直す", async () => {
		db.rows("DELETE FROM model_prices");
		clearPriceCache();
		await proxy("POST", "/v1/sessions", { agent: "agent_1" });
		const fake = upstream.sessions.get("sesn_1");
		if (!fake) throw new Error("セッションがない");
		fake.usage = { input_tokens: 300_000 };
		await pollAgentSessions(env, ORIGIN);
		const unpriced = db.rows(
			"SELECT * FROM usage_events WHERE path = '/v1/sessions/sesn_1'",
		);
		expect(unpriced).toHaveLength(1);
		expect(unpriced[0]).toMatchObject({
			model: MODEL,
			cost_nano_usd: null,
			web_search_requests: 0,
		});

		db.rows(
			"INSERT INTO model_prices (provider, model, source, price, updated_at) VALUES ('anthropic', ?, 'manual', ?, ?)",
			MODEL,
			JSON.stringify(PRICE),
			Date.now(),
		);
		clearPriceCache();
		expect(await repriceUnpriced(env.DB)).toBe(1);
		const [row] = db.rows(
			"SELECT cost_nano_usd, cost_source FROM usage_events WHERE path = '/v1/sessions/sesn_1'",
		);
		// 300,000 × $5 / 100万トークン(20万を超えたときの単価 $10 は使わない)
		expect(row).toEqual({
			cost_nano_usd: 1_500_000_000,
			cost_source: "pricing",
		});
	});

	it("20万トークンを超えても、長い入力の単価は使わない", async () => {
		await proxy("POST", "/v1/sessions", { agent: "agent_1" });
		const fake = upstream.sessions.get("sesn_1");
		if (!fake) throw new Error("セッションがない");
		fake.usage = { input_tokens: 300_000 };
		await pollAgentSessions(env, ORIGIN);
		expect(sessionEventsRows()[0]?.cost_nano_usd).toBe(1_500_000_000);
	});

	it("idle で変化がなく、リクエストもないセッションは読まない。リクエストを中継したら、また読む", async () => {
		// 中継の時刻(Date.now())を進めるため、Date だけを偽にする
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const start = Date.now();
			await proxy("POST", "/v1/sessions", { agent: "agent_1" });
			await pollAgentSessions(env, ORIGIN, start + 1);
			const later = start + TOUCH_GRACE_MS + 60_000;
			await pollAgentSessions(env, ORIGIN, later);
			expect(await listDueAgentSessions(env.DB, later + 300_000, 10)).toEqual(
				[],
			);
			vi.setSystemTime(later + 200_000);
			await proxy("POST", "/v1/sessions/sesn_1/events", { events: [] });
			expect(
				await listDueAgentSessions(env.DB, later + 300_000, 10),
			).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("terminated になったら最後の分を記録して、読むのをやめる。見つからなければ、読むのをやめる", async () => {
		await proxy("POST", "/v1/sessions", { agent: "agent_1" });
		await proxy("POST", "/v1/sessions", { agent: "agent_1" });
		const first = upstream.sessions.get("sesn_1");
		if (!first) throw new Error("セッションがない");
		first.status = "terminated";
		first.usage = { output_tokens: 1000 };
		upstream.sessions.delete("sesn_2");
		const counts = await pollAgentSessions(env, ORIGIN);
		expect(counts).toMatchObject({ terminated: 1, not_found: 1 });
		expect(sessionEventsRows()).toHaveLength(1);
		expect(
			db.rows("SELECT id, end_reason FROM agent_sessions ORDER BY id"),
		).toEqual([
			{ id: "sesn_1", end_reason: "terminated" },
			{ id: "sesn_2", end_reason: "not_found" },
		]);
		expect(await listDueAgentSessions(env.DB, Date.now(), 10)).toEqual([]);
	});

	it("同じ累計を2か所で同時に記録しても、二重に数えない", async () => {
		await proxy("POST", "/v1/sessions", { agent: "agent_1" });
		const session = await getAgentSession(env.DB, "sesn_1");
		if (!session) throw new Error("セッションがない");
		const totals = { ...zeroTotals(), outputTokens: 10 };
		const event = {
			createdAt: Date.now(),
			userId: "user1",
			sigwKeyId: "sk1",
			providerKeyId: "pk1",
			ownerId: "owner1",
			provider: "anthropic",
			method: "GET",
			path: "/v1/sessions/sesn_1",
			model: MODEL,
			stream: false,
			status: 200,
			usage: {
				inputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cacheWrite1hTokens: 0,
				outputTokens: 10,
				webSearchRequests: 0,
			},
			serviceTier: null,
			costNano: 250_000,
			costSource: "pricing" as const,
			incomplete: false,
			ttfbMs: null,
			durationMs: 0,
			upstreamRequestId: null,
			error: null,
			via: null,
		};
		const update = {
			session,
			totals,
			status: "idle",
			polledAt: Date.now(),
			events: [event],
			end: null,
		};
		expect(await saveSessionUsage(env.DB, update)).toBe(true);
		expect(await saveSessionUsage(env.DB, update)).toBe(false);
		expect(sessionEventsRows()).toHaveLength(1);
	});
});

describe("DELETE /v1/sessions/{id} の中継", () => {
	it("削除する前に最後の分を読んで記録し、削除したら読むのをやめる", async () => {
		await proxy("POST", "/v1/sessions", { agent: "agent_1" });
		const fake = upstream.sessions.get("sesn_1");
		if (!fake) throw new Error("セッションがない");
		fake.usage = { input_tokens: 100, active_seconds: 36 };
		upstream.calls = [];
		const { status } = await proxy("DELETE", "/v1/sessions/sesn_1");
		expect(status).toBe(200);
		expect(upstream.calls.map((call) => `${call.method} ${call.path}`)).toEqual(
			["GET /v1/sessions/sesn_1", "DELETE /v1/sessions/sesn_1"],
		);
		const rows = sessionEventsRows();
		expect(
			rows.map((row) => [row.method, row.model, row.cost_nano_usd]),
		).toEqual([
			["DELETE", MODEL, 500_000],
			["DELETE", RUNTIME_MODEL, 800_000],
		]);
		expect(await getAgentSession(env.DB, "sesn_1")).toMatchObject({
			endedAt: expect.any(Number),
		});
		expect(db.rows("SELECT end_reason FROM agent_sessions")).toEqual([
			{ end_reason: "deleted" },
		]);
	});

	it("記録していないセッションなら、そのまま削除を中継する", async () => {
		upstream.sessions.set("sesn_x", { status: "idle", usage: {} });
		const { status } = await proxy("DELETE", "/v1/sessions/sesn_x");
		expect(status).toBe(200);
		expect(upstream.calls.map((call) => call.method)).toEqual(["DELETE"]);
	});
});
