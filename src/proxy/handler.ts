/*
 * プロバイダへの中継。docs/design.md「4. 中継」
 * 応答の本文は tee() で2つに分け、片方をそのままクライアントに返し、もう片方から使用量を読む。
 * 公開の入口と、Bobert からの代理の呼び出し(BobertGateway)の両方がここを通る。違うのは利用者の決め方だけ。
 */

import { touchAgentSession } from "../db/agent-sessions.ts";
import { insertUsageEvent } from "../db/usage.ts";
import { computeCostNano, findPrice } from "../pricing/cost.ts";
import { loadProviderPrices } from "../pricing/store.ts";
import {
	afterSessionDelete,
	finalizeBeforeDelete,
	isSessionDelete,
	recordCreatedSession,
	sessionIdOf,
} from "./agent-sessions.ts";
import {
	addSpend,
	type Credential,
	DELEGATED_USER_HEADER,
	type KeyInfo,
	parseCredential,
	parseDelegatedSigwToken,
	parseDelegatedUser,
	resolveCredential,
} from "./auth.ts";
import { modelAllowed } from "./models.ts";
import { isBlockedPath, type ProviderSpec } from "./providers.ts";
import {
	collectFromJson,
	collectFromSse,
	emptyUsage,
	type UsageReport,
} from "./usage.ts";

/** プロバイダに転送しないリクエストのヘッダー */
const DROP_REQUEST_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"host",
	"cookie",
	"content-length",
	"accept-encoding",
	"x-real-ip",
	"true-client-ip",
	"cdn-loop",
	"connection",
	"keep-alive",
	"te",
	"upgrade",
	// 代理の呼び出しの利用者。公開の入口に付いていても、無視して転送しない
	DELEGATED_USER_HEADER,
]);

/**
 * 呼び出しが届いた入口。
 * - public: 公開の入口(si.sigw.4rtofl.org など)。sgk_….sgu_… で利用者を決める
 * - bobert: Bobert からの Service Binding(BobertGateway)。sgk_… と x-sigw-user の Discord ID で利用者を決める
 */
export type ProxyEntry = "public" | "bobert";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** プロバイダと同じ形のエラーを返す(SDK がメッセージを表示できるように) */
export function errorResponse(
	provider: ProviderSpec,
	status: number,
	message: string,
	code: string,
): Response {
	const body =
		provider.usageStyle === "anthropic"
			? { type: "error", error: { type: code, message: `[sigw] ${message}` } }
			: { error: { message: `[sigw] ${message}`, type: code, code } };
	return Response.json(body, { status });
}

/**
 * 使用量を受け取れるよう、リクエストの本文に手を入れる。手を入れたら true を返す。
 * - OpenAI・xAI の Chat Completions のストリーミング: stream_options.include_usage
 * - OpenRouter: usage.include(使用量と実費を返してもらう)
 */
export function adjustRequestBody(
	provider: ProviderSpec,
	path: string,
	body: Json,
): boolean {
	const chat =
		path.endsWith("/chat/completions") || path.endsWith("/completions");
	if (!chat) {
		return false;
	}
	if (provider.id === "openrouter") {
		const usage = isObject(body.usage) ? body.usage : {};
		if (usage.include === true) {
			return false;
		}
		body.usage = { ...usage, include: true };
		return true;
	}
	if (provider.usageStyle === "openai" && body.stream === true) {
		const options = isObject(body.stream_options) ? body.stream_options : {};
		if (options.include_usage === true) {
			return false;
		}
		body.stream_options = { ...options, include_usage: true };
		return true;
	}
	return false;
}

interface Prepared {
	body: BodyInit | null;
	model: string | null;
	stream: boolean;
	json: boolean;
}

