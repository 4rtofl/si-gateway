/*
 * CLI_HOST(cli.sigw.4rtofl.org)で、CLI のインストールスクリプトと、最新の版を配る。
 * バイナリそのものは GitHub Releases(CLI_RELEASE_REPOSITORY、タグは cli-v<版>)に置き、
 * スクリプトと CLI(sigw update)がそこから直接ダウンロードする。
 * - /、/install.sh: macOS と Linux 用(curl -fsSL https://cli.sigw.4rtofl.org/install.sh | sh)
 * - /install.ps1: Windows 用(irm https://cli.sigw.4rtofl.org/install.ps1 | iex)
 * - /latest: 最新の版(例 0.1.0)を1行で返す
 */

import installPs1 from "../../cli/install.ps1";
import installSh from "../../cli/install.sh";

const LATEST_CACHE_SECONDS = 300;

function fill(template: string, env: Env, origin: string): string {
	return template
		.replaceAll("__SIGW_RELEASE_REPOSITORY__", env.CLI_RELEASE_REPOSITORY)
		.replaceAll("__SIGW_CLI_ORIGIN__", origin);
}

function text(body: string, status = 200, maxAge = 60): Response {
	return new Response(body, {
		status,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": `public, max-age=${maxAge}`,
		},
	});
}

/**
 * GitHub の「最新のリリース」の版。API は IP ごとの回数制限が厳しいので使わず、
 * /releases/latest のリダイレクト先(/releases/tag/cli-v0.1.0)から読む
 */
async function latestVersion(env: Env, ctx: ExecutionContext): Promise<string> {
	const cacheKey = new Request(
		`https://sigw-cache.invalid/cli-latest/${env.CLI_RELEASE_REPOSITORY}`,
	);
	const cached = await caches.default.match(cacheKey);
	if (cached) {
		return cached.text();
	}
	const response = await fetch(
		`https://github.com/${env.CLI_RELEASE_REPOSITORY}/releases/latest`,
		{ redirect: "manual", headers: { "User-Agent": "sigw" } },
	);
	const tag = response.headers
		.get("location")
		?.match(/\/releases\/tag\/cli-v([^/?#]+)$/)?.[1];
	if (!tag) {
		throw new Error(
			`最新のリリースが見つかりません(GitHub の応答 ${response.status})`,
		);
	}
	const version = decodeURIComponent(tag);
	ctx.waitUntil(
		caches.default.put(
			cacheKey,
			new Response(version, {
				headers: { "Cache-Control": `max-age=${LATEST_CACHE_SECONDS}` },
			}),
		),
	);
	return version;
}

export async function handleCliHost(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return text("GET だけを受け付けます\n", 405);
	}
	const url = new URL(request.url);
	switch (url.pathname) {
		case "/":
		case "/install.sh":
			return text(fill(installSh, env, url.origin));
		case "/install.ps1":
			return text(fill(installPs1, env, url.origin));
		case "/latest":
			try {
				return text(`${await latestVersion(env, ctx)}\n`, 200, 0);
			} catch (error) {
				return text(
					`${error instanceof Error ? error.message : String(error)}\n`,
					502,
					0,
				);
			}
		default:
			return text(
				`見つかりません。インストールは curl -fsSL ${url.origin}/install.sh | sh\n`,
				404,
			);
	}
}
