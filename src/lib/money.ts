/*
 * 金額の扱い。料金は 10^-9 USD(nano USD)単位の整数で持つ。
 * 1トークンの単価が 10^-8 USD 程度のモデルもあるので、マイクロ USD では足りない。
 */

export const NANO_PER_USD = 1_000_000_000;

/** USD(小数)を nano USD にする */
export function usdToNano(usd: number): number {
	return Math.round(usd * NANO_PER_USD);
}

/** nano USD を USD(小数)にする */
export function nanoToUsd(nano: number): number {
	return nano / NANO_PER_USD;
}

/** 画面に出す USD。1ドル未満は桁を増やす */
export function formatUsd(nano: number | null | undefined): string {
	if (nano === null || nano === undefined) {
		return "—";
	}
	const usd = nanoToUsd(nano);
	const digits = Math.abs(usd) >= 1 ? 2 : Math.abs(usd) >= 0.01 ? 4 : 6;
	return `$${usd.toFixed(digits)}`;
}

/**
 * 偶数丸め(銀行丸め)で整数にする。Daichoo の精算と同じ丸め方。
 * ちょうど0.5のときは偶数のほうへ、それ以外は近いほうへ丸める
 */
export function roundHalfEven(value: number): number {
	const floor = Math.floor(value);
	const diff = value - floor;
	const epsilon = 1e-9;
	if (Math.abs(diff - 0.5) < epsilon) {
		return floor % 2 === 0 ? floor : floor + 1;
	}
	return Math.round(value);
}

/** 円の表示(1,234円) */
export function formatYen(yen: number): string {
	return `${yen.toLocaleString("ja-JP")}円`;
}
