/*
 * 日時の扱い。月は日本時間で区切る(Daichoo の台帳と同じ)。
 * 日本には夏時間がないので、UTC との差は常に9時間として計算する。
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** 日本時間での月を「2026-11」の形で返す */
export function monthOf(ms: number): string {
	const jst = new Date(ms + JST_OFFSET_MS);
	return formatMonth(jst.getUTCFullYear(), jst.getUTCMonth() + 1);
}

/** 日本時間での日(1〜31)と時(0〜23) */
export function jstDayAndHour(ms: number): { day: number; hour: number } {
	const jst = new Date(ms + JST_OFFSET_MS);
	return { day: jst.getUTCDate(), hour: jst.getUTCHours() };
}

/** 「2026-11」の形になっているか */
export function isMonth(text: string): boolean {
	return MONTH_PATTERN.test(text);
}

/** 前の月。「2026-01」なら「2025-12」 */
export function previousMonth(month: string): string {
	const { year, monthNumber } = parseMonth(month);
	return monthNumber === 1
		? formatMonth(year - 1, 12)
		: formatMonth(year, monthNumber - 1);
}

/** 次の月 */
export function nextMonth(month: string): string {
	const { year, monthNumber } = parseMonth(month);
	return monthNumber === 12
		? formatMonth(year + 1, 1)
		: formatMonth(year, monthNumber + 1);
}

/** その月の初めの時刻(UNIX ミリ秒、日本時間の1日0時) */
export function monthStart(month: string): number {
	const { year, monthNumber } = parseMonth(month);
	return Date.UTC(year, monthNumber - 1, 1) - JST_OFFSET_MS;
}

/** 日本時間の ISO 8601(例 2026-11-13T22:38:58+09:00) */
export function formatJst(ms: number): string {
	const jst = new Date(ms + JST_OFFSET_MS);
	return jst.toISOString().replace(/\.\d{3}Z$/, "+09:00");
}

/** 画面に出す日本時間(例 2026-11-13 22:38) */
export function formatJstShort(ms: number): string {
	return formatJst(ms).slice(0, 16).replace("T", " ");
}

/** 「2026-11」なら「2026年11月」 */
export function monthLabel(month: string): string {
	const { year, monthNumber } = parseMonth(month);
	return `${year}年${monthNumber}月`;
}

/** 日本時間の日付(2026-11-30)を、その日の終わり(23:59:59.999)の時刻にする */
export function endOfJstDate(date: string): number | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) {
		return null;
	}
	const ms =
		Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1) -
		JST_OFFSET_MS -
		1;
	return Number.isNaN(ms) ? null : ms;
}

/** 時刻を、日本時間の日付(2026-11-30)にする */
export function jstDate(ms: number): string {
	return formatJst(ms).slice(0, 10);
}

function parseMonth(month: string): { year: number; monthNumber: number } {
	const match = MONTH_PATTERN.exec(month);
	if (!match) {
		throw new Error(`月は「2026-11」の形で指定してください: ${month}`);
	}
	return { year: Number(match[1]), monthNumber: Number(match[2]) };
}

function formatMonth(year: number, monthNumber: number): string {
	return `${year}-${String(monthNumber).padStart(2, "0")}`;
}
