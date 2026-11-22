#!/usr/bin/env node
/*
 * sigw の CLI。CLI トークン(sgc_…)で JSON API(/api/*)を呼ぶ。
 * - 配るときは Bun でネイティブのバイナリにする(.github/workflows/release-cli.yml)。
 *   入れ方: curl -fsSL https://cli.sigw.4rtofl.org/install.sh | sh
 * - 開発中は Node.js 24 で、ビルドせずに「node cli/sigw.ts」(pnpm cli)として動く
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type {
	CliLoginPollJson,
	CliLoginStartJson,
	CliTokenJson,
	MeJson,
	PriceRowJson,
	ProviderKeyJson,
	SettlementJson,
	SettlementPreviewJson,
	SigwKeyInput,
	SigwKeyJson,
	UsageEventJson,
	UsageOverviewJson,
	UsageSummaryJson,
} from "../src/api/types.ts";

/** リリースのビルドで、bun build --define が版(0.1.0 など)に置き換える */
declare const SIGW_VERSION: string | undefined;
const VERSION = typeof SIGW_VERSION === "string" ? SIGW_VERSION : "dev";
const DEFAULT_URL = "https://portal.sigw.4rtofl.org";
const CLI_ORIGIN = "https://cli.sigw.4rtofl.org";
const RELEASE_REPOSITORY = "4rtofl/si-gateway";

const CONFIG_PATH = join(
	process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
	"sigw",
	"config.json",
);

interface Config {
	url: string;
	token: string;
}

const HELP = `sigw の CLI ${VERSION}

使い方: sigw <コマンド> [引数]

  auth login [--url URL] [--no-browser]
                                      ブラウザで Discord にログインして、この端末を登録する
  auth login --with-token [--url URL] CLI トークン(Web UI の「設定」で発行)を標準入力から入れる
  auth status                         ログインしているユーザーと接続先
  auth logout                         この端末の CLI トークンを消す
  update                              sigw を最新の版にする
  --version                           版を表示する

  me                                  自分とメンバー、クライアントの base URL
  personal-token                      個人トークンを発行し直す

  provider-keys                       プロバイダキーの一覧
  provider-keys add --provider <openai|anthropic|xai|openrouter|typesafe> [--label 名前] [--delegated-only]
                                      プロバイダキーを登録する(キーは標準入力から読む)。
                                      --delegated-only: 代理専用(Bobert からの呼び出しでだけ使える)
  provider-keys disable|enable <ID>   プロバイダキーを無効にする・有効に戻す

  keys                                sigw キーの一覧
  keys show <ID>                      sigw キーの詳細と今月の呼び出し
  keys create --provider-key <ID>[,<ID>…] --purpose <目的> [--models a,b] [--limit USD] [--expires YYYY-MM-DD]
                                      プロバイダキーは、プロバイダごとに1つずつ選べる
  keys update <ID> [--purpose 目的] [--models a,b|""] [--limit USD|""] [--expires YYYY-MM-DD|""]
  keys add-provider <ID> <プロバイダキーの ID>
                                      sigw キーにプロバイダキーを足す(プロバイダごとに1つまで)
  keys remove-provider <ID> <プロバイダキーの ID>
                                      sigw キーからプロバイダキーを外す
  keys revoke <ID>                    sigw キーを無効にする

  usage [--month YYYY-MM] [--by user|pair|key|model]
  events [--month YYYY-MM] [--user ID] [--key ID] [--limit N]

  settle                              精算した月の一覧
  settle preview [YYYY-MM]            精算のプレビュー(省略すると前の月)
  settle run <YYYY-MM>                精算して Daichoo の台帳に書く
  settle fx <YYYY-MM> <レート|clear>  その月の為替レートを手で決める・自動に戻す

  prices [--provider P] [--q 文字列]  単価表
  prices set --provider P --model M --input $/1M --output $/1M [--cache-read $/1M] [--cache-write $/1M]
  prices rm --provider P --model M    手で決めた単価を消す
  prices sync                         LiteLLM の価格表から同期する

  cli-tokens                          CLI トークンの一覧

設定ファイル: ${CONFIG_PATH}(環境変数 SIGW_URL と SIGW_TOKEN でも指定できる)
`;

