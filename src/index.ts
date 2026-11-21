/*
 * sigw の Worker の入口。docs/design.md「2. 全体の構成」
 * - /openai/* などのプロバイダのパス: 中継(src/proxy/)
 * - /api/*: JSON API(src/api/)
 * - /auth/*: Discord でのログイン(src/web/auth.ts)
 * - それ以外: Web UI(ui/ をビルドしたもの。Static Assets が返す)
 */

import { handleApi } from "./api/router.ts";
import { purgeExpiredSessions } from "./db/sessions.ts";
import { jstDayAndHour, monthOf, previousMonth } from "./lib/time.ts";
import { repriceUnpriced, syncLiteLlmPrices } from "./pricing/store.ts";
import { handleProxy } from "./proxy/handler.ts";
import { matchProviderPath } from "./proxy/providers.ts";
import { getSettlement, runSettlement } from "./settle/run.ts";
import { finishLogin, logout, startLogin } from "./web/auth.ts";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const provider = matchProviderPath(url.pathname);
		if (provider) {
			return handleProxy(
				request,
				env,
				ctx,
				provider.provider,
				provider.upstreamPath,
				url.search,
			);
		}
		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
			return handleApi(request, env, ctx);
		}
		if (url.pathname === "/auth/login" && request.method === "GET") {
			return startLogin(request, env);
		}
		if (url.pathname === "/auth/callback" && request.method === "GET") {
			return finishLogin(request, env);
		}
		if (url.pathname === "/auth/logout" && request.method === "POST") {
			return logout(request, env);
		}
		return env.ASSETS.fetch(request);
	},

	async scheduled(controller, env, ctx): Promise<void> {
		ctx.waitUntil(runScheduled(env, controller.scheduledTime));
	},
} satisfies ExportedHandler<Env>;

/**
 * 毎日 0:05・3:05・6:05(日本時間)に動く。
 * - 0時台: 価格表を同期し、料金が不明な呼び出しを計算し直す。期限切れのセッションを消す
 * - 毎月1日: 前月がまだ精算されていなければ精算する(失敗したら、3時台と6時台にやり直す)
 */
export async function runScheduled(env: Env, now: number): Promise<void> {
	const { day, hour } = jstDayAndHour(now);
	if (hour === 0) {
		try {
			const synced = await syncLiteLlmPrices(env.DB);
			const repriced = await repriceUnpriced(env.DB);
			console.log(`価格表を同期しました(${synced} 件、再計算 ${repriced} 件)`);
		} catch (error) {
			console.error("価格表を同期できませんでした", error);
		}
		await purgeExpiredSessions(env.DB, now);
	}
	if (day === 1) {
		const month = previousMonth(monthOf(now));
		if (await getSettlement(env.DB, month)) {
			return;
		}
		try {
			const settlement = await runSettlement(
				env,
				month,
				"cron",
				undefined,
				now,
			);
			console.log(
				`${month} を精算しました(${settlement.detail.lines.length} 行)`,
			);
		} catch (error) {
			console.error(`${month} を精算できませんでした`, error);
		}
	}
}
