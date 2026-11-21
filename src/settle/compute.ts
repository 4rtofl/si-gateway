/*
 * 精算の計算。前月の使用量を「利用者 → プロバイダキーの所有者」ごとに円にする。
 * 自分のキーを自分で使った分は、請求しない。
 */

import { roundHalfEven } from "../lib/money.ts";

/** 利用者と所有者の組ごとの、月の合計 */
export interface PairTotal {
	userId: string;
	ownerId: string;
	costNano: number;
	requests: number;
	unpriced: number;
}

/** 台帳に書く1行 */
export interface SettlementLine {
	/** 台帳の id(sigw-2026-11-<所有者>-<利用者>) */
	id: string;
	/** プロバイダキーの所有者(Daichoo でいう「おごった人」) */
	payerId: string;
	payerName: string;
	/** 使った人(Daichoo でいう「おごられた人」) */
	debtorId: string;
	debtorName: string;
	costNano: number;
	yen: number;
}

export function ledgerEntryId(
	month: string,
	payerId: string,
	debtorId: string,
): string {
	return `sigw-${month}-${payerId}-${debtorId}`;
}

/** 組ごとの合計と為替レートから、台帳に書く行を作る。0円になった組は書かない */
export function computeSettlementLines(
	month: string,
	totals: readonly PairTotal[],
	usdJpy: number,
	names: ReadonlyMap<string, string>,
): SettlementLine[] {
	if (!(usdJpy > 0)) {
		throw new Error("為替レートが正しくありません");
	}
	const lines: SettlementLine[] = [];
	for (const total of totals) {
		if (total.userId === total.ownerId || total.costNano <= 0) {
			continue;
		}
		const yen = roundHalfEven((total.costNano / 1e9) * usdJpy);
		if (yen < 1) {
			continue;
		}
		lines.push({
			id: ledgerEntryId(month, total.ownerId, total.userId),
			payerId: total.ownerId,
			payerName: names.get(total.ownerId) ?? total.ownerId,
			debtorId: total.userId,
			debtorName: names.get(total.userId) ?? total.userId,
			costNano: total.costNano,
			yen,
		});
	}
	return lines.sort((a, b) => b.yen - a.yen);
}

/** 台帳の memo(例「LLM 2026-11 $12.345678 @154.32 (sigw)」) */
export function ledgerMemo(
	month: string,
	line: SettlementLine,
	usdJpy: number,
): string {
	return `LLM ${month} $${(line.costNano / 1e9).toFixed(6)} @${usdJpy.toFixed(2)} (sigw)`;
}
