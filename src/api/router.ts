/*
 * JSON API(/api/*)。Web UI は Cookie のセッションで、CLI は CLI トークン(Authorization: Bearer sgc_…)で使う。
 * Cookie で認証したときの書き込み(GET 以外)は、同じサイトから送られたものだけを受け付ける(CSRF 対策)。
 */

import {
	decideCliLogin,
	getCliLogin,
	pollCliLogin,
	startCliLogin,
} from "../db/cli-logins.ts";
import {
	createProviderKey,
	createSigwKey,
	getSigwKey,
	listProviderKeys,
	listSigwKeys,
	revokeSigwKey,
	type SigwKeySettings,
	setProviderKeyEnabled,
	updateSigwKey,
} from "../db/keys.ts";
import {
	createSession,
	deleteCliToken,
	deleteSessionByToken,
	findSessionUser,
	listCliTokens,
} from "../db/sessions.ts";
import { dailyCosts, listUsageEvents, summarizeUsage } from "../db/usage.ts";
import { listUsers, rotatePersonalToken, type User } from "../db/users.ts";
import { AppError, badRequest, notFound } from "../lib/errors.ts";
import { usdToNano } from "../lib/money.ts";
import { endOfJstDate, isMonth, monthOf } from "../lib/time.ts";
import {
	deleteManualPrice,
	listPrices,
	repriceUnpriced,
	setManualPrice,
	syncLiteLlmPrices,
} from "../pricing/store.ts";
import { PROVIDERS } from "../proxy/providers.ts";
import {
	getSettlement,
	listSettlements,
	previewSettlement,
	runSettlement,
	setFxOverride,
} from "../settle/run.ts";
import { allowedIds, sameOrigin, sessionUser } from "../web/auth.ts";
import type {
	CliLoginJson,
	CliLoginPollJson,
	CliLoginStartJson,
	MeJson,
	PriceInput,
	SettlementPreviewJson,
	SigwKeyInput,
	SigwKeyJson,
	UsageOverviewJson,
} from "./types.ts";

interface ApiContext {
	request: Request;
	env: Env;
	ctx: ExecutionContext;
	url: URL;
	user: User;
	params: Record<string, string>;
}

type Handler = (context: ApiContext) => Promise<unknown>;

interface Route {
	method: string;
	pattern: RegExp;
	keys: string[];
	handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler): void {
	const keys: string[] = [];
	const pattern = new RegExp(
		`^${path.replace(/:(\w+)/g, (_, key: string) => {
			keys.push(key);
			return "([^/]+)";
		})}$`,
	);
	routes.push({ method, pattern, keys, handler });
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}

async function body<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		throw badRequest("本文を JSON として読めません");
	}
}

/** API の利用者を決める。CLI トークンか、Cookie のセッション */
async function authenticate(
	request: Request,
	env: Env,
): Promise<{ user: User; viaCookie: boolean } | null> {
	const bearer = request.headers
		.get("authorization")
		?.match(/^Bearer\s+(sgc_\S+)$/i)?.[1];
	if (bearer) {
		const user = await findSessionUser(env.DB, bearer, "cli");
		return user && allowedIds(env).has(user.id)
			? { user, viaCookie: false }
			: null;
	}
	const user = await sessionUser(request, env);
	return user ? { user, viaCookie: true } : null;
}

export async function handleApi(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.slice("/api".length) || "/";
	try {
		const open = await publicRoute(request, env, path);
		if (open) {
			return open;
		}
		const auth = await authenticate(request, env);
		if (!auth) {
			return json({ error: "ログインしてください" }, 401);
		}
		if (auth.viaCookie && request.method !== "GET" && !sameOrigin(request)) {
			return json({ error: "別のサイトからのリクエストは受け付けません" }, 403);
		}
		for (const candidate of routes) {
			if (candidate.method !== request.method) continue;
			const match = candidate.pattern.exec(path);
			if (!match) continue;
			const params: Record<string, string> = {};
			candidate.keys.forEach((key, index) => {
				params[key] = decodeURIComponent(match[index + 1] ?? "");
			});
			const result = await candidate.handler({
				request,
				env,
				ctx,
				url,
				user: auth.user,
				params,
			});
			return result instanceof Response ? result : json(result ?? { ok: true });
		}
		return json({ error: "見つかりません" }, 404);
	} catch (error) {
		if (error instanceof AppError) {
			return json({ error: error.message }, error.status);
		}
		console.error("API でエラーが起きました", error);
		return json(
			{ error: error instanceof Error ? error.message : "内部エラー" },
			500,
		);
	}
}

