/*
 * Bobert からの代理の呼び出し。docs/design.md「4.5 Bobert からの代理の呼び出し」
 * Bobert(同じアカウントの Discord bot の Worker)は、Service Binding で名前付きのエントリポイント BobertGateway を呼ぶ。
 * パスは公開の入口と同じ(/anthropic/v1/messages など)で、ホストは見ない。
 * sigw キー(sgk_…)だけを x-api-key か Authorization で受け取り、利用者は x-sigw-user の Discord ID で決める。
 */

import { handleProxy } from "./handler.ts";
import { matchProviderPath } from "./providers.ts";

export async function handleBobertRequest(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const url = new URL(request.url);
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