// ---- 設定と HTTP ----

async function loadConfig(): Promise<Config> {
	const url = process.env.SIGW_URL;
	const token = process.env.SIGW_TOKEN;
	if (url && token) {
		return { url, token };
	}
	try {
		return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config;
	} catch {
		throw new Error(
			"ログインしていません。「sigw auth login」を実行するか、SIGW_URL と SIGW_TOKEN を設定してください",
		);
	}
}

async function request<T>(
	config: Config,
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const response = await fetch(`${config.url.replace(/\/$/, "")}/api${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${config.token}`,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let data: unknown = {};
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = { error: text.slice(0, 200) };
	}
	if (!response.ok) {
		const message =
			(data as { error?: string }).error ?? `HTTP ${response.status}`;
		throw new Error(message);
	}
	return data as T;
}

async function prompt(question: string): Promise<string> {
	if (!process.stdin.isTTY) {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks).toString("utf8").trim();
	}
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return (await rl.question(question)).trim();
	} finally {
		rl.close();
	}
}

// ---- ログイン ----

async function saveConfig(config: Config): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), {
		mode: 0o600,
	});
}

function isWsl(): boolean {
	try {
		return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}

/** 既定のブラウザで開く。開けそうにない環境(SSH の先など)では false */
function openBrowser(url: string): boolean {
	let command: string;
	let args: string[];
	if (process.platform === "darwin") {
		[command, args] = ["open", [url]];
	} else if (process.platform === "win32") {
		[command, args] = ["rundll32", ["url.dll,FileProtocolHandler", url]];
	} else if (isWsl()) {
		[command, args] = ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
	} else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
		[command, args] = ["xdg-open", [url]];
	} else {
		return false;
	}
	try {
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * ブラウザでのログイン(デバイス認可と同じ流れ)。
 * CLI が確認用のコードを受け取り、ブラウザで開いた Web UI で本人が許可するのを待つ
 */
async function browserLogin(url: string, useBrowser: boolean): Promise<Config> {
	const call = <T>(path: string, body: unknown) =>
		request<T>({ url, token: "" }, "POST", path, body);
	const started = await call<CliLoginStartJson>("/cli-login/start", {
		clientName: hostname(),
	});
	const opened = useBrowser && openBrowser(started.verificationUrl);
	console.error(
		opened
			? "ブラウザでログインの画面を開きました。開かないときは、次の URL を開いてください。"
			: "ブラウザで次の URL を開いてください。",
	);
	console.error(`\n  ${started.verificationUrl}\n`);
	console.error(
		`画面に出るコードが ${started.userCode} と同じなら、「許可」を押してください。待っています…`,
	);
	while (Date.now() < started.expiresAt) {
		await sleep(started.intervalMs);
		const result = await call<CliLoginPollJson>("/cli-login/poll", {
			deviceCode: started.deviceCode,
		});
		if (result.status === "approved") {
			return { url, token: result.token };
		}
		if (result.status === "denied") {
			throw new Error("ブラウザで拒否されました");
		}
		if (result.status === "expired") {
			break;
		}
	}
	throw new Error(
		"時間切れです。もう一度「sigw auth login」を実行してください",
	);
}

async function authLogin(options: Options): Promise<void> {
	const url = (opt(options, "url") ?? process.env.SIGW_URL ?? DEFAULT_URL)
		.trim()
		.replace(/\/$/, "");
	const config = options["with-token"]
		? { url, token: await prompt("CLI トークン(sgc_…): ") }
		: await browserLogin(url, !options["no-browser"]);
	const me = await request<MeJson>(config, "GET", "/me");
	await saveConfig(config);
	console.log(`${me.user.name} としてログインしました(${CONFIG_PATH})`);
}

async function authLogout(): Promise<void> {
	let config: Config;
	try {
		config = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config;
	} catch {
		console.log("ログインしていません");
		return;
	}
	try {
		await request(config, "DELETE", "/cli-tokens/current");
	} catch (error) {
		// トークンがもう消されていても、手元の設定は消す
		console.error(
			`CLI トークンを消せませんでした(${error instanceof Error ? error.message : String(error)})`,
		);
	}
	await rm(CONFIG_PATH, { force: true });
	console.log("ログアウトしました");
}

// ---- 更新 ----

/** この端末に合うリリースのファイル名(cli/install.sh の detect_asset と同じ) */
function releaseAsset(): string {
	const arch = { x64: "x64", arm64: "arm64" }[process.arch as string];
	if (!arch) throw new Error(`この CPU(${process.arch})用の sigw はありません`);
	switch (process.platform) {
		case "darwin":
			return `sigw-darwin-${arch}`;
		case "win32":
			return "sigw-windows-x64.exe";
		case "linux": {
			const musl =
				existsSync("/lib") &&
				readdirSync("/lib").some((name) => name.startsWith("ld-musl-"));
			return `sigw-linux-${arch}${musl ? "-musl" : ""}`;
		}
		default:
			throw new Error(`この OS(${process.platform})用の sigw はありません`);
	}
}

async function fetchOk(url: string): Promise<Response> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`${url} を取得できません(HTTP ${response.status})`);
	}
	return response;
}

