/** wrangler.jsonc にない、手元での確認だけに使う値 */
interface Env {
	/**
	 * 転送先のオリジンを差し替える JSON(例 {"openai":"http://127.0.0.1:9999"})。
	 * 偽のプロバイダで中継を試すためのもので、本番では設定しない
	 */
	UPSTREAM_OVERRIDE?: string;
}

/** wrangler.jsonc の rules で、文字列として読み込むファイル */
declare module "*.sh" {
	const text: string;
	export default text;
}

declare module "*.ps1" {
	const text: string;
	export default text;
}
