/*
 * Discord の OAuth2 でのログインと、Web UI のセッション。
 * ログインできるのは ALLOWED_DISCORD_IDS にある Discord のユーザーだけ。
 * 失敗したときは、画面(SPA)の /login に ?error= を付けて戻す。
 */

import {
	createSession,
	deleteSessionByToken,
	findSessionUser,
	WEB_SESSION_TTL_MS,
} from "../db/sessions.ts";
import { type User, upsertUser } from "../db/users.ts";
import { randomBase62 } from "../lib/crypto.ts";

const SESSION_COOKIE = "sigw_session";
const STATE_COOKIE = "sigw_oauth_state";
const NEXT_COOKIE = "sigw_oauth_next";

/** ログインのあとに戻るパス。同じサイトの中のパスだけを受け付ける(オープンリダイレクト対策) */
function safeNext(value: string | null): string {
	return value && /^\/(?![/\\])/.test(value) ? value : "/";
}

export function allowedIds(env: Env): Set<string> {
	return new Set(
		env.ALLOWED_DISCORD_IDS.split(",")
			.map((id) => id.trim())
			.filter((id) => id !== ""),
	);
}

export function readCookie(request: Request, name: string): string | null {
	const header = request.headers.get("cookie");
	if (!header) {
		return null;
	}
	for (const part of header.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) {
			return decodeURIComponent(rest.join("="));
		}
	}
	return null;
}

function cookie(
	request: Request,
	name: string,
	value: string,
	maxAgeSeconds: number,
	path = "/",
): string {
	// 手元(http://localhost)でも動くよう、https のときだけ Secure を付ける
	const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
	return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`;
}

function redirectUri(request: Request): string {
	return `${new URL(request.url).origin}/auth/callback`;
}

function backToLogin(message: string): Response {
	return new Response(null, {
		status: 302,
		headers: { Location: `/login?error=${encodeURIComponent(message)}` },
	});
}

/** Cookie のセッションでログインしているユーザー。していなければ null */
export async function sessionUser(
	request: Request,
	env: Env,
): Promise<User | null> {
	const token = readCookie(request, SESSION_COOKIE);
	if (!token) {
		return null;
	}
	const user = await findSessionUser(env.DB, token, "web");
	if (!user || !allowedIds(env).has(user.id)) {
		return null;
	}
	return user;
}

export function startLogin(request: Request, env: Env): Response {
	if (!env.DISCORD_CLIENT_ID) {
		return backToLogin("DISCORD_CLIENT_ID が設定されていません。");
	}
	const state = randomBase62(24);
	const url = new URL("https://discord.com/oauth2/authorize");
	url.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("redirect_uri", redirectUri(request));
	url.searchParams.set("scope", "identify");
	url.searchParams.set("state", state);
	url.searchParams.set("prompt", "none");
	const headers = new Headers({ Location: url.toString() });
	headers.append(
		"Set-Cookie",
		cookie(request, STATE_COOKIE, state, 600, "/auth"),
	);
	headers.append(
		"Set-Cookie",
		cookie(
			request,
			NEXT_COOKIE,
			safeNext(new URL(request.url).searchParams.get("next")),
			600,
			"/auth",
		),
	);
	return new Response(null, { status: 302, headers });
}

interface DiscordUser {
	id: string;
	username: string;
	global_name?: string | null;
	avatar?: string | null;
}

export async function finishLogin(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const expected = readCookie(request, STATE_COOKIE);
	if (!code || !state || !expected || state !== expected) {
		return backToLogin("ログインをやり直してください。");
	}
	const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Authorization: `Basic ${btoa(`${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`)}`,
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: redirectUri(request),
		}),
	});
	if (!tokenResponse.ok) {
		console.error(
			"Discord のトークンを取得できませんでした",
			await tokenResponse.text(),
		);
		return backToLogin(
			"Discord でのログインに失敗しました。もう一度試してください。",
		);
	}
	const { access_token: accessToken } = (await tokenResponse.json()) as {
		access_token: string;
	};
	const meResponse = await fetch("https://discord.com/api/users/@me", {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!meResponse.ok) {
		return backToLogin("Discord のユーザー情報を取得できませんでした。");
	}
	const discordUser = (await meResponse.json()) as DiscordUser;
	if (!allowedIds(env).has(discordUser.id)) {
		return backToLogin(
			`Discord アカウント ${discordUser.username}(ID ${discordUser.id})は sigw を使えません。`,
		);
	}
	await upsertUser(env.DB, {
		id: discordUser.id,
		name: discordUser.global_name || discordUser.username,
		avatar: discordUser.avatar ?? null,
	});
	const session = await createSession(env.DB, discordUser.id, "web");
	const headers = new Headers({
		Location: safeNext(readCookie(request, NEXT_COOKIE)),
	});
	headers.append(
		"Set-Cookie",
		cookie(request, SESSION_COOKIE, session, WEB_SESSION_TTL_MS / 1000),
	);
	headers.append("Set-Cookie", cookie(request, STATE_COOKIE, "", 0, "/auth"));
	headers.append("Set-Cookie", cookie(request, NEXT_COOKIE, "", 0, "/auth"));
	return new Response(null, { status: 302, headers });
}

export async function logout(request: Request, env: Env): Promise<Response> {
	const token = readCookie(request, SESSION_COOKIE);
	if (token) {
		await deleteSessionByToken(env.DB, token);
	}
	return new Response(null, {
		status: 303,
		headers: {
			Location: "/login",
			"Set-Cookie": cookie(request, SESSION_COOKIE, "", 0),
		},
	});
}

/** リクエストが、同じサイトのページから送られたものか(CSRF 対策) */
export function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	if (origin) {
		return origin === new URL(request.url).origin;
	}
	return request.headers.get("sec-fetch-site") === "same-origin";
}
