/*
 * 単価表(D1 の model_prices)の読み書きと、LiteLLM の価格表からの同期。
 */

import { badRequest } from "../lib/errors.ts";
import {
	isProviderId,
	PROVIDERS,
	type ProviderId,
} from "../proxy/providers.ts";
import { computeCostNano, findPrice, withoutLongContext } from "./cost.ts";
import type { Price, PriceRow } from "./types.ts";

export const LITELLM_PRICES_URL =
	"https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** isolate のメモリに置く単価表。プロバイダごと */
const cache = new Map<
	string,
	{ prices: Map<string, Price>; loadedAt: number }
>();
const CACHE_TTL_MS = 10 * 60 * 1000;

export function clearPriceCache(): void {
	cache.clear();
}

/** プロバイダの単価表を「モデル名 → 単価」で返す。10分のあいだメモリに置く */
export async function loadProviderPrices(
	db: D1Database | D1DatabaseSession,
	provider: string,
	now = Date.now(),
): Promise<Map<string, Price>> {
	const cached = cache.get(provider);
	if (cached && now - cached.loadedAt < CACHE_TTL_MS) {
		return cached.prices;
	}
	const { results } = await db
		.prepare("SELECT model, price FROM model_prices WHERE provider = ?")
		.bind(provider)
		.all<{ model: string; price: string }>();
	const prices = new Map<string, Price>();
	for (const row of results) {
		try {
			prices.set(row.model, JSON.parse(row.price) as Price);
		} catch {
			// 壊れた行は読み飛ばす
		}
	}
	cache.set(provider, { prices, loadedAt: now });
	return prices;
}

export async function listPrices(
	db: D1Database,
	options: { provider?: string; query?: string; limit?: number } = {},
): Promise<PriceRow[]> {
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (options.provider) {
		where.push("provider = ?");
		params.push(options.provider);
	}
	if (options.query) {
		where.push("model LIKE ?");
		params.push(`%${options.query.replace(/[%_]/g, "")}%`);
	}
	params.push(Math.min(options.limit ?? 200, 1000));
	const { results } = await db
		.prepare(
			`SELECT provider, model, source, price, updated_at FROM model_prices
			 ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY source = 'manual' DESC, provider, model LIMIT ?`,
		)
		.bind(...params)
		.all<{
			provider: string;
			model: string;
			source: "litellm" | "manual";
			price: string;
			updated_at: number;
		}>();
	return results.map((row) => ({
		provider: row.provider,
		model: row.model,
		source: row.source,
		price: JSON.parse(row.price) as Price,
		updatedAt: row.updated_at,
	}));
}

export function validatePrice(price: Price): Price {
	const fields: (keyof Price)[] = [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"cacheWrite1h",
		"webSearch",
	];
	const clean: Price = { input: 0, output: 0 };
	for (const field of fields) {
		const value = price[field];
		if (value === undefined || value === null) {
			continue;
		}
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw badRequest(`${field} は0以上の数にしてください`);
		}
		(clean as unknown as Record<string, number>)[field] = value;
	}
	if (price.input === undefined || price.output === undefined) {
		throw badRequest("入力と出力の単価は必ず入れてください");
	}
	return clean;
}

/** 手で単価を決める。同期では上書きされない */
export async function setManualPrice(
	db: D1Database,
	provider: string,
	model: string,
	price: Price,
): Promise<void> {
	if (!isProviderId(provider)) {
		throw badRequest(`プロバイダ ${provider} には対応していません`);
	}
	const name = model.trim();
	if (name === "") {
		throw badRequest("モデル名を入れてください");
	}
	await db
		.prepare(
			`INSERT INTO model_prices (provider, model, source, price, updated_at) VALUES (?1, ?2, 'manual', ?3, ?4)
			 ON CONFLICT (provider, model) DO UPDATE SET source = 'manual', price = ?3, updated_at = ?4`,
		)
		.bind(provider, name, JSON.stringify(validatePrice(price)), Date.now())
		.run();
	clearPriceCache();
}

/** 手で決めた単価を消す。次の同期で、LiteLLM の単価に戻る */
export async function deleteManualPrice(
	db: D1Database,
	provider: string,
	model: string,
): Promise<void> {
	await db
		.prepare(
			"DELETE FROM model_prices WHERE provider = ? AND model = ? AND source = 'manual'",
		)
		.bind(provider, model)
		.run();
	clearPriceCache();
}

type LiteLlmEntry = Record<string, unknown>;