/**
 * ログインしていなくても呼べる API。CLI のブラウザでのログイン(sigw auth login)の始まりと問い合わせだけ。
 * どちらも Cookie を使わないので、CSRF の心配はない
 */
async function publicRoute(
	request: Request,
	env: Env,
	path: string,
): Promise<Response | null> {
	if (request.method !== "POST") {
		return null;
	}
	if (path === "/cli-login/start") {
		const input = await body<{ clientName?: string }>(request);
		const started = await startCliLogin(
			env.DB,
			String(input.clientName ?? "").trim(),
		);
		const origin = new URL(request.url).origin;
		return json({
			deviceCode: started.deviceCode,
			userCode: started.userCode,
			verificationUrl: `${origin}/cli/login?code=${started.userCode}`,
			expiresAt: started.expiresAt,
			intervalMs: 2000,
		} satisfies CliLoginStartJson);
	}
	if (path === "/cli-login/poll") {
		const input = await body<{ deviceCode?: string }>(request);
		const result = await pollCliLogin(env.DB, String(input.deviceCode ?? ""));
		if (result.status !== "approved") {
			return json({ status: result.status } satisfies CliLoginPollJson);
		}
		const user = (await listUsers(env.DB)).find(
			(member) => member.id === result.userId,
		);
		return json({
			status: "approved",
			token: result.token,
			userName: user?.name ?? result.userId,
		} satisfies CliLoginPollJson);
	}
	return null;
}

function isLocal(url: URL): boolean {
	return ["localhost", "127.0.0.1"].includes(url.hostname);
}

function monthParam(url: URL): string {
	const month = url.searchParams.get("month") ?? monthOf(Date.now());
	if (!isMonth(month)) {
		throw badRequest("月は「2026-11」の形で指定してください");
	}
	return month;
}

function sigwKeySettings(input: SigwKeyInput): SigwKeySettings {
	const limit = input.monthlyLimitUsd;
	if (
		limit !== null &&
		(typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0)
	) {
		throw badRequest("月の上限額は0より大きい数(USD)にしてください");
	}
	let expiresAt: number | null = null;
	if (input.expiresOn) {
		expiresAt = endOfJstDate(input.expiresOn);
		if (expiresAt === null) {
			throw badRequest("有効期限は「2026-12-31」の形で指定してください");
		}
	}
	const models = (input.allowedModels ?? [])
		.map((model) => String(model).trim())
		.filter((model) => model !== "");
	return {
		purpose: String(input.purpose ?? ""),
		allowedModels: models.length > 0 ? models : null,
		monthlyLimitNano: limit === null ? null : usdToNano(limit),
		expiresAt,
	};
}

// ---- 自分のこと ----

route("GET", "/me", async ({ env, user, url }): Promise<MeJson> => {
	const members = await listUsers(env.DB);
	return {
		user: {
			id: user.id,
			name: user.name,
			avatar: user.avatar,
			personalTokenHint: user.personalTokenHint,
		},
		members: members.map((member) => ({
			id: member.id,
			name: member.name,
			avatar: member.avatar,
		})),
		providers: Object.values(PROVIDERS).map((provider) => ({
			id: provider.id,
			label: provider.label,
			clientBasePath: provider.clientBasePath,
		})),
		// 手元(localhost)では、手元の Worker をそのまま使う
		proxyOrigin:
			env.PROXY_HOST && !isLocal(url)
				? `https://${env.PROXY_HOST}`
				: url.origin,
		cliOrigin: env.CLI_HOST && !isLocal(url) ? `https://${env.CLI_HOST}` : null,
		month: monthOf(Date.now()),
	};
});

