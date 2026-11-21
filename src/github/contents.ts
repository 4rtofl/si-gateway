// Daichoo(https://github.com/4rtofl/Daichoo、MPL-2.0)の src/github/ から持ってきたもの。
import { type Fetch, sleep } from "../lib/http.ts";

/*
 * GitHubのリポジトリのファイルの読み書き(REST APIのContents API)。
 * Botは、台帳のファイルを書き換えるたびに、1つのコミットを作る。
 * https://docs.github.com/en/rest/repos/contents
 */

export const GITHUB_API_BASE = "https://api.github.com";

/** GitHubのREST APIに送るリクエストに、いつも付けるヘッダー */
export const GITHUB_HEADERS = {
	Accept: "application/vnd.github+json",
	"User-Agent": "sigw",
	"X-GitHub-Api-Version": "2022-11-28",
} as const;

/** 書き換えが別の書き換えとぶつかったときに、読み直してやり直す回数の上限 */
const MAX_ATTEMPTS = 5;

export interface GitHubRepository {
	/** 「所有者/リポジトリ名」 */
	repository: string;
	/** 書き込むブランチ */
	branch: string;
	/**
	 * リポジトリのContentsを読み書きできるトークンを返す。
	 * GitHub Appのトークンには期限があるので、リクエストのたびに聞く(src/github/app-auth.ts)
	 */
	token: () => Promise<string>;
}

/** ファイルの中身と、そのファイルを書き換えるときに渡すSHA(どの版を書き換えるかを示す) */
export interface FileSnapshot {
	content: string;
	sha: string;
}

export interface GitHubContentsOptions {
	/** やり直す前に待つ時間の基準(ミリ秒)。やり直すたびに倍にする */
	retryDelayMs?: number;
}

/** GitHubのAPIがエラーを返した */
export class GitHubApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "GitHubApiError";
		this.status = status;
	}
}

export class GitHubContents {
	private readonly fetch: Fetch;
	private readonly repository: GitHubRepository;
	private readonly retryDelayMs: number;

	constructor(
		repository: GitHubRepository,
		fetch: Fetch,
		options: GitHubContentsOptions = {},
	) {
		if (!/^[\w.-]+\/[\w.-]+$/.test(repository.repository)) {
			throw new Error(
				`リポジトリは「所有者/リポジトリ名」の形で指定してください: ${repository.repository}`,
			);
		}
		this.repository = repository;
		this.fetch = fetch;
		this.retryDelayMs = options.retryDelayMs ?? 300;
	}

	/** ファイルを読む。ファイルがなければnullを返す */
	async getFile(path: string): Promise<FileSnapshot | null> {
		const ref = encodeURIComponent(this.repository.branch);
		const response = await this.request(
			"GET",
			`${this.contentsUrl(path)}?ref=${ref}`,
		);
		if (response.status === 404) {
			return null;
		}
		const data = (await this.readJson(response)) as {
			type?: string;
			encoding?: string;
			content?: string;
			sha?: string;
		};
		if (
			data.type !== "file" ||
			data.encoding !== "base64" ||
			typeof data.content !== "string" ||
			typeof data.sha !== "string"
		) {
			// 1MBを超えるファイルは、中身が返らない。台帳は月ごとに分けているので、ふつうは超えない
			throw new GitHubApiError(
				response.status,
				`${path} の中身を読めませんでした(ファイルでないか、大きすぎます)`,
			);
		}
		return { content: decodeBase64(data.content), sha: data.sha };
	}

	/**
	 * ファイルを書き換えて、コミットを1つ作る。shaには、書き換える前の版のSHAを渡す(新しく作るときは渡さない)。
	 * その版のあとに、別の書き換えが入っていたら、GitHubConflictErrorにする。
	 */
	async putFile(
		path: string,
		content: string,
		message: string,
		sha?: string,
	): Promise<void> {
		const response = await this.request("PUT", this.contentsUrl(path), {
			message,
			content: encodeBase64(content),
			branch: this.repository.branch,
			...(sha ? { sha } : {}),
		});
		if (response.ok) {
			return;
		}
		const errorMessage = await readErrorMessage(response);
		// 409: 渡したSHAが最新の版でない。422: ファイルがあるのにSHAを渡していない(同時に作られた)
		if (
			response.status === 409 ||
			(response.status === 422 && /sha/i.test(errorMessage))
		) {
			throw new GitHubConflictError(errorMessage);
		}
		throw new GitHubApiError(
			response.status,
			`${path} を書き込めませんでした(${response.status}): ${errorMessage}`,
		);
	}

	/**
	 * ファイルを読み、updateで作った中身に書き換える。updateには、今の中身(ファイルがなければnull)を渡す。
	 * updateがnullを返したら、書き換えずにfalseを返す。
	 * 別の書き換えとぶつかったら、読み直してやり直す。
	 */
	async updateFile(
		path: string,
		message: string,
		update: (current: string | null) => string | null,
	): Promise<boolean> {
		for (let attempt = 1; ; attempt++) {
			const current = await this.getFile(path);
			const next = update(current?.content ?? null);
			if (next === null) {
				return false;
			}
			try {
				await this.putFile(path, next, message, current?.sha);
				return true;
			} catch (error) {
				if (
					!(error instanceof GitHubConflictError) ||
					attempt >= MAX_ATTEMPTS
				) {
					throw error;
				}
				await sleep(this.retryDelayMs * 2 ** (attempt - 1));
			}
		}
	}

	/** GitHubの画面で、ブランチの最新のファイルを開くURL */
	fileUrl(path: string): string {
		const encode = (value: string) =>
			value.split("/").map(encodeURIComponent).join("/");
		return `https://github.com/${this.repository.repository}/blob/${encode(this.repository.branch)}/${encode(path)}`;
	}

	private contentsUrl(path: string): string {
		const encodedPath = path.split("/").map(encodeURIComponent).join("/");
		return `${GITHUB_API_BASE}/repos/${this.repository.repository}/contents/${encodedPath}`;
	}

	private async request(
		method: string,
		url: string,
		body?: unknown,
	): Promise<Response> {
		const headers: Record<string, string> = {
			...GITHUB_HEADERS,
			Authorization: `Bearer ${await this.repository.token()}`,
		};
		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
		}
		return this.fetch(url, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}

	private async readJson(response: Response): Promise<unknown> {
		if (!response.ok) {
			throw new GitHubApiError(
				response.status,
				`GitHubのAPIがエラーを返しました(${response.status}): ${await readErrorMessage(response)}`,
			);
		}
		return response.json();
	}
}

/** 別の書き換えとぶつかった。読み直してやり直せば、書き込めることがある */
export class GitHubConflictError extends GitHubApiError {
	constructor(message: string) {
		super(409, message);
		this.name = "GitHubConflictError";
	}
}

/** GitHubのAPIが返したエラーの説明を読む */
export async function readErrorMessage(response: Response): Promise<string> {
	const text = await response.text();
	try {
		const data = JSON.parse(text) as { message?: unknown };
		if (typeof data.message === "string") {
			return data.message;
		}
	} catch {
		// JSONでなければ、本文をそのまま使う
	}
	return text.slice(0, 200);
}

/** UTF-8の文字列をBase64にする(Contents APIは、ファイルの中身をBase64でやり取りする) */
export function encodeBase64(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

/** Base64をUTF-8の文字列に戻す。GitHubは60文字ごとに改行を入れて返すので、空白は取り除く */
export function decodeBase64(base64: string): string {
	const binary = atob(base64.replace(/\s/g, ""));
	return new TextDecoder().decode(
		Uint8Array.from(binary, (char) => char.charCodeAt(0)),
	);
}