function price(entry: LiteLlmEntry, field: string): number | undefined {
	const value = entry[field];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** LiteLLM の価格表の1項目を Price にする。入力と出力の単価がなければ null */
export function priceFromLiteLlm(entry: LiteLlmEntry): Price | null {
	const input = price(entry, "input_cost_per_token");
	const output = price(entry, "output_cost_per_token") ?? 0;
	if (input === undefined) {
		return null;
	}
	const result: Price = { input, output };
	const optional: [keyof Price, string][] = [
		["cacheRead", "cache_read_input_token_cost"],
		["cacheWrite", "cache_creation_input_token_cost"],
		["cacheWrite1h", "cache_creation_input_token_cost_above_1hr"],
		["inputAbove200k", "input_cost_per_token_above_200k_tokens"],
		["outputAbove200k", "output_cost_per_token_above_200k_tokens"],
		["cacheReadAbove200k", "cache_read_input_token_cost_above_200k_tokens"],
		[
			"cacheWriteAbove200k",
			"cache_creation_input_token_cost_above_200k_tokens",
		],
	];
	for (const [key, field] of optional) {
		const value = price(entry, field);
		if (value !== undefined) {
			(result as unknown as Record<string, number>)[key] = value;
		}
	}
	// Web 検索の単価は、検索の文脈の量(low・medium・high)ごとに書かれている。Anthropic はどれも同じなので medium を使う
	const search = entry.search_context_cost_per_query;
	if (typeof search === "object" && search !== null) {
		const perQuery = search as LiteLlmEntry;
		const value =
			price(perQuery, "search_context_size_medium") ??
			price(perQuery, "search_context_size_low") ??
			price(perQuery, "search_context_size_high");
		if (value !== undefined) {
			result.webSearch = value;
		}
	}
	const tiers: Record<string, Partial<Price>> = {};
	for (const tier of ["flex", "priority"]) {
		const tierPrice: Partial<Price> = {};
		const tierInput = price(entry, `input_cost_per_token_${tier}`);
		const tierOutput = price(entry, `output_cost_per_token_${tier}`);
		const tierCache = price(entry, `cache_read_input_token_cost_${tier}`);
		if (tierInput !== undefined) tierPrice.input = tierInput;
		if (tierOutput !== undefined) tierPrice.output = tierOutput;
		if (tierCache !== undefined) tierPrice.cacheRead = tierCache;
		if (Object.keys(tierPrice).length > 0) {
			tiers[tier] = tierPrice;
		}
	}
	if (Object.keys(tiers).length > 0) {
		result.tiers = tiers;
	}
	return result;
}

/** LiteLLM の価格表から、対応するプロバイダの行を取り出す */
export function extractLiteLlmPrices(
	data: Record<string, unknown>,
): { provider: ProviderId; model: string; price: Price }[] {
	const byLiteLlm = new Map<string, ProviderId>();
	for (const spec of Object.values(PROVIDERS)) {
		// 価格表にないプロバイダ(TypeSafe)は取り込まない。手で決めた単価だけを使う
		if (spec.litellmProvider !== null) {
			byLiteLlm.set(spec.litellmProvider, spec.id);
		}
	}
	const rows: { provider: ProviderId; model: string; price: Price }[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (typeof value !== "object" || value === null) {
			continue;
		}
		const entry = value as LiteLlmEntry;
		const provider =
			typeof entry.litellm_provider === "string"
				? byLiteLlm.get(entry.litellm_provider)
				: undefined;
		if (!provider) {
			continue;
		}
		const result = priceFromLiteLlm(entry);
		if (!result) {
			continue;
		}
		const prefix = `${entry.litellm_provider}/`;
		const model = key.startsWith(prefix) ? key.slice(prefix.length) : key;
		rows.push({ provider, model, price: result });
	}
	return rows;
}

/** LiteLLM の価格表を取り込む。手で決めた単価は上書きしない。取り込んだ行数を返す */
export async function syncLiteLlmPrices(
	db: D1Database,
	fetcher: typeof fetch = fetch,
): Promise<number> {
	const response = await fetcher(LITELLM_PRICES_URL, {
		headers: { "User-Agent": "sigw" },
	});
	if (!response.ok) {
		throw new Error(
			`LiteLLM の価格表を取得できませんでした(${response.status})`,
		);
	}
	const rows = extractLiteLlmPrices(
		(await response.json()) as Record<string, unknown>,
	);
	const now = Date.now();
	const statement = db.prepare(
		`INSERT INTO model_prices (provider, model, source, price, updated_at) VALUES (?1, ?2, 'litellm', ?3, ?4)
		 ON CONFLICT (provider, model) DO UPDATE SET price = ?3, updated_at = ?4 WHERE source = 'litellm'`,
	);
	for (let i = 0; i < rows.length; i += 50) {
		await db.batch(
			rows
				.slice(i, i + 50)
				.map((row) =>
					statement.bind(
						row.provider,
						row.model,
						JSON.stringify(row.price),
						now,
					),
				),
		);
	}
	clearPriceCache();
	return rows.length;
}

/** 料金が不明な呼び出しを、今の単価表で計算し直す。計算できた行数を返す */
export async function repriceUnpriced(db: D1Database): Promise<number> {
	const { results } = await db
		.prepare(
			`SELECT id, provider, path, model, input_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, output_tokens, web_search_requests, service_tier
			 FROM usage_events WHERE cost_nano_usd IS NULL LIMIT 2000`,
		)
		.all<{
			id: string;
			provider: string;
			path: string;
			model: string | null;
			input_tokens: number;
			cache_read_tokens: number;
			cache_write_tokens: number;
			cache_write_1h_tokens: number;
			output_tokens: number;
			web_search_requests: number;
			service_tier: string | null;
		}>();
	const updates: D1PreparedStatement[] = [];
	const statement = db.prepare(
		"UPDATE usage_events SET cost_nano_usd = ?, cost_source = 'pricing' WHERE id = ? AND cost_nano_usd IS NULL",
	);
	for (const row of results) {
		if (!row.model) {
			continue;
		}
		const prices = await loadProviderPrices(db, row.provider);
		const found = findPrice(prices, row.model);
		if (!found) {
			continue;
		}
		const cost = computeCostNano(
			{
				inputTokens: row.input_tokens,
				cacheReadTokens: row.cache_read_tokens,
				cacheWriteTokens: row.cache_write_tokens,
				cacheWrite1hTokens: row.cache_write_1h_tokens,
				outputTokens: row.output_tokens,
				webSearchRequests: row.web_search_requests,
			},
			// Managed Agents のセッションの行は、累計の差なので長い入力の単価を使わない(src/proxy/agent-sessions.ts)
			row.path.startsWith("/v1/sessions/") ? withoutLongContext(found) : found,
			row.service_tier,
		);
		updates.push(statement.bind(cost, row.id));
	}
	for (let i = 0; i < updates.length; i += 50) {
		await db.batch(updates.slice(i, i + 50));
	}
	return updates.length;
}
