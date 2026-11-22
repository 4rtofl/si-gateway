/** モデルの単価(USD / トークン)。LiteLLM の価格表の項目に合わせている */
export interface Price {
	input: number;
	output: number;
	cacheRead?: number;
	/** キャッシュへの書き込み(Anthropic の5分) */
	cacheWrite?: number;
	/** キャッシュへの書き込み(Anthropic の1時間)。なければ input の2倍 */
	cacheWrite1h?: number;
	/** 入力の合計が20万トークンを超えたときの単価 */
	inputAbove200k?: number;
	outputAbove200k?: number;
	cacheReadAbove200k?: number;
	cacheWriteAbove200k?: number;
	/** サーバー側の Web 検索1回の単価(USD / 回)。なければ DEFAULT_WEB_SEARCH_PRICE */
	webSearch?: number;
	/** service_tier(flex、priority など)ごとの単価。書かれた項目だけ置き換える */
	tiers?: Record<string, Partial<Price>>;
}

/** 単価表の1行 */
export interface PriceRow {
	provider: string;
	model: string;
	source: "litellm" | "manual";
	price: Price;
	updatedAt: number;
}
