/*
 * 中継するプロバイダの一覧。パスの先頭(/openai など)で、どのプロバイダに転送するかを決める。
 */

export type ProviderId = "openai" | "anthropic" | "xai" | "openrouter";

/** 使用量の書き方。OpenAI 互換か、Anthropic の Messages API か */
export type UsageStyle = "openai" | "anthropic";

export interface ProviderSpec {
	id: ProviderId;
	/** 画面に出す名前 */
	label: string;
	/** 転送先のオリジン */
	origin: string;
	/** プロバイダキーの渡し方 */
	auth: "bearer" | "x-api-key";
	usageStyle: UsageStyle;
	/** クライアントに設定してもらう base URL の、sigw のオリジンより後ろの部分 */
	clientBasePath: string;
	/** 使用量を呼び出しのときに受け取れないので、中継しないパス(前方一致) */
	blockedPaths: readonly string[];
	/** LiteLLM の価格表での litellm_provider の値 */
	litellmProvider: string;
}

export const PROVIDERS: Readonly<Record<ProviderId, ProviderSpec>> = {
	openai: {
		id: "openai",
		label: "OpenAI",
		origin: "https://api.openai.com",
		auth: "bearer",
		usageStyle: "openai",
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
		clientBasePath: "/openrouter/api/v1",
		blockedPaths: [],
		litellmProvider: "openrouter",
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