route("POST", "/me/personal-token", async ({ env, user }) => ({
	token: await rotatePersonalToken(env.DB, user.id),
}));

route("GET", "/cli-tokens", ({ env, user }) => listCliTokens(env.DB, user.id));

// sigw auth logout。いま使っている CLI トークンを消す
route("DELETE", "/cli-tokens/current", async ({ env, request }) => {
	const bearer = request.headers
		.get("authorization")
		?.match(/^Bearer\s+(sgc_\S+)$/i)?.[1];
	if (!bearer) {
		throw badRequest("CLI トークンで呼んでください");
	}
	await deleteSessionByToken(env.DB, bearer);
});

// ---- CLI のブラウザでのログイン(Web UI の /cli/login から) ----

route(
	"GET",
	"/cli-login/:code",
	async ({ env, params }): Promise<CliLoginJson> => {
		const login = await getCliLogin(env.DB, params.code ?? "");
		if (!login) {
			throw notFound(
				"このコードは期限が切れたか、ありません。ターミナルでやり直してください",
			);
		}
		return login;
	},
);

route("POST", "/cli-login/:code/approve", async ({ env, user, params }) => {
	await decideCliLogin(env.DB, params.code ?? "", user.id, true);
});

route("POST", "/cli-login/:code/deny", async ({ env, user, params }) => {
	await decideCliLogin(env.DB, params.code ?? "", user.id, false);
});

route("POST", "/cli-tokens", async ({ env, user, request }) => {
	const input = await body<{ label?: string }>(request);
	const label =
		String(input.label ?? "")
			.trim()
			.slice(0, 60) || null;
	return { token: await createSession(env.DB, user.id, "cli", label) };
});

route("DELETE", "/cli-tokens/:id", async ({ env, user, params }) => {
	await deleteCliToken(env.DB, user.id, params.id ?? "");
});

// ---- プロバイダキー ----

route("GET", "/provider-keys", ({ env }) => listProviderKeys(env.DB));

route("POST", "/provider-keys", async ({ env, user, request }) => {
	const input = await body<{
		provider?: string;
		label?: string;
		apiKey?: string;
		delegatedOnly?: boolean;
	}>(request);
	const id = await createProviderKey(env.DB, env.KEY_ENCRYPTION_SECRET, {
		ownerId: user.id,
		provider: String(input.provider ?? ""),
		label: String(input.label ?? ""),
		apiKey: String(input.apiKey ?? ""),
		delegatedOnly: input.delegatedOnly === true,
	});
	return { id };
});

route("POST", "/provider-keys/:id/disable", async ({ env, user, params }) => {
	await setProviderKeyEnabled(env.DB, params.id ?? "", user.id, false);
});

route("POST", "/provider-keys/:id/enable", async ({ env, user, params }) => {
	await setProviderKeyEnabled(env.DB, params.id ?? "", user.id, true);
});

// ---- sigw キー ----

async function sigwKeysWithSpend(
	env: Env,
	month: string,
): Promise<SigwKeyJson[]> {
	const [keys, spend] = await Promise.all([
		listSigwKeys(env.DB),
		summarizeUsage(env.DB, month, "key"),
	]);
	const byKey = new Map(spend.map((row) => [row.sigwKeyId, row]));
	return keys.map((key) => ({
		...key,
		monthSpendNano: byKey.get(key.id)?.costNano ?? 0,
		monthRequests: byKey.get(key.id)?.requests ?? 0,
	}));
}

route("GET", "/sigw-keys", ({ env }) =>
	sigwKeysWithSpend(env, monthOf(Date.now())),
);

route("POST", "/sigw-keys", async ({ env, user, request }) => {
	const input = await body<SigwKeyInput>(request);
	if (!input.providerKeyId) {
		throw badRequest("プロバイダキーを選んでください");
	}
	return createSigwKey(env.DB, {
		...sigwKeySettings(input),
		providerKeyId: input.providerKeyId,
		createdBy: user.id,
	});
});

route("GET", "/sigw-keys/:id", async ({ env, params }) => {
	const month = monthOf(Date.now());
	const key = (await sigwKeysWithSpend(env, month)).find(
		(item) => item.id === params.id,
	);
	if (!key) {
		throw notFound("sigw キーが見つかりません");
	}
	return key;
});

