import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptText, sha256Hex } from "../src/lib/crypto.ts";
import {
	clearAuthCache,
	parseDelegatedSigwToken,
	parseDelegatedUser,
} from "../src/proxy/auth.ts";
import { handleBobertRequest } from "../src/proxy/bobert.ts";
import { handleProxy } from "../src/proxy/handler.ts";
import { PROVIDERS } from "../src/proxy/providers.ts";

const SECRET = "test-secret";
const SIGW_TOKEN = "sgk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PERSONAL_TOKEN = "sgu_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MEMBER = "1148088717907595324";
const OTHER_MEMBER = "687896063545180253";
const PROVIDER_API_KEY = "sk-ant-real-provider-key";

interface Insert {
	sql: string;
	args: unknown[];
}

/**
 * 中継が使う問い合わせだけに答える、D1 の代わり。
 * 認証の読み取り(sigw キー、利用者、今月の使用額)、単価表、使用量の書き込みを扱う
 */
async function fakeDb(options: { delegatedOnly: boolean }) {
	const sigwHash = await sha256Hex(SIGW_TOKEN);
	const personalHash = await sha256Hex(PERSONAL_TOKEN);
	const keyRow = {
		id: "key-1",
		purpose: "Bobert",
		provider_key_id: "pk-1",
		allowed_models: null,
		monthly_limit_nano_usd: null,
		expires_at: null,
		revoked_at: null,
		provider: "anthropic",
		owner_id: OTHER_MEMBER,
		encrypted_key: await encryptText(SECRET, PROVIDER_API_KEY),
		disabled_at: null,
		delegated_only: options.delegatedOnly ? 1 : 0,
	};
	const users = [
		{ id: MEMBER, personal_token_hash: personalHash },
		{ id: OTHER_MEMBER, personal_token_hash: null },
	];
	const inserts: Insert[] = [];
	const answer = (sql: string, args: unknown[]): unknown[] => {
		if (sql.includes("FROM sigw_keys s JOIN provider_keys p")) {
			return args[0] === sigwHash ? [keyRow] : [];
		}
		if (sql.includes("FROM users WHERE personal_token_hash")) {
			return users
				.filter((user) => user.personal_token_hash === args[0])
				.map(({ id }) => ({ id }));
		}
		if (sql.includes("FROM users WHERE id")) {
			return users
				.filter((user) => user.id === args[0])
				.map(({ id }) => ({ id }));
		}
		if (sql.includes("SUM(cost_nano_usd)")) {
			return [{ cost: 0 }];
		}
		if (sql.includes("FROM model_prices")) {
			return [];
		}
		if (sql.startsWith("INSERT INTO usage_events")) {
			inserts.push({ sql, args });
			return [];
		}
		throw new Error(`想定していない問い合わせ: ${sql}`);
	};
	const prepare = (sql: string) => {
		let args: unknown[] = [];
		const statement = {
			bind(...values: unknown[]) {
				args = values;
				return statement;
			},
			async all() {
				return { results: answer(sql.trim(), args) };
			},
			async first() {
				return answer(sql.trim(), args)[0] ?? null;
			},
			async run() {
				answer(sql.trim(), args);
				return { success: true };
			},
		};
		return statement;
	};
	const db = {
		prepare,
		batch: (statements: { all(): Promise<unknown> }[]) =>
			Promise.all(statements.map((statement) => statement.all())),
		withSession: () => db,
	};
	return { db: db as unknown as D1Database, inserts };
}

function fakeCtx() {
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => pending.push(promise),
		passThroughOnException: () => {},
		props: {},
	} as unknown as ExecutionContext;
	return { ctx, settle: () => Promise.all(pending) };
}

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
				{
					model: "claude-sonnet-4-5",
					usage: { input_tokens: 10, output_tokens: 5 },
				},
				{ headers: { "content-type": "application/json" } },
			);
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function messagesRequest(headers: Record<string, string>): Request {
	return new Request("https://sigw/anthropic/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 16 }),
	});
}

/** 使用量の行の列の値を、列の名前で引く */
function column(insert: Insert, name: string): unknown {
	const columns = insert.sql
		.slice(insert.sql.indexOf("(") + 1, insert.sql.indexOf(")"))
		.split(",")
		.map((part) => part.trim());
	return insert.args[columns.indexOf(name)];
}

