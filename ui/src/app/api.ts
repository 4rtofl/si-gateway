/** sigw の JSON API(/api/*)を呼ぶ。Cookie のセッションで認証する */

export class ApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export async function api<T>(
	path: string,
	init: { method?: string; body?: unknown } = {},
): Promise<T> {
	const response = await fetch(`/api${path}`, {
		method: init.method ?? "GET",
		credentials: "same-origin",
		headers:
			init.body === undefined
				? undefined
				: { "Content-Type": "application/json" },
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
	if (response.status === 401) {
		const here = window.location.pathname + window.location.search;
		window.location.assign(
			here === "/" ? "/login" : `/login?next=${encodeURIComponent(here)}`,
		);
		throw new ApiError(401, "ログインしてください");
	}
	const data = (await response.json().catch(() => ({}))) as { error?: string };
	if (!response.ok) {
		throw new ApiError(
			response.status,
			data.error ?? `エラー(${response.status})`,
		);
	}
	return data as T;
}
