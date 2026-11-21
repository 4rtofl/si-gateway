/*
 * トークンの発行、ハッシュ、プロバイダキーの暗号化。
 * Web Crypto だけを使うので、Worker でも Node.js(テスト)でも動く。
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** base62 の乱数文字列。偏りが出ないよう、62の倍数に収まらないバイトは捨てる */
export function randomBase62(length: number): string {
	let out = "";
	while (out.length < length) {
		const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
		for (const byte of bytes) {
			if (byte < 248 && out.length < length) {
				out += BASE62[byte % 62];
			}
		}
	}
	return out;
}

/** トークンの種類ごとの接頭辞 */
export const TOKEN_PREFIX = {
	sigwKey: "sgk_",
	personal: "sgu_",
	cli: "sgc_",
	session: "sgs_",
} as const;

/** 接頭辞を付けたトークンを発行する(32文字 ≒ 190ビット) */
export function newToken(prefix: string): string {
	return `${prefix}${randomBase62(32)}`;
}

/** 画面に出す、トークンの見分け用の短い文字列(例 sgk_AbC…xYz) */
export function tokenHint(token: string): string {
	const underscore = token.indexOf("_");
	const head = token.slice(0, underscore + 4);
	return `${head}…${token.slice(-3)}`;
}

/** 行の ID(16文字) */
export function newId(): string {
	return randomBase62(16);
}

/** 文字列の SHA-256 を16進数で返す */
export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) {
		out += byte.toString(16).padStart(2, "0");
	}
	return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** シークレット(任意の文字列)から AES-GCM の鍵を作る。同じ isolate では使い回す */
function encryptionKey(secret: string): Promise<CryptoKey> {
	if (!secret) {
		throw new Error(
			"KEY_ENCRYPTION_SECRET が設定されていません(wrangler secret put KEY_ENCRYPTION_SECRET)",
		);
	}
	let key = keyCache.get(secret);
	if (!key) {
		key = crypto.subtle
			.digest("SHA-256", new TextEncoder().encode(`sigw:v1:${secret}`))
			.then((raw) =>
				crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
					"encrypt",
					"decrypt",
				]),
			);
		keyCache.set(secret, key);
	}
	return key;
}

/** 文字列を暗号化し、「v1.<iv>.<暗号文>」(base64)の形で返す */
export async function encryptText(
	secret: string,
	plaintext: string,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const cipher = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await encryptionKey(secret),
		new TextEncoder().encode(plaintext),
	);
	return `v1.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

/** encryptText で暗号化したものを戻す */
export async function decryptText(
	secret: string,
	encrypted: string,
): Promise<string> {
	const [version, iv, cipher] = encrypted.split(".");
	if (version !== "v1" || !iv || !cipher) {
		throw new Error("暗号化されたキーの形が正しくありません");
	}
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: base64ToBytes(iv) },
		await encryptionKey(secret),
		base64ToBytes(cipher),
	);
	return new TextDecoder().decode(plain);
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
