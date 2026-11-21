// Daichoo(https://github.com/4rtofl/Daichoo、MPL-2.0)の src/github/ から持ってきたもの。
import type { Fetch } from "../lib/http.ts";
import {
	GITHUB_API_BASE,
	GITHUB_HEADERS,
	GitHubApiError,
	readErrorMessage,
} from "./contents.ts";

/*
 * GitHub Appとして、台帳のリポジトリを読み書きするトークンを手に入れる。
 * 1. Appの秘密鍵で署名したJWTを作る(GitHubが受け付けるのは、有効期限が10分以内のもの)
 * 2. JWTで、リポジトリに入っているAppのインストールを調べる
 * 3. インストールのトークン(1時間有効)を発行してもらう
 * このトークンでContents APIを使うと、コミットはAppのBot(「<App名>[bot]」)の名前になる。
 * https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
 */

export interface GitHubAppCredentials {
	/** AppのClient ID。JWTの発行者(iss)として使う */
	clientId: string;
	/** Appの秘密鍵(PEM)。GitHubからダウンロードしたままの形(PKCS#1)でも、PKCS#8の形でもよい */
	privateKey: string;
}

/** 発行してもらったトークンと、その期限(ミリ秒) */
interface IssuedToken {
	token: string;
	expiresAt: number;
}

/** 発行してもらったトークンの置き場所。キーは「Client ID:リポジトリ」 */
export type TokenCache = Map<string, IssuedToken>;

/** Workerでは、同じisolateで動くリクエストのあいだで、トークンを使い回す */
const sharedCache: TokenCache = new Map();

/** 期限までの残りがこれより短いトークンは使わず、発行し直す */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface GitHubAppAuthOptions {
	/** 今の時刻(ミリ秒)。テストで差し替える */
	now?: () => number;
	/** トークンの置き場所。テストで差し替える */
	cache?: TokenCache;
}

export class GitHubAppAuth {
	private readonly credentials: GitHubAppCredentials;
	private readonly repository: string;
	private readonly fetch: Fetch;
	private readonly now: () => number;
	private readonly cache: TokenCache;

	/** repositoryは「所有者/リポジトリ名」 */
	constructor(
		credentials: GitHubAppCredentials,
		repository: string,
		fetch: Fetch,
		options: GitHubAppAuthOptions = {},
	) {
		this.credentials = credentials;
		this.repository = repository;
		this.fetch = fetch;
		this.now = options.now ?? Date.now;
		this.cache = options.cache ?? sharedCache;
	}

	/** リポジトリのContentsを読み書きできるトークンを返す。期限が近ければ、発行し直す */
	async token(): Promise<string> {
		if (!this.credentials.clientId) {
			throw new Error(
				"GITHUB_APP_CLIENT_ID が設定されていません(wrangler.jsonc の vars)",
			);
		}
		const key = `${this.credentials.clientId}:${this.repository}`;
		const cached = this.cache.get(key);
		if (cached && cached.expiresAt - this.now() > REFRESH_MARGIN_MS) {
			return cached.token;
		}
		const jwt = await createAppJwt(this.credentials, this.now());
		const installationId = await this.findInstallation(jwt);
		const issued = await this.issueToken(jwt, installationId);
		this.cache.set(key, issued);
		return issued.token;
	}

	/** リポジトリに入っている、Appのインストールの番号を調べる */
	private async findInstallation(jwt: string): Promise<number> {
		const response = await this.request(
			"GET",
			`/repos/${this.repository}/installation`,
			jwt,
		);
		if (response.status === 404) {
			throw new GitHubApiError(
				404,
				`GitHub Appが ${this.repository} にインストールされていません。Appの画面の「Install App」から、このリポジトリにインストールしてください`,
			);
		}
		const data = (await readJson(
			response,
			"Appのインストールを調べられませんでした",
		)) as { id?: unknown };
		if (typeof data.id !== "number") {
			throw new GitHubApiError(
				response.status,
				"Appのインストールの番号を読めませんでした",
			);
		}
		return data.id;
	}

