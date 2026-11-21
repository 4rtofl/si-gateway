/*
 * 精算の実行。docs/design.md「6. 精算」
 */

import { listUsers } from "../db/users.ts";
import { GitHubAppAuth } from "../github/app-auth.ts";
import { GitHubContents } from "../github/contents.ts";
import { badRequest } from "../lib/errors.ts";
import { defaultFetch, type Fetch } from "../lib/http.ts";
import { isMonth, monthOf } from "../lib/time.ts";
import { repriceUnpriced } from "../pricing/store.ts";
import {
	computeSettlementLines,
	type PairTotal,
	type SettlementLine,
} from "./compute.ts";
import { fetchUsdJpy } from "./fx.ts";
import { appendSettlementLines, ledgerPath } from "./ledger.ts";

export interface SettlementDetail {
	lines: SettlementLine[];
	/** 料金が不明で、精算に入らなかった呼び出しの数 */
	unpriced: number;
	/** 自分のキーを自分で使った分(請求しない) */
	selfUseNano: number;
}

export interface Settlement {
	month: string;
	usdJpy: number;
	fxSource: string;
	detail: SettlementDetail;
	ledgerUrl: string | null;
	settledAt: number;
	settledBy: string;
}

export interface SettlementPreview {
	month: string;
	usdJpy: number;
	fxSource: string;
	detail: SettlementDetail;
	totals: PairTotal[];
	settled: Settlement | null;
}

export async function getSettlement(
	db: D1Database,
	month: string,
): Promise<Settlement | null> {
	const row = await db
		.prepare("SELECT * FROM settlements WHERE month = ?")
		.bind(month)
		.first<{
			month: string;
			usd_jpy: number;
			fx_source: string;
			lines: string;
			ledger_url: string | null;
			settled_at: number;
			settled_by: string;
		}>();
	return row
		? {
				month: row.month,
				usdJpy: row.usd_jpy,
				fxSource: row.fx_source,
				detail: JSON.parse(row.lines) as SettlementDetail,
				ledgerUrl: row.ledger_url,
				settledAt: row.settled_at,
				settledBy: row.settled_by,
			}
		: null;
}

export async function listSettlements(db: D1Database): Promise<Settlement[]> {
	const { results } = await db
		.prepare("SELECT month FROM settlements ORDER BY month DESC LIMIT 24")
		.all<{ month: string }>();
	const settlements: Settlement[] = [];
	for (const row of results) {
		const settlement = await getSettlement(db, row.month);
		if (settlement) settlements.push(settlement);
	}
	return settlements;
}

export async function getFxOverride(
	db: D1Database,
	month: string,
): Promise<number | null> {
	const row = await db
		.prepare("SELECT usd_jpy FROM fx_overrides WHERE month = ?")
		.bind(month)
		.first<{ usd_jpy: number }>();
	return row?.usd_jpy ?? null;
}

/** その月の為替レートを手で決める。null なら、決めたレートを消す */
export async function setFxOverride(
	db: D1Database,
	month: string,
	usdJpy: number | null,
	userId: string,
): Promise<void> {
	if (!isMonth(month)) {
		throw badRequest("月は「2026-11」の形で指定してください");
	}
	if (usdJpy === null) {
		await db
			.prepare("DELETE FROM fx_overrides WHERE month = ?")
			.bind(month)
			.run();
		return;
	}
	if (!(usdJpy > 50 && usdJpy < 500)) {
		throw badRequest(
			"為替レートは 1 USD あたりの円で入れてください(例 154.32)",
		);
	}
	await db
		.prepare(
			`INSERT INTO fx_overrides (month, usd_jpy, set_by, updated_at) VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT (month) DO UPDATE SET usd_jpy = ?2, set_by = ?3, updated_at = ?4`,
		)
		.bind(month, usdJpy, userId, Date.now())
		.run();
}

async function pairTotals(db: D1Database, month: string): Promise<PairTotal[]> {
	const { results } = await db
		.prepare(
			`SELECT user_id, owner_id, COALESCE(SUM(cost_nano_usd), 0) AS cost, COUNT(*) AS requests,
				SUM(cost_nano_usd IS NULL) AS unpriced
			 FROM usage_events WHERE month = ? GROUP BY user_id, owner_id`,
		)
		.bind(month)
		.all<{
			user_id: string;
			owner_id: string;
			cost: number;
			requests: number;
			unpriced: number;
		}>();
	return results.map((row) => ({
		userId: row.user_id,
		ownerId: row.owner_id,
		costNano: row.cost,
		requests: row.requests,
		unpriced: row.unpriced,
	}));
}

