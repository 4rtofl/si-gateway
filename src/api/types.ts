/*
 * JSON API の応答の型。Web UI(ui/)と CLI(cli/)からも読み込む。
 * 金額は nano USD(10^-9 USD)の整数、時刻は UNIX ミリ秒。
 */

export type ProviderIdJson =
	| "openai"
	| "anthropic"
	| "xai"
	| "openrouter"
	| "typesafe";

export interface MemberJson {
	id: string;
	name: string;
	avatar: string | null;
}

export interface ProviderJson {
	id: ProviderIdJson;
	label: string;
	clientBasePath: string;
}

export interface MeJson {
	user: MemberJson & { personalTokenHint: string | null };
	members: MemberJson[];
	providers: ProviderJson[];
	/** LLM を呼び出すときのオリジン(クライアントの base URL に使う) */
	proxyOrigin: string;
	/** CLI のインストールスクリプトを配るオリジン。手元(localhost)では null */
	cliOrigin: string | null;
	/** 今月(日本時間) */
	month: string;
}

/**
 * sigw キーに登録した API キー(プロバイダキー)。sigw キー1つに、プロバイダごとに1つまで。
 * キーそのものは返さず、末尾4文字だけを返す
 */
export interface LinkedProviderKeyJson {
	/** プロバイダキーの ID */
	id: string;
	provider: ProviderIdJson;
	/** 末尾4文字 */
	keyLast4: string;
	/** 登録した人 */
	ownerId: string;
	ownerName: string;
	/** プロバイダキーが無効。このプロバイダだけ呼べない */
	disabled: boolean;
	delegatedOnly: boolean;
	/** 登録した時刻 */
	linkedAt: number;
}

export interface SigwKeyJson {
	id: string;
	/** 登録した API キー。プロバイダの並び(openai、anthropic、xai、openrouter、typesafe)の順 */
	providerKeys: LinkedProviderKeyJson[];
	createdBy: string;
	createdByName: string;
	purpose: string;
	tokenHint: string;
	allowedModels: string[] | null;
	monthlyLimitNano: number | null;
	expiresAt: number | null;
	createdAt: number;
	revokedAt: number | null;
	/** 削除した時刻。削除したキーは、GET /sigw-keys?includeDeleted=1 でだけ返す */
	deletedAt: number | null;
	/** 呼び出した人が、設定の変更・無効化・削除と、API キーの登録・差し替え・外すをできるか */
	editable: boolean;
	/** 今月の使用額(全プロバイダの合計) */
	monthSpendNano: number;
	monthRequests: number;
}

/** sigw キーに登録する API キー。PUT /sigw-keys/:id/providers/:provider では provider を使わない(パスで決まる) */
export interface SigwKeyApiKeyInput {
	provider?: string;
	apiKey?: string;
	/** 代理専用。登録したあとは変えられない */
	delegatedOnly?: boolean;
}

export interface SigwKeyInput {
	/** 発行のときに登録する API キー。プロバイダごとに1つまで。0個でもよい。変更(PATCH)では使わない */
	apiKeys?: SigwKeyApiKeyInput[];
	purpose: string;
	/** 空の配列か null なら制限なし */
	allowedModels: string[] | null;
	/** USD。null なら上限なし */
	monthlyLimitUsd: number | null;
	/** 日本時間の日付(2026-12-31)。null なら期限なし */
	expiresOn: string | null;
}

export interface UsageSummaryJson {
	userId: string | null;
	ownerId: string | null;
	sigwKeyId: string | null;
	provider: string | null;
	model: string | null;
	requests: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	costNano: number;
	unpriced: number;
	errors: number;
}

export interface UsageOverviewJson {
	month: string;
	pairs: UsageSummaryJson[];
	byUser: UsageSummaryJson[];
	byKey: UsageSummaryJson[];
	byModel: UsageSummaryJson[];
	/** 日本時間の日(1〜31)× 利用者 × 所有者ごとの料金 */
	daily: { day: number; userId: string; ownerId: string; costNano: number }[];
}

export interface UsageEventJson {
	id: string;
	createdAt: number;
	userId: string;
	sigwKeyId: string;
	ownerId: string;
	provider: string;
	method: string;
	path: string;
	model: string | null;
	stream: boolean;
	status: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	costNano: number | null;
	costSource: string | null;
	incomplete: boolean;
	ttfbMs: number | null;
	durationMs: number | null;
	error: string | null;
	/** 代理の呼び出し(Bobert から)なら 'bobert'、公開の入口なら null */
	via: string | null;
}

export interface SettlementLineJson {
	id: string;
	payerId: string;
	payerName: string;
	debtorId: string;
	debtorName: string;
	costNano: number;
	yen: number;
}

export interface SettlementJson {
	month: string;
	usdJpy: number;
	fxSource: string;
	detail: {
		lines: SettlementLineJson[];
		unpriced: number;
		selfUseNano: number;
	};
	ledgerUrl: string | null;
	settledAt: number;
	settledBy: string;
}

export interface SettlementPreviewJson {
	month: string;
	usdJpy: number;
	fxSource: string;
	detail: {
		lines: SettlementLineJson[];
		unpriced: number;
		selfUseNano: number;
	};
	settled: SettlementJson | null;
	/** 精算できる月か(終わった月で、まだ精算していない) */
	settleable: boolean;
}

export interface PriceJson {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheWrite1h?: number;
	inputAbove200k?: number;
	outputAbove200k?: number;
	cacheReadAbove200k?: number;
	cacheWriteAbove200k?: number;
	webSearch?: number;
	tiers?: Record<string, Partial<PriceJson>>;
}

export interface PriceRowJson {
	provider: string;
	model: string;
	source: "litellm" | "manual";
	price: PriceJson;
	updatedAt: number;
}

/** 単価の入力。100万トークンあたりの USD */
export interface PriceInput {
	provider: string;
	model: string;
	inputPerM: number;
	outputPerM: number;
	cacheReadPerM?: number | null;
	cacheWritePerM?: number | null;
}

export interface CliTokenJson {
	id: string;
	label: string | null;
	createdAt: number;
	lastUsedAt: number | null;
}

/** POST /api/cli-login/start(ログインしなくても呼べる) */
export interface CliLoginStartJson {
	deviceCode: string;
	userCode: string;
	/** ブラウザで開く画面 */
	verificationUrl: string;
	expiresAt: number;
	intervalMs: number;
}

/** POST /api/cli-login/poll(ログインしなくても呼べる) */
export type CliLoginPollJson =
	| { status: "pending" | "denied" | "expired" }
	| { status: "approved"; token: string; userName: string };

/** GET /api/cli-login/:code(Web UI の許可の画面) */
export interface CliLoginJson {
	userCode: string;
	clientName: string;
	status: "pending" | "approved" | "denied";
	expiresAt: number;
}

export interface ApiErrorJson {
	error: string;
}