	/** インストールのトークンを発行してもらう。使えるのは、台帳のリポジトリのContentsの読み書きだけに絞る */
	private async issueToken(
		jwt: string,
		installationId: number,
	): Promise<IssuedToken> {
		const name = this.repository.split("/")[1] ?? "";
		const response = await this.request(
			"POST",
			`/app/installations/${installationId}/access_tokens`,
			jwt,
			{ repositories: [name], permissions: { contents: "write" } },
		);
		const data = (await readJson(
			response,
			"Appのトークンを発行してもらえませんでした",
		)) as { token?: unknown; expires_at?: unknown };
		const expiresAt =
			typeof data.expires_at === "string" ? Date.parse(data.expires_at) : NaN;
		if (typeof data.token !== "string" || Number.isNaN(expiresAt)) {
			throw new GitHubApiError(
				response.status,
				"Appのトークンを読めませんでした",
			);
		}
		return { token: data.token, expiresAt };
	}

	private request(
		method: string,
		path: string,
		jwt: string,
		body?: unknown,
	): Promise<Response> {
		const headers: Record<string, string> = {
			...GITHUB_HEADERS,
			Authorization: `Bearer ${jwt}`,
		};
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
		}
		return this.fetch(`${GITHUB_API_BASE}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}
}

async function readJson(response: Response, failure: string): Promise<unknown> {
	if (!response.ok) {
		throw new GitHubApiError(
			response.status,
			`${failure}(${response.status}): ${await readErrorMessage(response)}`,
		);
	}
	return response.json();
}

/**
 * Appとして認証するためのJWTを作る。署名はRS256。
 * Workerの時計とGitHubの時計のずれを見込んで、発行時刻を60秒前にする。有効期限は、発行時刻の10分後
 */
export async function createAppJwt(
	credentials: GitHubAppCredentials,
	nowMs: number,
): Promise<string> {
	const issuedAt = Math.floor(nowMs / 1000) - 60;
	const header = { alg: "RS256", typ: "JWT" };
	const payload = {
		iat: issuedAt,
		exp: issuedAt + 600,
		iss: credentials.clientId,
	};
	const signingInput = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
	const key = await importPrivateKey(credentials.privateKey);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

/** PEMの秘密鍵を、署名に使える鍵にする。改行を「\n」と書いた1行の形も受け付ける */
export async function importPrivateKey(pem: string) {
	const text = pem.replace(/\\n/g, "\n");
	const match =
		/-----BEGIN (RSA )?PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END (?:RSA )?PRIVATE KEY-----/.exec(
			text,
		);
	const body = match?.[2];
	if (!body) {
		throw new Error(
			"GitHub Appの秘密鍵(PEM)を読めません。ダウンロードした .pem ファイルの中身を、そのまま入れてください",
		);
	}
	const der = base64ToBytes(body.replace(/\s/g, ""));
	return crypto.subtle.importKey(
		"pkcs8",
		match[1] ? wrapPkcs1InPkcs8(der) : der,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

/**
 * PKCS#1の鍵(GitHubからダウンロードした形)を、PKCS#8の形に包む。Web Cryptoは、PKCS#8しか読めないため。
 * PrivateKeyInfo ::= SEQUENCE { version INTEGER(0), algorithm AlgorithmIdentifier, privateKey OCTET STRING }
 */
function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
	const version = [0x02, 0x01, 0x00];
	// rsaEncryption(1.2.840.113549.1.1.1)と、パラメーターのNULL
	const algorithm = [
		0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
		0x01, 0x05, 0x00,
	];
	const privateKey = [0x04, ...derLength(pkcs1.length), ...pkcs1];
	const body = [...version, ...algorithm, ...privateKey];
	return Uint8Array.from([0x30, ...derLength(body.length), ...body]);
}

/** DERでの長さの書き方。128未満は1バイト。それ以上は「0x80 + 長さのバイト数」に続けて、長さを書く */
function derLength(length: number): number[] {
	if (length < 0x80) {
		return [length];
	}
	const bytes: number[] = [];
	for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
		bytes.unshift(rest % 256);
	}
	return [0x80 | bytes.length, ...bytes];
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function base64UrlJson(value: unknown): string {
	return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}
