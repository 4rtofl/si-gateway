/*
 * 中継するプロバイダの一覧。パスの先頭(/openai など)で、どのプロバイダに転送するかを決める。
 */

export type ProviderId =
	| "openai"
	| "anthropic"
	| "xai"
	| "openrouter"
	| "typesafe";

/** 使用量の書き方。OpenAI 互換か、Anthropic の Messages API か */
export type UsageStyle = "openai" | "anthropic";

/**
 * sigw が返すエラーの形。SDK やクライアントがメッセージを読めるよう、プロバイダに合わせる。
 * - openai: { error: { message, type, code } }
 * - anthropic: { type: "error", error: { type, message } }
 * - detail: { detail }(TypeSafe。https://docs.typesafe.ai/api/errors)
 */
export type ErrorStyle = "openai" | "anthropic" | "detail";

export interface ProviderSpec {
	id: ProviderId;
	/** 画面に出す名前 */
	label: string;
	/** 転送先のオリジン */
	origin: string;
	/** プロバイダキーの渡し方 */
	auth: "bearer" | "x-api-key";
	usageStyle: UsageStyle;
	errorStyle: ErrorStyle;
	/** クライアントに設定してもらう base URL の、sigw のオリジンより後ろの部分 */
	clientBasePath: string;
	/** 使用量を呼び出しのときに受け取れないので、中継しないパス(前方一致) */
	blockedPaths: readonly string[];
	/** LiteLLM の価格表での litellm_provider の値。価格表にないプロバイダは null(単価は「価格」で手で決める) */
	litellmProvider: string | null;
}

export const PROVIDERS: Readonly<Record<ProviderId, ProviderSpec>> = {
	openai: {
		id: "openai",
		label: "OpenAI",
		origin: "https://api.openai.com",
		auth: "bearer",
		usageStyle: "openai",
		errorStyle: "openai",
		clientBasePath: "/openai/v1",
		blockedPaths: ["/v1/batches", "/v1/realtime"],
		litellmProvider: "openai",
	},
	anthropic: {
		id: "anthropic",
		label: "Anthropic",
		origin: "https://api.anthropic.com",
		auth: "x-api-key",
		usageStyle: "anthropic",
		errorStyle: "anthropic",
		clientBasePath: "/anthropic",
		blockedPaths: ["/v1/messages/batches"],
		litellmProvider: "anthropic",
	},
	xai: {
		id: "xai",
		label: "xAI",
		origin: "https://api.x.ai",
		auth: "bearer",
		usageStyle: "openai",
		errorStyle: "openai",
		clientBasePath: "/xai/v1",
		blockedPaths: ["/v1/batches", "/v1/realtime"],
		litellmProvider: "xai",
	},
	openrouter: {
		id: "openrouter",
		label: "OpenRouter",
		origin: "https://openrouter.ai",
		auth: "bearer",
		usageStyle: "openai",
		errorStyle: "openai",
		clientBasePath: "/openrouter/api/v1",
		blockedPaths: [],
		litellmProvider: "openrouter",
	},
	typesafe: {
		id: "typesafe",
		label: "TypeSafe",
		origin: "https://api.typesafe.ai",
		auth: "bearer",
		// 応答の usage.input_tokens と usage.output_tokens を、OpenAI の Responses API と同じ読み方で読む
		usageStyle: "openai",
		errorStyle: "detail",
		clientBasePath: "/typesafe/v1",
		blockedPaths: [],
		litellmProvider: null,
	},
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
	return Object.hasOwn(PROVIDERS, value);
}

/** パスの先頭からプロバイダを取り出す。「/openai/v1/chat/completions」なら openai と「/v1/chat/completions」 */
export function matchProviderPath(
	pathname: string,
): { provider: ProviderSpec; upstreamPath: string } | null {
	const slash = pathname.indexOf("/", 1);
	const head = slash === -1 ? pathname.slice(1) : pathname.slice(1, slash);
	if (!isProviderId(head)) {
		return null;
	}
	return {
		provider: PROVIDERS[head],
		upstreamPath: slash === -1 ? "/" : pathname.slice(slash),
	};
}

export function isBlockedPath(provider: ProviderSpec, path: string): boolean {
	return provider.blockedPaths.some(
		(blocked) => path === blocked || path.startsWith(`${blocked}/`),
	);
}