async function resolveRate(
	db: D1Database,
	month: string,
	fetcher: Fetch,
): Promise<{ usdJpy: number; fxSource: string }> {
	const override = await getFxOverride(db, month);
	if (override !== null) {
		return { usdJpy: override, fxSource: "manual" };
	}
	const rate = await fetchUsdJpy(fetcher);
	return { usdJpy: rate.usdJpy, fxSource: rate.source };
}

async function buildDetail(
	db: D1Database,
	month: string,
	usdJpy: number,
): Promise<{ detail: SettlementDetail; totals: PairTotal[] }> {
	const totals = await pairTotals(db, month);
	const names = new Map(
		(await listUsers(db)).map((user) => [user.id, user.name]),
	);
	const lines = computeSettlementLines(month, totals, usdJpy, names);
	return {
		totals,
		detail: {
			lines,
			unpriced: totals.reduce((sum, total) => sum + total.unpriced, 0),
			selfUseNano: totals
				.filter((total) => total.userId === total.ownerId)
				.reduce((sum, total) => sum + total.costNano, 0),
		},
	};
}

/** 精算のプレビュー。精算済みなら、そのときのレートで計算する */
export async function previewSettlement(
	env: Env,
	month: string,
	fetcher: Fetch = defaultFetch,
): Promise<SettlementPreview> {
	if (!isMonth(month)) {
		throw badRequest("月は「2026-11」の形で指定してください");
	}
	const settled = await getSettlement(env.DB, month);
	const rate = settled
		? { usdJpy: settled.usdJpy, fxSource: settled.fxSource }
		: await resolveRate(env.DB, month, fetcher);
	const { detail, totals } = await buildDetail(env.DB, month, rate.usdJpy);
	return { month, ...rate, detail, totals, settled };
}

/**
 * 精算して、Daichoo の台帳にコミットする。終わっていない月(今月以降)と、精算済みの月は断る。
 * 台帳に同じ id の行があれば足さないので、途中で失敗してやり直しても、二重には書かない。
 */
export async function runSettlement(
	env: Env,
	month: string,
	actor: string,
	fetcher: Fetch = defaultFetch,
	now = Date.now(),
): Promise<Settlement> {
	if (!isMonth(month)) {
		throw badRequest("月は「2026-11」の形で指定してください");
	}
	if (month >= monthOf(now)) {
		throw badRequest(`${month} はまだ終わっていないので、精算できません`);
	}
	const existing = await getSettlement(env.DB, month);
	if (existing) {
		throw badRequest(`${month} は精算済みです`);
	}
	await repriceUnpriced(env.DB);
	const rate = await resolveRate(env.DB, month, fetcher);
	const { detail } = await buildDetail(env.DB, month, rate.usdJpy);

	let ledgerUrl: string | null = null;
	if (detail.lines.length > 0) {
		const auth = new GitHubAppAuth(
			{
				clientId: env.GITHUB_APP_CLIENT_ID,
				privateKey: env.GITHUB_APP_PRIVATE_KEY,
			},
			env.DAICHOO_REPOSITORY,
			fetcher,
		);
		const contents = new GitHubContents(
			{
				repository: env.DAICHOO_REPOSITORY,
				branch: env.DAICHOO_BRANCH,
				token: () => auth.token(),
			},
			fetcher,
		);
		const path = ledgerPath(month);
		await contents.updateFile(
			path,
			`sigw: ${month} の LLM の利用料を記録`,
			(current) =>
				appendSettlementLines(current, month, detail.lines, rate.usdJpy, now),
		);
		ledgerUrl = contents.fileUrl(path);
	}

	const settlement: Settlement = {
		month,
		usdJpy: rate.usdJpy,
		fxSource: rate.fxSource,
		detail,
		ledgerUrl,
		settledAt: now,
		settledBy: actor,
	};
	await env.DB.prepare(
		"INSERT INTO settlements (month, usd_jpy, fx_source, lines, ledger_url, settled_at, settled_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(
			month,
			rate.usdJpy,
			rate.fxSource,
			JSON.stringify(detail),
			ledgerUrl,
			now,
			actor,
		)
		.run();
	return settlement;
}
