/*
 * Bobert からの代理の呼び出し。docs/design.md「4.5 Bobert からの代理の呼び出し」
 * Bobert(同じアカウントの Discord bot の Worker)は、Service Binding で名前付きのエントリポイント BobertGateway を呼ぶ。
 * パスは公開の入口と同じ(/anthropic/v1/messages など)で、ホストは見ない。
 * sigw キー(sgk_…)だけを x-api-key か Authorization で受け取り、利用者は x-sigw-user の Discord ID で決める。
 * GET /sigw/key は、sigw キーで呼べるプロバイダの一覧を返す(Bobert が登録するキーを確かめるため)。
 */

import {
	DELEGATED_USER_HEADER,
	lookupSigwKeyProviders,
	parseDelegatedSigwToken,
	parseDelegatedUser,
} from "./auth.ts";
import { handleProxy } from "./handler.ts";
import { matchProviderPath } from "./providers.ts";

/** sigw キーの情報を問い合わせるパス。BobertGateway でだけ受け付け、公開の入口では 404 にする */
export const SIGW_KEY_PATH = "/sigw/key";

export async function handleBobertRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === SIGW_KEY_PATH) {
		return handleSigwKeyInfo(request, env);
	}
	const match = matchProviderPath(url.pathname);
	if (!match) {
		return Response.json(
			{
				error:
					"BobertGateway は LLM の中継だけに使います。/openai、/anthropic、/xai、/openrouter、/typesafe で始まるパスを指定してください",
			},
			{ status: 404 },
		);
	}
	return handleProxy(
		request,
		env,
		ctx,
		match.provider,
		match.upstreamPath,
		url.search,
		"bobert",
	);
}

function sigwError(status: number, type: string, message: string): Response {
	return Response.json(
		{ error: { type, message: `[sigw] ${message}` } },
		{ status, headers: { "Cache-Control": "no-store" } },
	);
}

/**
 * GET /sigw/key。200 で {"last4": "abcd", "providers": ["anthropic", "openrouter"]} を返す。
 * - last4: sigw キー(sgk_…)の末尾4文字
 * - providers: 結び付いたプロバイダキーのうち、無効になっていないもののプロバイダ(PROVIDER_IDS の順)
 * プロバイダキーそのものや、その末尾は返さない。
 * x-sigw-user は付けなくてよい。付けたときは、sigw のメンバーでなければ 401 にする
 */
async function handleSigwKeyInfo(
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.method !== "GET") {
		return sigwError(
			405,
			"invalid_request_error",
			`${SIGW_KEY_PATH} は GET で呼んでください`,
		);
	}
	const sigwToken = parseDelegatedSigwToken(request.headers);
	if (!sigwToken) {
		return sigwError(
			401,
			"authentication_error",
			"x-api-key か Authorization に sigw キー(sgk_…)を入れてください",
		);
	}
	let discordId: string | null = null;
	if (request.headers.has(DELEGATED_USER_HEADER)) {
		discordId = parseDelegatedUser(request.headers);
		if (!discordId) {
			return sigwError(
				401,
				"authentication_error",
				"x-sigw-user の利用者は sigw のメンバーではありません",
			);
		}
	}
	const result = await lookupSigwKeyProviders(env, sigwToken, discordId);
	if (result === "invalid_key") {
		return sigwError(401, "authentication_error", "sigw キーが無効です");
	}
	if (result === "not_member") {
		return sigwError(
			401,
			"authentication_error",
			"x-sigw-user の利用者は sigw のメンバーではありません",
		);
	}
	return Response.json(
		{ last4: sigwToken.slice(-4), providers: result },
		{ headers: { "Cache-Control": "no-store" } },
	);
}
