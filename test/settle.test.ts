import { describe, expect, it } from "vitest";
import { roundHalfEven } from "../src/lib/money.ts";
import { computeSettlementLines, ledgerMemo } from "../src/settle/compute.ts";
import { appendSettlementLines } from "../src/settle/ledger.ts";

const names = new Map([
	["111", "A"],
	["222", "B"],
	["333", "C"],
]);

describe("computeSettlementLines", () => {
	it("自分のキーを自分で使った分と、0円になる分を除く", () => {
		const lines = computeSettlementLines(
			"2026-11",
			[
				{
					userId: "222",
					ownerId: "111",
					costNano: 10_000_000_000,
					requests: 5,
					unpriced: 0,
				},
				{
					userId: "111",
					ownerId: "111",
					costNano: 50_000_000_000,
					requests: 9,
					unpriced: 0,
				},
				{
					userId: "333",
					ownerId: "111",
					costNano: 1_000_000,
					requests: 1,
					unpriced: 0,
				},
				{
					userId: "111",
					ownerId: "222",
					costNano: 2_500_000_000,
					requests: 2,
					unpriced: 1,
				},
			],
			150,
			names,
		);
		expect(lines).toEqual([
			{
				id: "sigw-2026-11-111-222",
				payerId: "111",
				payerName: "A",
				debtorId: "222",
				debtorName: "B",
				costNano: 10_000_000_000,
				yen: 1500,
			},
			{
				id: "sigw-2026-11-222-111",
				payerId: "222",
				payerName: "B",
				debtorId: "111",
				debtorName: "A",
				costNano: 2_500_000_000,
				yen: 375,
			},
		]);
	});

	it("偶数丸めにする", () => {
		expect(roundHalfEven(500.5)).toBe(500);
		expect(roundHalfEven(501.5)).toBe(502);
		expect(roundHalfEven(10.4)).toBe(10);
		expect(roundHalfEven(10.6)).toBe(11);
	});
});

describe("appendSettlementLines", () => {
	const line = {
		id: "sigw-2026-11-111-222",
		payerId: "111",
		payerName: "A",
		debtorId: "222",
		debtorName: "B",
		costNano: 12_345_678_000,
		yen: 1852,
	};
	const now = Date.UTC(2026, 10, 30, 15, 5, 0);

	it("split の列がない台帳には、見出しの並びに合わせて書く", () => {
		const current =
			"id\trecorded_at\tpayer_id\tpayer_name\tdebtor_id\tdebtor_name\tamount\tmemo\n1\t2026-11-14T19:29:10+09:00\t111\tA\t222\tB\t1000\tこの世\n";
		const next = appendSettlementLines(current, "2026-11", [line], 150, now);
		expect(next).toBe(
			`${current}sigw-2026-11-111-222\t2026-12-01T00:05:00+09:00\t111\tA\t222\tB\t1852\tLLM 2026-11 $12.345678 @150.00 (sigw)\n`,
		);
	});

	it("同じ id の行がすでにあれば足さない", () => {
		const first = appendSettlementLines(null, "2026-11", [line], 150, now);
		expect(first?.split("\n")[0]).toBe(
			"id\trecorded_at\tpayer_id\tpayer_name\tdebtor_id\tdebtor_name\tamount\tsplit\tmemo",
		);
		expect(first).toContain("\t1852\t1\tLLM 2026-11");
		expect(
			appendSettlementLines(first, "2026-11", [line], 150, now),
		).toBeNull();
	});

	it("Daichoo の上限を超える金額は書かない", () => {
		expect(() =>
			appendSettlementLines(
				null,
				"2026-11",
				[{ ...line, yen: 1_000_001 }],
				150,
				now,
			),
		).toThrow();
	});

	it("memo の形", () => {
		expect(ledgerMemo("2026-11", line, 154.321)).toBe(
			"LLM 2026-11 $12.345678 @154.32 (sigw)",
		);
	});
});
