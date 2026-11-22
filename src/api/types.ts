/*
 * JSON API の応答の型。Web UI(ui/)と CLI(cli/)からも読み込む。
 * 金額は nano USD(10^-9 USD)の整数、時刻は UNIX ミリ秒。
 */

export type ProviderIdJson = "openai" | "anthropic" | "xai" | "openrouter";

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

export interface ProviderKeyJson {
	id: string;
	ownerId: string;
	ownerName: string;
	provider: ProviderIdJson;
	label: string;
	keyHint: string;
	createdAt: number;
	disabledAt: number | null;
	activeSigwKeys: number;
	/** 代理専用。これにつながる sigw キーは、Bobert からの代理の呼び出しでしか使えない */
	delegatedOnly: boolean;
}

export interface SigwKeyJson {
	id: string;
	providerKeyId: string;
	provider: ProviderIdJson;
	providerKeyLabel: string;
	ownerId: string;
	ownerName: string;
	createdBy: string;
	createdByName: string;
	purpose: string;
	tokenHint: string;
	allowedModels: string[] | null;
	monthlyLimitNano: number | null;
	expiresAt: number | null;
	createdAt: number;
	revokedAt: number | null;
	providerKeyDisabled: boolean;
	/** 今月の使用額 */
	monthSpendNano: number;
	monthRequests: number;
}

export interface SigwKeyInput {
	providerKeyId?: string;
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