async function prepareBody(
	request: Request,
	provider: ProviderSpec,
	path: string,
): Promise<Prepared> {
	if (request.method === "GET" || request.method === "HEAD" || !request.body) {
		return { body: null, model: null, stream: false, json: true };
	}
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("json")) {
		return { body: request.body, model: null, stream: false, json: false };
	}
	const text = await request.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { body: text, model: null, stream: false, json: true };
	}
	if (!isObject(parsed)) {
		return { body: text, model: null, stream: false, json: true };
	}
	const model = typeof parsed.model === "string" ? parsed.model : null;
	const stream = parsed.stream === true;
	const changed = adjustRequestBody(provider, path, parsed);
	return {
		body: changed ? JSON.stringify(parsed) : text,
		model,
		stream,
		json: true,
	};
}

function upstreamHeaders(
	request: Request,
	provider: ProviderSpec,
	apiKey: string,
): Headers {
	const headers = new Headers();
	for (const [name, value] of request.headers) {
		if (
			DROP_REQUEST_HEADERS.has(name) ||
			name.startsWith("cf-") ||
			name.startsWith("x-forwarded-")
		) {
			continue;
		}
		headers.set(name, value);
	}
	if (provider.auth === "x-api-key") {
		headers.set("x-api-key", apiKey);
	} else {
		headers.set("authorization", `Bearer ${apiKey}`);
	}
	return headers;
}

/** 転送先のオリジン。UPSTREAM_OVERRIDE(手元での確認用)があれば、そちらを使う */
export function upstreamOrigin(env: Env, provider: ProviderSpec): string {
	if (!env.UPSTREAM_OVERRIDE) {
		return provider.origin;
	}
	try {
		const override = JSON.parse(env.UPSTREAM_OVERRIDE) as Record<
			string,
			string
		>;
		return override[provider.id] ?? provider.origin;
	} catch {
		return provider.origin;
	}
}

/** 入口に合わせて資格情報を取り出す。取り出せなければ、返すエラーの応答 */
function credentialFor(
	request: Request,
	provider: ProviderSpec,
	entry: ProxyEntry,
): Credential | Response {
	if (entry === "public") {
		return (
			parseCredential(request.headers) ??
			errorResponse(
				provider,
				401,
				"API キーには「sigw キー.個人トークン」(sgk_….sgu_…)を入れてください",
				"authentication_error",
			)
		);
	}
	const sigwToken = parseDelegatedSigwToken(request.headers);
	if (!sigwToken) {
		return errorResponse(
			provider,
			401,
			"x-api-key か Authorization に sigw キー(sgk_…)を入れてください",
			"authentication_error",
		);
	}
	const discordId = parseDelegatedUser(request.headers);
	if (!discordId) {
		return errorResponse(
			provider,
			401,
			"x-sigw-user に利用者の Discord ID を入れてください",
			"authentication_error",
		);
	}
	return { sigwToken, discordId };
}

/**
 * 中継のリクエストを処理する。upstreamPath はプロバイダの API のパス(例 /v1/chat/completions)。
 * entry は、呼び出しが届いた入口(公開の入口か、BobertGateway か)
 */