async function selfUpdate(): Promise<void> {
	if (VERSION === "dev") {
		throw new Error(
			"ソースから動かしている sigw は更新できません。git pull してください",
		);
	}
	const latest = (await (await fetchOk(`${CLI_ORIGIN}/latest`)).text()).trim();
	if (latest === VERSION) {
		console.log(`最新の版(${VERSION})です`);
		return;
	}
	const asset = releaseAsset();
	const base = `https://github.com/${RELEASE_REPOSITORY}/releases/download/cli-v${latest}`;
	console.error(`${VERSION} から ${latest} にしています…`);
	const [binary, sums] = await Promise.all([
		fetchOk(`${base}/${asset}`).then((r) => r.arrayBuffer()),
		fetchOk(`${base}/SHA256SUMS`).then((r) => r.text()),
	]);
	const expected = sums
		.split("\n")
		.map((line) => line.trim().split(/\s+\*?/))
		.find(([, name]) => name === asset)?.[0];
	const actual = createHash("sha256")
		.update(new Uint8Array(binary))
		.digest("hex");
	if (!expected || expected !== actual) {
		throw new Error("ダウンロードしたファイルのハッシュが合いません");
	}
	const target = process.execPath;
	const next = `${target}.new`;
	await writeFile(next, new Uint8Array(binary));
	await chmod(next, 0o755);
	if (process.platform === "win32") {
		// 動いている exe は上書きできないが、名前は変えられる
		await rm(`${target}.old`, { force: true });
		await rename(target, `${target}.old`);
	}
	await rename(next, target);
	console.log(`sigw ${latest} にしました`);
}

// ---- 表示 ----

function usd(nano: number | null | undefined): string {
	if (nano === null || nano === undefined) return "不明";
	if (nano === 0) return "$0";
	const value = nano / 1e9;
	return `$${value.toFixed(Math.abs(value) >= 1 ? 2 : Math.abs(value) >= 0.01 ? 4 : 6)}`;
}

function date(ms: number | null): string {
	if (ms === null) return "—";
	return new Date(ms + 9 * 3600 * 1000)
		.toISOString()
		.slice(0, 16)
		.replace("T", " ");
}

function width(text: string): number {
	let w = 0;
	for (const char of text) w += /[　-鿿＀-￯]/.test(char) ? 2 : 1;
	return w;
}

function table(headers: string[], rows: (string | number)[][]): void {
	if (rows.length === 0) {
		console.log("(なし)");
		return;
	}
	const cells = rows.map((row) => row.map(String));
	const widths = headers.map((header, index) =>
		Math.max(width(header), ...cells.map((row) => width(row[index] ?? ""))),
	);
	const line = (values: string[]) =>
		values
			.map(
				(value, index) =>
					value + " ".repeat((widths[index] ?? 0) - width(value)),
			)
			.join("  ")
			.trimEnd();
	console.log(line(headers));
	console.log(widths.map((w) => "-".repeat(w)).join("  "));
	for (const row of cells) console.log(line(row));
}