describe("BobertGateway", () => {
	it("sigw キーと x-sigw-user で中継し、代理の印を付けて記録する", async () => {
		const { db, inserts } = await fakeDb({ delegatedOnly: true });
		const { ctx, settle } = fakeCtx();
		const response = await handleBobertRequest(
			messagesRequest({ "x-api-key": SIGW_TOKEN, "x-sigw-user": MEMBER }),
			{ DB: db, KEY_ENCRYPTION_SECRET: SECRET } as unknown as Env,
			ctx,
		);
		expect(response.status).toBe(200);
		await settle();

		expect(upstreamCalls).toHaveLength(1);
		const upstream = upstreamCalls[0];
		expect(upstream?.url).toBe("https://api.anthropic.com/v1/messages");
		expect(upstream?.headers.get("x-api-key")).toBe(PROVIDER_API_KEY);
		expect(upstream?.headers.has("x-sigw-user")).toBe(false);

		expect(inserts).toHaveLength(1);
		const insert = inserts[0] as Insert;
		expect(column(insert, "user_id")).toBe(MEMBER);
		expect(column(insert, "via")).toBe("bobert");
	});

	it("Authorization: Bearer の sigw キーも受け付ける", async () => {
		const { db } = await fakeDb({ delegatedOnly: false });
		const { ctx } = fakeCtx();
		const response = await handleBobertRequest(
			messagesRequest({
				authorization: `Bearer ${SIGW_TOKEN}`,
				"x-sigw-user": MEMBER,
			}),
			{ DB: db, KEY_ENCRYPTION_SECRET: SECRET } as unknown as Env,
			ctx,
		);
		expect(response.status).toBe(200);
		expect(upstreamCalls[0]?.headers.has("authorization")).toBe(false);
	});

	it("users にいない ID は、プロバイダの形の 401 で断る", async () => {
		const { db, inserts } = await fakeDb({ delegatedOnly: true });
		const { ctx } = fakeCtx();
		const response = await handleBobertRequest(
			messagesRequest({ "x-api-key": SIGW_TOKEN, "x-sigw-user": "999" }),
			{ DB: db, KEY_ENCRYPTION_SECRET: SECRET } as unknown as Env,
			ctx,
		);
		expect(response.status).toBe(401);
		const body = (await response.json()) as {
			type: string;
			error: { type: string };
		};
		expect(body.type).toBe("error");
		expect(body.error.type).toBe("authentication_error");
		expect(upstreamCalls).toHaveLength(0);
		expect(inserts).toHaveLength(0);
	});

	it("x-sigw-user か sigw キーがなければ断る", async () => {
		const { db } = await fakeDb({ delegatedOnly: true });
		const env = { DB: db, KEY_ENCRYPTION_SECRET: SECRET } as unknown as Env;
		const noUser = await handleBobertRequest(
			messagesRequest({ "x-api-key": SIGW_TOKEN }),
			env,
			fakeCtx().ctx,
		);
		expect(noUser.status).toBe(401);
		const noKey = await handleBobertRequest(
			messagesRequest({ "x-sigw-user": MEMBER }),
			env,
			fakeCtx().ctx,
		);
		expect(noKey.status).toBe(401);
		expect(upstreamCalls).toHaveLength(0);
	});

	it("プロバイダのパスでなければ 404 を返す", async () => {
		const { db } = await fakeDb({ delegatedOnly: true });
		const response = await handleBobertRequest(
			new Request("https://sigw/api/me"),
			{ DB: db, KEY_ENCRYPTION_SECRET: SECRET } as unknown as Env,
			fakeCtx().ctx,
		);
		expect(response.status).toBe(404);
	});
});

describe("公開の入口", () => {
	it("代理専用のプロバイダキーにつながる sigw キーは断る", async () => {
		const { db } = await fakeDb({ delegatedOnly: true });
		const response = await handleProxy(
			messagesRequest({ "x-api-key": `${SIGW_TOKEN}.${PERSONAL_TOKEN}` }),
			{ DB: db, KEY_ENCRYPTION_SECRET: SECRET } as unknown as Env,
			fakeCtx().ctx,
			PROVIDERS.anthropic,
			"/v1/messages",
			"",
		);
		expect(response.status).toBe(403);
		const body = (await response.json()) as { error: { type: string } };
		expect(body.error.type).toBe("permission_error");
		expect(upstreamCalls).toHaveLength(0);
	});

	it("x-sigw-user を無視し、個人トークンの持ち主で記録して、転送もしない", async () => {
		const { db, inserts } = await fakeDb({ delegatedOnly: false });
		const { ctx, settle } = fakeCtx();
		const response = await handleProxy(
			messagesRequest({
				"x-api-key": `${SIGW_TOKEN}.${PERSONAL_TOKEN}`,
				"x-sigw-user": OTHER_MEMBER,
			}),
			{ DB: db, KEY_ENCRYPTION_SECRET: SECRET } as unknown as Env,
			ctx,
			PROVIDERS.anthropic,
			"/v1/messages",
			"",
		);
		expect(response.status).toBe(200);
		await settle();
		expect(upstreamCalls[0]?.headers.has("x-sigw-user")).toBe(false);
		const insert = inserts[0] as Insert;
		expect(column(insert, "user_id")).toBe(MEMBER);
		expect(column(insert, "via")).toBeNull();
	});

	it("sigw キーだけ(個人トークンなし)では、x-sigw-user があっても断る", async () => {
		const { db } = await fakeDb({ delegatedOnly: false });
		const response = await handleProxy(
			messagesRequest({ "x-api-key": SIGW_TOKEN, "x-sigw-user": MEMBER }),
			{ DB: db, KEY_ENCRYPTION_SECRET: SECRET } as unknown as Env,
			fakeCtx().ctx,
			PROVIDERS.anthropic,
			"/v1/messages",
			"",
		);
		expect(response.status).toBe(401);
		expect(upstreamCalls).toHaveLength(0);
	});
});

describe("代理の呼び出しのヘッダー", () => {
	it("sigw キーだけを取り出す", () => {
		expect(
			parseDelegatedSigwToken(new Headers({ "x-api-key": SIGW_TOKEN })),
		).toBe(SIGW_TOKEN);
		expect(
			parseDelegatedSigwToken(
				new Headers({ authorization: `Bearer ${SIGW_TOKEN}` }),
			),
		).toBe(SIGW_TOKEN);
		expect(
			parseDelegatedSigwToken(new Headers({ "x-api-key": PERSONAL_TOKEN })),
		).toBeNull();
	});

	it("x-sigw-user は Discord の ID の形だけを受け付ける", () => {
		expect(parseDelegatedUser(new Headers({ "x-sigw-user": MEMBER }))).toBe(
			MEMBER,
		);
		expect(
			parseDelegatedUser(new Headers({ "x-sigw-user": "alice" })),
		).toBeNull();
		expect(parseDelegatedUser(new Headers())).toBeNull();
	});
});
