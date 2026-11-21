/*
 * Daichoo の台帳(ledger/YYYY-MM.tsv)に、精算の行を足す。
 * 台帳の形式は Daichoo の README.md「台帳の形式」に合わせる。見出しの並びが手で変えられていても、その並びに合わせて書く。
 */

import { formatJst } from "../lib/time.ts";
import { ledgerMemo, type SettlementLine } from "./compute.ts";

/** Daichoo の金額の上限(円) */
export const MAX_AMOUNT = 1_000_000;

const DEFAULT_HEADER = [
	"id",
	"recorded_at",
	"payer_id",
	"payer_name",
	"debtor_id",
	"debtor_name",
	"amount",
	"split",
	"memo",
];

export function ledgerPath(month: string): string {
	return `ledger/${month}.tsv`;
}

function clean(value: string): string {
	return value.replace(/[\t\r\n]+/g, " ");
}

/**
 * 台帳の TSV に行を足した文字列を返す。ファイルがなければ見出しから作る。
 * 同じ id の行がすでにある行は足さない。足す行がなければ null を返す。
 */
export function appendSettlementLines(
	current: string | null,
	month: string,
	lines: readonly SettlementLine[],
	usdJpy: number,
	now: number,
): string | null {
	for (const line of lines) {
		if (
			!Number.isSafeInteger(line.yen) ||
			line.yen < 1 ||
			line.yen > MAX_AMOUNT
		) {
			throw new Error(
				`${line.debtorName} → ${line.payerName} の金額 ${line.yen}円は、台帳に書ける範囲(1〜${MAX_AMOUNT}円)を超えています`,
			);
		}
	}
	const text = current?.replace(/^﻿/, "") ?? "";
	const rows = text.split(/\r\n|\n|\r/).filter((line) => line.trim() !== "");
	const header =
		rows[0]?.split("\t").map((name) => name.trim()) ?? DEFAULT_HEADER;
	const idIndex = header.indexOf("id");
	if (idIndex === -1) {
		throw new Error("台帳の見出しに id の列がありません");
	}
	const existing = new Set(
		rows.slice(1).map((row) => row.split("\t")[idIndex]),
	);
	const toAdd = lines.filter((line) => !existing.has(line.id));
	if (toAdd.length === 0) {
		return null;
	}
	const recordedAt = formatJst(now);
	const formatted = toAdd.map((line) => {
		const values: Record<string, string> = {
			id: line.id,
			recorded_at: recordedAt,
			payer_id: line.payerId,
			payer_name: line.payerName,
			debtor_id: line.debtorId,
			debtor_name: line.debtorName,
			amount: String(line.yen),
			split: "1",
			memo: ledgerMemo(month, line, usdJpy),
		};
		return header.map((name) => clean(values[name] ?? "")).join("\t");
	});
	if (rows.length === 0) {
		return `${DEFAULT_HEADER.join("\t")}\n${formatted.join("\n")}\n`;
	}
	const separator = current?.endsWith("\n") ? "" : "\n";
	return `${current}${separator}${formatted.join("\n")}\n`;
}
