/** 表示の整形。金額は nano USD(10^-9 USD)で受け取る */

export function formatUsd(nano: number | null | undefined): string {
	if (nano === null || nano === undefined) return "—";
	if (nano === 0) return "$0";
	const usd = nano / 1e9;
	const digits = Math.abs(usd) >= 1 ? 2 : Math.abs(usd) >= 0.01 ? 4 : 6;
	return `$${usd.toFixed(digits)}`;
}

export function formatYen(yen: number): string {
	return `${yen.toLocaleString("ja-JP")}円`;
}

export function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (value >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
	return value.toLocaleString("en-US");
}

const JST = 9 * 60 * 60 * 1000;

/** 日本時間の「2026-11-13 22:38」 */
export function formatDateTime(ms: number): string {
	return new Date(ms + JST).toISOString().slice(0, 16).replace("T", " ");
}

/** 日本時間の「2026-11-13」 */
export function formatDate(ms: number): string {
	return new Date(ms + JST).toISOString().slice(0, 10);
}

export function monthLabel(month: string): string {
	const [year, number] = month.split("-");
	return `${year}年${Number(number)}月`;
}

export function shiftMonth(month: string, delta: number): string {
	const [year, number] = month.split("-").map(Number) as [number, number];
	const index = year * 12 + (number - 1) + delta;
	return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** Date(画面で選んだ日付)を「2026-12-31」にする */
export function toDateString(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