export async function handleProxy(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	provider: ProviderSpec,
	upstreamPath: string,
	search: string,
	entry: ProxyEntry = "public",
): Promise<Response> {
	const startedAt = Date.now();
	const credential = credentialFor(request, provider, entry);
	if (credential instanceof Response) {
		return credential;
	}
	if (isBlockedPath(provider, upstreamPath)) {
		return errorResponse(
			provider,
			403,
			"このエンドポイントは使用量を記録できないため、sigw では使えません",
			"permission_error",
		);
	}
	const resolved = await resolveCredential(env, ctx, credential, startedAt);
	const key = resolved.key;
	if (!key || key.disabled) {
		return errorResponse(
			provider,
			401,
			"sigw キーが無効です",
			"authentication_error",
		);
	}
	if (!resolved.userId) {
		return errorResponse(
			provider,
			401,
			entry === "public"
				? "個人トークンが無効です"
				: "x-sigw-user の利用者は sigw のメンバーではありません",
			"authentication_error",
		);
	}
	// 代理専用のプロバイダキーのワークスペースには、Bobert の利用者ごとの Vault がある。
	// 公開の入口から使えると、ほかの人の Vault を付けたセッションを作れてしまうので断る
	if (key.delegatedOnly && entry !== "bobert") {
		return errorResponse(
			provider,
			403,
			"この sigw キーは、Bobert からの代理の呼び出しでしか使えません",
			"permission_error",
		);
	}
	if (key.provider !== provider.id) {
		return errorResponse(
			provider,
			400,
			`この sigw キーは ${key.provider} 用です。base URL を /${key.provider} にしてください`,
			"invalid_request_error",
		);
	}
	if (key.expiresAt !== null && key.expiresAt <= startedAt) {
		return errorResponse(
			provider,
			401,
			"sigw キーの有効期限が切れています",
			"authentication_error",
		);
	}
	if (
		key.monthlyLimitNano !== null &&
		resolved.monthSpendNano >= key.monthlyLimitNano
	) {
		return errorResponse(
			provider,
			429,
			"sigw キーの今月の上限額に達しました",
			"rate_limit_error",
		);
	}

	const prepared = await prepareBody(request, provider, upstreamPath);
	if (key.allowedModels !== null) {
		if (!prepared.json) {
			return errorResponse(
				provider,
				403,
				"モデルの制限がある sigw キーでは、JSON 以外のリクエストは使えません",
				"permission_error",
			);
		}
		if (
			prepared.body !== null &&
			!modelAllowed(key.allowedModels, prepared.model)
		) {
			return errorResponse(
				provider,
				403,
				`この sigw キーではモデル ${prepared.model ?? "(指定なし)"} を使えません。使えるモデル: ${key.allowedModels.join(", ")}`,
				"permission_error",
			);
		}
	}

	const meta: MeterContext = {
		env,
		key,
		userId: resolved.userId,
		month: resolved.month,
		provider,
		method: request.method,
		path: upstreamPath,
		requestModel: prepared.model,
		stream: prepared.stream,
		startedAt,
		via: entry === "bobert" ? "bobert" : null,
		createsAgentSession:
			provider.id === "anthropic" &&
			request.method === "POST" &&
			upstreamPath === "/v1/sessions",
		anthropicBeta: request.headers.get("anthropic-beta"),
	};

	// Managed Agents のセッション(docs/design.md 5.3)。利用者は resolved で決まっているので、
	// どの入口(公開の入口でも BobertGateway でも)から来たリクエストでも同じように記録する
	const origin = upstreamOrigin(env, provider);
	const agentSessionId =
		provider.id === "anthropic" ? sessionIdOf(upstreamPath) : null;
	const deletesAgentSession =
		agentSessionId !== null && isSessionDelete(request.method, upstreamPath);
	if (agentSessionId && deletesAgentSession) {
		await finalizeBeforeDelete(
			{ env, origin, apiKey: key.apiKey },
			ctx,
			agentSessionId,
			startedAt,
		);
	}

	let upstream: Response;
	try {
		upstream = await fetch(`${origin}${upstreamPath}${search}`, {
			method: request.method,
			headers: upstreamHeaders(request, provider, key.apiKey),
			body: prepared.body,
			redirect: "manual",
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.waitUntil(record(meta, 502, null, emptyReport(), null, message));
		return errorResponse(
			provider,
			502,
			`プロバイダにつながりませんでした: ${message}`,
			"api_error",
		);
	}
	const ttfbMs = Date.now() - startedAt;
	if (agentSessionId) {
		ctx.waitUntil(
			(deletesAgentSession
				? afterSessionDelete(env, agentSessionId, upstream.status)
				: touchAgentSession(env.DB, agentSessionId, startedAt)
			).catch((error) => {
				console.error("セッションの記録を更新できませんでした", error);
			}),
		);
	}

	const headers = new Headers(upstream.headers);
	headers.delete("content-encoding");
	headers.delete("content-length");
	const requestId =
		upstream.headers.get("x-request-id") ?? upstream.headers.get("request-id");

	if (!upstream.body) {
		ctx.waitUntil(
			record(meta, upstream.status, ttfbMs, emptyReport(), requestId, null),
		);
		return new Response(null, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	}

	const [toClient, toMeter] = upstream.body.tee();
	ctx.waitUntil(
		meter(
			meta,
			toMeter,
			upstream.status,
			upstream.headers.get("content-type") ?? "",
			ttfbMs,
			requestId,
		),
	);
	return new Response(toClient, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}

interface MeterContext {
	env: Env;
	key: KeyInfo;
	userId: string;
	month: string;
	provider: ProviderSpec;
	method: string;
	path: string;
	requestModel: string | null;
	stream: boolean;
	startedAt: number;
	/** 代理の呼び出しなら 'bobert'、公開の入口なら null */
	via: "bobert" | null;
	/** POST /v1/sessions(Managed Agents のセッションを作る) */
	createsAgentSession: boolean;
	anthropicBeta: string | null;
}

function emptyReport(): UsageReport {
	return {
		usage: emptyUsage(),
		model: null,
		providerCostNano: null,
		serviceTier: null,
		complete: true,
		found: false,
	};
}

/** 応答の本文(tee のもう片方)を読み、使用量を記録する */
async function meter(
	meta: MeterContext,
	stream: ReadableStream<Uint8Array>,
	status: number,
	contentType: string,
	ttfbMs: number,
	requestId: string | null,
): Promise<void> {
	try {
		let report: UsageReport;
		let error: string | null = null;
		if (contentType.includes("text/event-stream")) {
			report = await collectFromSse(stream, meta.provider.usageStyle);
		} else if (contentType.includes("json") || status >= 400) {
			const text = await new Response(stream).text();
			report = collectFromJson(text, meta.provider.usageStyle);
			if (status >= 400) {
				error = text.slice(0, 500);
			} else if (meta.createsAgentSession) {
				await recordCreatedSession(meta.env, text, {
					userId: meta.userId,
					sigwKeyId: meta.key.sigwKeyId,
					providerKeyId: meta.key.providerKeyId,
					ownerId: meta.key.ownerId,
					anthropicBeta: meta.anthropicBeta,
					via: meta.via,
					now: meta.startedAt,
				}).catch((error) => {
					console.error(
						"Managed Agents のセッションを記録できませんでした",
						error,
					);
				});
			}
		} else {
			// 音声や画像のファイルなど。使用量は読めないので、読み捨てる
			await stream.cancel();
			report = emptyReport();
		}
		await record(meta, status, ttfbMs, report, requestId, error);
	} catch (error) {
		console.error("使用量を記録できませんでした", error);
	}
}

async function record(
	meta: MeterContext,
	status: number,
	ttfbMs: number | null,
	report: UsageReport,
	requestId: string | null,
	error: string | null,
): Promise<void> {
	const model = report.model ?? meta.requestModel;
	const usage = report.usage;
	const tokens =
		usage.inputTokens +
		usage.cacheReadTokens +
		usage.cacheWriteTokens +
		usage.cacheWrite1hTokens +
		usage.outputTokens;
	let costNano: number | null = 0;
	let costSource: "provider" | "pricing" | "none" | null = "none";
	if (report.providerCostNano !== null) {
		costNano = report.providerCostNano;
		costSource = "provider";
	} else if (tokens > 0) {
		const prices = model
			? await loadProviderPrices(meta.env.DB, meta.provider.id)
			: null;
		const price = prices && model ? findPrice(prices, model) : null;
		if (price) {
			costNano = computeCostNano(usage, price, report.serviceTier);
			costSource = "pricing";
		} else {
			costNano = null;
			costSource = null;
		}
	}
	if (costNano) {
		addSpend(meta.key.sigwKeyId, meta.month, costNano);
	}
	await insertUsageEvent(meta.env.DB, {
		createdAt: meta.startedAt,
		userId: meta.userId,
		sigwKeyId: meta.key.sigwKeyId,
		providerKeyId: meta.key.providerKeyId,
		ownerId: meta.key.ownerId,
		provider: meta.provider.id,
		method: meta.method,
		path: meta.path,
		model,
		stream: meta.stream,
		status,
		usage,
		serviceTier: report.serviceTier,
		costNano,
		costSource,
		incomplete: meta.stream && status < 400 && !report.complete,
		ttfbMs,
		durationMs: Date.now() - meta.startedAt,
		upstreamRequestId: requestId,
		error,
		via: meta.via,
	});
}
