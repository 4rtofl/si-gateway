/** モデルの制限のパターン(* は任意の文字列)に、モデル名が当てはまるか */
export function modelAllowed(
	patterns: readonly string[] | null,
	model: string | null,
): boolean {
	if (patterns === null || patterns.length === 0) {
		return true;
	}
	if (model === null) {
		return false;
	}
	return patterns.some((pattern) => globMatch(pattern.trim(), model));
}

function globMatch(pattern: string, value: string): boolean {
	const escaped = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "i").test(value);
}

/** 「a, b\nc」のような入力を、パターンの配列にする。空なら null(制限なし) */
export function parseModelPatterns(text: string): string[] | null {
	const patterns = text
		.split(/[\s,]+/)
		.map((value) => value.trim())
		.filter((value) => value !== "");
	return patterns.length === 0 ? null : patterns;
}
