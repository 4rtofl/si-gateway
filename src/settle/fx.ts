/*
 * USD/JPY の為替レートを取得する。Frankfurter(欧州中央銀行の参照レート)を使い、
 * 取得できなければ open.er-api.com を使う。どちらもキーは要らない。
 */

import type { Fetch } from "../lib/http.ts";

export interface FxRate {
	usdJpy: number;
	source: string;
}

const SOURCES: {
	name: string;
	url: string;
	read: (data: unknown) => unknown;
}[] = [
	{
		name: "frankfurter",
		url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY",
		read: (data) => (data as { rates?: { JPY?: unknown } }).rates?.JPY,
	},
	{
		name: "open.er-api.com",
		url: "https://open.er-api.com/v6/latest/USD",
		read: (data) => (data as { rates?: { JPY?: unknown } }).rates?.JPY,
	},
];

export async function fetchUsdJpy(fetcher: Fetch): Promise<FxRate> {
	const failures: string[] = [];
	for (const source of SOURCES) {
		try {
			const response = await fetcher(source.url, {
				headers: { "User-Agent": "sigw" },
			});
			if (!response.ok) {
				failures.push(`${source.name}: ${response.status}`);
				continue;
			}
			const rate = source.read(await response.json());
			if (typeof rate === "number" && rate > 50 && rate < 500) {
				return { usdJpy: rate, source: source.name };
			}
			failures.push(`${source.name}: レートを読めません`);
		} catch (error) {
			failures.push(
				`${source.name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	throw new Error(`為替レートを取得できませんでした(${failures.join("、")})`);
}