function previousMonth(): string {
	const now = new Date(Date.now() + 9 * 3600 * 1000);
	const index = now.getUTCFullYear() * 12 + now.getUTCMonth() - 1;
	return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

// ---- コマンド ----

type Options = Record<string, string | boolean | undefined>;

function opt(options: Options, name: string): string | undefined {
	const value = options[name];
	return typeof value === "string" ? value : undefined;
}

function required(options: Options, name: string): string {
	const value = opt(options, name);
	if (value === undefined || value === "") {
		throw new Error(`--${name} を指定してください`);
	}
	return value;
}

function keyInput(options: Options, base?: SigwKeyJson): SigwKeyInput {
	const models = opt(options, "models");
	const limit = opt(options, "limit");
	const expires = opt(options, "expires");
	return {
		purpose: opt(options, "purpose") ?? base?.purpose ?? "",
		allowedModels:
			models === undefined
				? (base?.allowedModels ?? null)
				: models
						.split(",")
						.map((value) => value.trim())
						.filter(Boolean),
		monthlyLimitUsd:
			limit === undefined
				? base?.monthlyLimitNano
					? base.monthlyLimitNano / 1e9
					: null
				: limit === ""
					? null
					: Number(limit),
		expiresOn:
			expires === undefined
				? base?.expiresAt
					? new Date(base.expiresAt + 9 * 3600 * 1000)
							.toISOString()
							.slice(0, 10)
					: null
				: expires === ""
					? null
					: expires,
	};
}

function printKeys(keys: SigwKeyJson[]): void {
	table(
		["ID", "目的", "状態", "プロバイダキー", "発行", "今月", "上限", "期限"],
		keys.map((key) => [
			key.id,
			key.purpose,
			key.revokedAt !== null
				? "無効"
				: key.providerKeys.every((providerKey) => providerKey.disabled)
					? "プロバイダキーが無効"
					: key.expiresAt !== null && key.expiresAt < Date.now()
						? "期限切れ"
						: "有効",
			key.providerKeys
				.map(
					(providerKey) =>
						`${providerKey.provider}/${providerKey.label}(${providerKey.ownerName})${providerKey.disabled ? "・無効" : ""}`,
				)
				.join(", "),
			key.createdByName,
			usd(key.monthSpendNano),
			key.monthlyLimitNano === null ? "なし" : usd(key.monthlyLimitNano),
			date(key.expiresAt),
		]),
	);
}

function printEvents(
	events: UsageEventJson[],
	names: Map<string, string>,
): void {
	table(
		[
			"日時",
			"利用者",
			"モデル",
			"状態",
			"入力",
			"キャッシュ",
			"出力",
			"料金",
			"TTFB",
		],
		events.map((event) => [
			date(event.createdAt),
			`${names.get(event.userId) ?? event.userId}${event.via === "bobert" ? "(Bobert)" : ""}`,
			event.model ?? event.path,
			event.incomplete ? `${event.status}(途中)` : String(event.status),
			event.inputTokens,
			event.cacheReadTokens + event.cacheWriteTokens,
			event.outputTokens,
			usd(event.costNano),
			event.ttfbMs === null ? "—" : `${event.ttfbMs}ms`,
		]),
	);
}

function printPreview(preview: SettlementPreviewJson | SettlementJson): void {
	console.log(
		`${preview.month}  1 USD = ${preview.usdJpy.toFixed(2)}円(${preview.fxSource})`,
	);
	table(
		["支払う人", "受け取る人", "USD", "円"],
		preview.detail.lines.map((line) => [
			line.debtorName,
			line.payerName,
			usd(line.costNano),
			line.yen,
		]),
	);
	if (preview.detail.unpriced > 0) {
		console.log(
			`料金が不明な呼び出しが ${preview.detail.unpriced} 件あり、精算に入っていません。`,
		);
	}
}

async function main(): Promise<void> {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			provider: { type: "string" },
			label: { type: "string" },
			"provider-key": { type: "string" },
			purpose: { type: "string" },
			models: { type: "string" },
			limit: { type: "string" },
			expires: { type: "string" },
			month: { type: "string" },
			by: { type: "string" },
			user: { type: "string" },
			key: { type: "string" },
			model: { type: "string" },
			q: { type: "string" },
			input: { type: "string" },
			output: { type: "string" },
			"cache-read": { type: "string" },
			"cache-write": { type: "string" },
			url: { type: "string" },
			"with-token": { type: "boolean" },
			"delegated-only": { type: "boolean" },
			"no-browser": { type: "boolean" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
	const [command, sub, arg1, arg2] = positionals;
	if (values.version || command === "version") {
		console.log(VERSION);
		return;
	}
	if (!command || values.help) {
		console.log(HELP);
		return;
	}
	if (command === "update") {
		await selfUpdate();
		return;
	}
	if (command === "auth" || command === "login" || command === "logout") {
		const action = command === "auth" ? sub : command;
		if (action === "login") {
			// 前の形(sigw login <URL>)も受け付ける
			if (command === "login" && sub) values.url = sub;
			await authLogin(values);
			return;
		}
		if (action === "logout") {
			await authLogout();
			return;
		}
		if (action === "status") {
			const config = await loadConfig();
			const me = await request<MeJson>(config, "GET", "/me");
			console.log(`${me.user.name}(${me.user.id})  ${config.url}`);
			return;
		}
		console.error(HELP);
		process.exitCode = 1;
		return;
	}

	const config = await loadConfig();
	const call = <T>(method: string, path: string, body?: unknown) =>
		request<T>(config, method, path, body);
	const members = async () =>
		new Map(
			(await call<MeJson>("GET", "/me")).members.map((m) => [m.id, m.name]),
		);

	switch (command) {
		case "me": {
			const me = await call<MeJson>("GET", "/me");
			console.log(
				`${me.user.name}(${me.user.id})  個人トークン: ${me.user.personalTokenHint ?? "未発行"}`,
			);
			console.log(`メンバー: ${me.members.map((m) => m.name).join("、")}`);
			table(
				["プロバイダ", "base URL"],
				me.providers.map((p) => [
					p.label,
					`${me.proxyOrigin}${p.clientBasePath}`,
				]),
			);
			return;
		}
		case "personal-token": {
			const { token } = await call<{ token: string }>(
				"POST",
				"/me/personal-token",
			);
			console.log(token);
			console.error(
				"このトークンは今だけ表示します。今までの個人トークンは使えなくなりました。",
			);
			return;
		}
		case "cli-tokens": {
			const tokens = await call<CliTokenJson[]>("GET", "/cli-tokens");
			table(
				["ID", "名前", "発行", "最後に使った"],
				tokens.map((t) => [
					t.id,
					t.label ?? "",
					date(t.createdAt),
					date(t.lastUsedAt),
				]),
			);
			return;
		}
		case "provider-keys": {
			if (!sub) {
				const keys = await call<ProviderKeyJson[]>("GET", "/provider-keys");
				table(
					["ID", "プロバイダ", "名前", "キー", "所有者", "sigw キー", "状態"],
					keys.map((k) => [
						k.id,
						k.provider,
						k.label,
						k.keyHint,
						k.ownerName,
						k.activeSigwKeys,
						[
							k.disabledAt === null ? "有効" : "無効",
							k.delegatedOnly ? "代理専用" : "",
						]
							.filter(Boolean)
							.join("・"),
					]),
				);
				return;
			}
			if (sub === "add") {
				const provider = required(values, "provider");
				const apiKey = await prompt(`${provider} の API キー: `);
				const { id } = await call<{ id: string }>("POST", "/provider-keys", {
					provider,
					label: opt(values, "label") ?? "",
					apiKey,
					delegatedOnly: values["delegated-only"] === true,
				});
				console.log(`登録しました: ${id}`);
				return;
			}
			if ((sub === "disable" || sub === "enable") && arg1) {
				await call("POST", `/provider-keys/${arg1}/${sub}`);
				console.log(sub === "disable" ? "無効にしました" : "有効に戻しました");
				return;
			}
			break;
		}
		case "keys": {
			if (!sub) {
				printKeys(await call<SigwKeyJson[]>("GET", "/sigw-keys"));
				return;
			}
			if (sub === "show" && arg1) {
				const key = await call<SigwKeyJson>("GET", `/sigw-keys/${arg1}`);
				printKeys([key]);
				console.log(
					`モデル: ${key.allowedModels?.join(", ") ?? "制限なし"}  トークン: ${key.tokenHint}`,
				);
				const me = await call<MeJson>("GET", "/me");
				const events = await call<UsageEventJson[]>(
					"GET",
					`/usage/events?key=${arg1}&month=${me.month}&limit=50`,
				);
				printEvents(events, new Map(me.members.map((m) => [m.id, m.name])));
				return;
			}
			if (sub === "create") {
				const result = await call<{ id: string; token: string }>(
					"POST",
					"/sigw-keys",
					{
						...keyInput(values),
						providerKeyIds: required(values, "provider-key")
							.split(",")
							.map((value) => value.trim())
							.filter(Boolean),
					},
				);
				console.log(result.token);
				console.error(
					`発行しました(ID ${result.id})。このトークンは今だけ表示します。API キーには「このトークン.個人トークン」を入れます。`,
				);
				return;
			}
			if (sub === "update" && arg1) {
				const current = await call<SigwKeyJson>("GET", `/sigw-keys/${arg1}`);
				await call("PATCH", `/sigw-keys/${arg1}`, keyInput(values, current));
				console.log("保存しました。反映まで最大30秒かかります。");
				return;
			}
			if (sub === "add-provider" && arg1 && arg2) {
				await call("POST", `/sigw-keys/${arg1}/provider-keys`, {
					providerKeyId: arg2,
				});
				console.log("足しました。反映まで最大30秒かかります。");
				return;
			}
			if (sub === "remove-provider" && arg1 && arg2) {
				await call("DELETE", `/sigw-keys/${arg1}/provider-keys/${arg2}`);
				console.log("外しました。反映まで最大30秒かかります。");
				return;
			}
			if (sub === "revoke" && arg1) {
				await call("DELETE", `/sigw-keys/${arg1}`);
				console.log("無効にしました");
				return;
			}
			break;
		}
		case "usage": {
			const month =
				opt(values, "month") ?? (await call<MeJson>("GET", "/me")).month;
			const overview = await call<UsageOverviewJson>(
				"GET",
				`/usage?month=${month}`,
			);
			const names = await members();
			const by = opt(values, "by") ?? "pair";
			const name = (id: string | null) => (id ? (names.get(id) ?? id) : "—");
			const rows = (
				list: UsageSummaryJson[],
				label: (row: UsageSummaryJson) => string,
			) =>
				list.map((row) => [
					label(row),
					row.requests,
					row.inputTokens,
					row.cacheReadTokens + row.cacheWriteTokens,
					row.outputTokens,
					usd(row.costNano),
					row.unpriced || "",
				]);
			const headers = [
				"",
				"呼び出し",
				"入力",
				"キャッシュ",
				"出力",
				"料金",
				"料金不明",
			];
			console.log(month);
			if (by === "user")
				table(
					["利用者", ...headers.slice(1)],
					rows(overview.byUser, (r) => name(r.userId)),
				);
			else if (by === "key") {
				const keys = new Map(
					(await call<SigwKeyJson[]>("GET", "/sigw-keys")).map((k) => [
						k.id,
						k.purpose,
					]),
				);
				table(
					["sigw キー", ...headers.slice(1)],
					rows(
						overview.byKey,
						(r) => keys.get(r.sigwKeyId ?? "") ?? r.sigwKeyId ?? "",
					),
				);
			} else if (by === "model")
				table(
					["モデル", ...headers.slice(1)],
					rows(overview.byModel, (r) => `${r.provider}/${r.model}`),
				);
			else
				table(
					["利用者 → 所有者", ...headers.slice(1)],
					rows(
						overview.pairs,
						(r) =>
							`${name(r.userId)} → ${name(r.ownerId)}${r.userId === r.ownerId ? "(自分)" : ""}`,
					),
				);
			return;
		}
		case "events": {
			const params = new URLSearchParams();
			for (const name of ["month", "user", "key", "limit"]) {
				const value = opt(values, name);
				if (value) params.set(name, value);
			}
			printEvents(
				await call<UsageEventJson[]>("GET", `/usage/events?${params}`),
				await members(),
			);
			return;
		}
		case "settle": {
			if (!sub) {
				const list = await call<SettlementJson[]>("GET", "/settlements");
				table(
					["月", "レート", "行", "合計(円)", "精算した日時", "台帳"],
					list.map((s) => [
						s.month,
						s.usdJpy.toFixed(2),
						s.detail.lines.length,
						s.detail.lines.reduce((sum, line) => sum + line.yen, 0),
						date(s.settledAt),
						s.ledgerUrl ?? "",
					]),
				);
				return;
			}
			if (sub === "preview") {
				const preview = await call<SettlementPreviewJson>(
					"GET",
					`/settlements/${arg1 ?? previousMonth()}`,
				);
				printPreview(preview);
				console.log(
					preview.settled
						? "精算済みです。"
						: preview.settleable
							? "「sigw settle run」で精算できます。"
							: "まだ終わっていない月です。",
				);
				return;
			}
			if (sub === "run" && arg1) {
				const settlement = await call<SettlementJson>(
					"POST",
					`/settlements/${arg1}`,
				);
				printPreview(settlement);
				console.log(
					settlement.ledgerUrl
						? `台帳: ${settlement.ledgerUrl}`
						: "台帳に書く行はありませんでした。",
				);
				return;
			}
			if (sub === "fx" && arg1 && arg2) {
				await call("PUT", `/settlements/${arg1}/fx`, {
					usdJpy: arg2 === "clear" ? null : Number(arg2),
				});
				console.log("保存しました");
				return;
			}
			break;
		}
		case "prices": {
			if (!sub) {
				const params = new URLSearchParams({ limit: "500" });
				const provider = opt(values, "provider");
				const q = opt(values, "q");
				if (provider) params.set("provider", provider);
				if (q) params.set("q", q);
				const prices = await call<PriceRowJson[]>("GET", `/prices?${params}`);
				const perM = (value: number | undefined) =>
					value === undefined ? "—" : `$${+(value * 1e6).toFixed(4)}`;
				table(
					[
						"プロバイダ",
						"モデル",
						"入力/1M",
						"出力/1M",
						"キャッシュ読み/1M",
						"出所",
					],
					prices.map((p) => [
						p.provider,
						p.model,
						perM(p.price.input),
						perM(p.price.output),
						perM(p.price.cacheRead),
						p.source,
					]),
				);
				return;
			}
			if (sub === "set") {
				const optionalNumber = (name: string) => {
					const value = opt(values, name);
					return value === undefined ? null : Number(value);
				};
				const result = await call<{ repriced: number }>("PUT", "/prices", {
					provider: required(values, "provider"),
					model: required(values, "model"),
					inputPerM: Number(required(values, "input")),
					outputPerM: Number(required(values, "output")),
					cacheReadPerM: optionalNumber("cache-read"),
					cacheWritePerM: optionalNumber("cache-write"),
				});
				console.log(
					`保存しました(料金を計算し直した呼び出し: ${result.repriced} 件)`,
				);
				return;
			}
			if (sub === "rm") {
				const params = new URLSearchParams({
					provider: required(values, "provider"),
					model: required(values, "model"),
				});
				await call("DELETE", `/prices?${params}`);
				console.log("消しました");
				return;
			}
			if (sub === "sync") {
				const result = await call<{ synced: number; repriced: number }>(
					"POST",
					"/prices/sync",
				);
				console.log(
					`${result.synced} 件を取り込みました(料金を計算し直した呼び出し: ${result.repriced} 件)`,
				);
				return;
			}
			break;
		}
	}
	console.error(HELP);
	process.exitCode = 1;
}

main().catch((error: unknown) => {
	console.error(
		`エラー: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
});
