/**
 * HTTP のリクエストを送る関数。fetch と同じ形で、テストでは偽物に差し替える。
 * Workers では、fetch をオブジェクトのメソッドとして呼ぶと「Illegal invocation」になるため、
 * 本物を渡すときも、関数で包んだもの(defaultFetch)を渡す。
 */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const defaultFetch: Fetch = (url, init) => fetch(url, init);

/** 指定したミリ秒だけ待つ */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
