#!/usr/bin/env node
/*
 * sigw の CLI。Web UI の「設定」で発行した CLI トークンで、JSON API(/api/*)を呼ぶ。
 * Node.js 24 で、ビルドせずに「node cli/sigw.ts」(pnpm cli)として動く。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type {
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

const CONFIG_PATH = join(
	process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
	"sigw",
	"config.json",
);

interface Config {
	url: string;
	token: string;
}

const HELP = `sigw の CLI

使い方: pnpm cli <コマンド> [引数]

  login <URL>                         CLI トークンを入れて保存する(${CONFIG_PATH})
  me                                  自分とメンバー、クライアントの base URL
  personal-token                      個人トークンを発行し直す

  provider-keys                       プロバイダキーの一覧
  provider-keys add --provider <openai|anthropic|xai|openrouter> [--label 名前]
                                      プロバイダキーを登録する(キーは標準入力から読む)
  provider-keys disable|enable <ID>   プロバイダキーを無効にする・有効に戻す

  keys                                sigw キーの一覧
  keys show <ID>                      sigw キーの詳細と今月の呼び出し
  keys create --provider-key <ID> --purpose <目的> [--models a,b] [--limit USD] [--expires YYYY-MM-DD]
  keys update <ID> [--purpose 目的] [--models a,b|""] [--limit USD|""] [--expires YYYY-MM-DD|""]
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
			"ログインしていません。「pnpm cli login <URL>」を実行するか、SIGW_URL と SIGW_TOKEN を設定してください",
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
				: key.providerKeyDisabled
					? "プロバイダキーが無効"
					: key.expiresAt !== null && key.expiresAt < Date.now()
						? "期限切れ"
						: "有効",
			`${key.provider}/${key.providerKeyLabel}(${key.ownerName})`,
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
			names.get(event.userId) ?? event.userId,
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
			help: { type: "boolean", short: "h" },
		},
	});
	const [command, sub, arg1, arg2] = positionals;
	if (!command || values.help) {
		console.log(HELP);
		return;
	}

	if (command === "login") {
		if (!sub)
			throw new Error(
				"URL を指定してください(例 pnpm cli login https://sigw.example.workers.dev)",
			);
		const token =
			process.env.SIGW_TOKEN ?? (await prompt("CLI トークン(sgc_…): "));
		const config = { url: sub.replace(/\/$/, ""), token };
		const me = await request<MeJson>(config, "GET", "/me");
		await mkdir(join(CONFIG_PATH, ".."), { recursive: true });
		await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), {
			mode: 0o600,
		});
		console.log(`${me.user.name} としてログインしました(${CONFIG_PATH})`);
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
						k.disabledAt === null ? "有効" : "無効",
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
						providerKeyId: required(values, "provider-key"),
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
							? "「pnpm cli settle run」で精算できます。"
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
