/** 利用者に見せてよいエラー。status は HTTP のステータス */
export class AppError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "AppError";
		this.status = status;
	}
}

export function badRequest(message: string): AppError {
	return new AppError(400, message);
}

export function forbidden(message: string): AppError {
	return new AppError(403, message);
}

export function notFound(message: string): AppError {
	return new AppError(404, message);
}