route("PATCH", "/sigw-keys/:id", async ({ env, user, params, request }) => {
	const input = await body<SigwKeyInput>(request);
	await updateSigwKey(env.DB, params.id ?? "", user.id, sigwKeySettings(input));
});

route("DELETE", "/sigw-keys/:id", async ({ env, user, params }) => {
	if (!(await getSigwKey(env.DB, params.id ?? ""))) {
		throw notFound("sigw キーが見つかりません");
	}
	await revokeSigwKey(env.DB, params.id ?? "", user.id);
});

// ---- 使用量 ----

route("GET", "/usage", async ({ env, url }): Promise<UsageOverviewJson> => {
	const month = monthParam(url);
	const [pairs, byUser, byKey, byModel, daily] = await Promise.all([
		summarizeUsage(env.DB, month, "user_owner"),
		summarizeUsage(env.DB, month, "user"),
		summarizeUsage(env.DB, month, "key"),
		summarizeUsage(env.DB, month, "model"),
		dailyCosts(env.DB, month),
	]);
	return { month, pairs, byUser, byKey, byModel, daily };
});

route("GET", "/usage/events", ({ env, url }) =>
	listUsageEvents(env.DB, {
		month: url.searchParams.get("month") ?? undefined,
		userId: url.searchParams.get("user") ?? undefined,
		sigwKeyId: url.searchParams.get("key") ?? undefined,
		limit: Number(url.searchParams.get("limit") ?? 50),
	}),
);

// ---- 精算 ----

route("GET", "/settlements", ({ env }) => listSettlements(env.DB));

route(
	"GET",
	"/settlements/:month",
	async ({ env, params }): Promise<SettlementPreviewJson> => {
		const month = params.month ?? "";
		const preview = await previewSettlement(env, month);
		return {
			month: preview.month,
			usdJpy: preview.usdJpy,
			fxSource: preview.fxSource,
			detail: preview.detail,
			settled: preview.settled,
			settleable: !preview.settled && month < monthOf(Date.now()),
		};
	},
);

route("POST", "/settlements/:month", async ({ env, user, params }) =>
	runSettlement(env, params.month ?? "", user.id),
);

route(
	"PUT",
	"/settlements/:month/fx",
	async ({ env, user, params, request }) => {
		const month = params.month ?? "";
		if (await getSettlement(env.DB, month)) {
			throw badRequest(`${month} は精算済みなので、為替レートを変えられません`);
		}
		const input = await body<{ usdJpy: number | null }>(request);
		await setFxOverride(
			env.DB,
			month,
			input.usdJpy === null ? null : Number(input.usdJpy),
			user.id,
		);
	},
);

// ---- 価格 ----

route("GET", "/prices", ({ env, url }) =>
	listPrices(env.DB, {
		provider: url.searchParams.get("provider") ?? undefined,
		query: url.searchParams.get("q") ?? undefined,
		limit: Number(url.searchParams.get("limit") ?? 200),
	}),
);

route("PUT", "/prices", async ({ env, request }) => {
	const input = await body<PriceInput>(request);
	const perToken = (value: number | null | undefined) =>
		value === null || value === undefined
			? undefined
			: Number(value) / 1_000_000;
	await setManualPrice(
		env.DB,
		String(input.provider ?? ""),
		String(input.model ?? ""),
		{
			input: perToken(input.inputPerM) as number,
			output: perToken(input.outputPerM) as number,
			cacheRead: perToken(input.cacheReadPerM),
			cacheWrite: perToken(input.cacheWritePerM),
		},
	);
	return { repriced: await repriceUnpriced(env.DB) };
});

route("DELETE", "/prices", async ({ env, url }) => {
	await deleteManualPrice(
		env.DB,
		url.searchParams.get("provider") ?? "",
		url.searchParams.get("model") ?? "",
	);
});

route("POST", "/prices/sync", async ({ env }) => {
	const synced = await syncLiteLlmPrices(env.DB);
	return { synced, repriced: await repriceUnpriced(env.DB) };
});
