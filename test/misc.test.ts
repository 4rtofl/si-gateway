import { describe, expect, it } from "vitest";
import { normalizeUserCode } from "../src/db/cli-logins.ts";
import {
	decryptText,
	encryptText,
	newToken,
	sha256Hex,
	tokenHint,
} from "../src/lib/crypto.ts";
import { endOfJstDate, monthOf, previousMonth } from "../src/lib/time.ts";
import { parseCredential } from "../src/proxy/auth.ts";
import { adjustRequestBody, errorResponse } from "../src/proxy/handler.ts";
import { modelAllowed, parseModelPatterns } from "../src/proxy/models.ts";
import {
	isBlockedPath,
	matchProviderPath,
	PROVIDERS,
} from "../src/proxy/providers.ts";

describe("parseCredential", () => {
	const key = "sgk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
	const user = "sgu_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

	it("Authorization: Bearer と x-api-key のどちらでも読む", () => {
		expect(
			parseCredential(new Headers({ Authorization: `Bearer ${key}.${user}` })),
		).toEqual({
			sigwToken: key,
			personalToken: user,
		});
		expect(
			parseCredential(new Headers({ "x-api-key": `${user}.${key}` })),
		).toEqual({
			sigwToken: key,
			personalToken: user,
		});
	});

	it("片方だけでは受け付けない", () => {
		expect(
			parseCredential(new Headers({ Authorization: `Bearer ${key}` })),
		).toBeNull();
		expect(parseCredential(new Headers())).toBeNull();
	});
});

describe("モデルの制限", () => {
	it("* のパターンで判定する", () => {
		const patterns = parseModelPatterns("claude-sonnet-*, gpt-5\n");
		expect(patterns).toEqual(["claude-sonnet-*", "gpt-5"]);
		expect(modelAllowed(patterns, "claude-sonnet-4-5-20250929")).toBe(true);
		expect(modelAllowed(patterns, "gpt-5")).toBe(true);
		expect(modelAllowed(patterns, "gpt-5-mini")).toBe(false);
		expect(modelAllowed(patterns, null)).toBe(false);
		expect(modelAllowed(null, "anything")).toBe(true);
		expect(parseModelPatterns("  ")).toBeNull();
	});
});

describe("プロバイダのパス", () => {
	it("先頭からプロバイダを取り出す", () => {
		expect(matchProviderPath("/openai/v1/chat/completions")).toMatchObject({
			provider: { id: "openai" },
			upstreamPath: "/v1/chat/completions",
		});
		expect(matchProviderPath("/openrouter/api/v1/models")?.upstreamPath).toBe(
			"/api/v1/models",
		);
		expect(matchProviderPath("/typesafe/v1/systemone")).toMatchObject({
			provider: { id: "typesafe", origin: "https://api.typesafe.ai" },
			upstreamPath: "/v1/systemone",
		});
		expect(matchProviderPath("/api/me")).toBeNull();
		expect(matchProviderPath("/keys")).toBeNull();
	});

	it("バッチ API は中継しない", () => {
		expect(isBlockedPath(PROVIDERS.openai, "/v1/batches")).toBe(true);
		expect(isBlockedPath(PROVIDERS.openai, "/v1/batches/abc")).toBe(true);
		expect(isBlockedPath(PROVIDERS.anthropic, "/v1/messages/batches")).toBe(
			true,
		);
		expect(isBlockedPath(PROVIDERS.anthropic, "/v1/messages")).toBe(false);
	});
});

describe("adjustRequestBody", () => {
	it("OpenAI のストリーミングに include_usage を足す", () => {
		const body: Record<string, unknown> = { model: "gpt-5", stream: true };
		expect(
			adjustRequestBody(PROVIDERS.openai, "/v1/chat/completions", body),
		).toBe(true);
		expect(body.stream_options).toEqual({ include_usage: true });
	});

	it("ストリーミングでなければ変えない", () => {
		const body: Record<string, unknown> = { model: "gpt-5" };
		expect(
			adjustRequestBody(PROVIDERS.openai, "/v1/chat/completions", body),
		).toBe(false);
	});

	it("OpenRouter には usage.include を足す", () => {
		const body: Record<string, unknown> = { model: "x/y" };
		expect(
			adjustRequestBody(PROVIDERS.openrouter, "/api/v1/chat/completions", body),
		).toBe(true);
		expect(body.usage).toEqual({ include: true });
	});

	it("TypeSafe の本文は変えない", () => {
		const body: Record<string, unknown> = { model: "jev-latest", state: {} };
		expect(adjustRequestBody(PROVIDERS.typesafe, "/v1/systemone", body)).toBe(
			false,
		);
	});

	it("Anthropic の本文は変えない", () => {
		const body: Record<string, unknown> = { model: "claude", stream: true };
		expect(adjustRequestBody(PROVIDERS.anthropic, "/v1/messages", body)).toBe(
			false,
		);
	});
});

describe("errorResponse", () => {
	it("プロバイダに合わせた形でエラーを返す", async () => {
		const openai = errorResponse(
			PROVIDERS.openai,
			401,
			"だめ",
			"authentication_error",
		);
		expect(await openai.json()).toEqual({
			error: {
				message: "[sigw] だめ",
				type: "authentication_error",
				code: "authentication_error",
			},
		});
		const anthropic = errorResponse(
			PROVIDERS.anthropic,
			403,
			"だめ",
			"permission_error",
		);
		expect(await anthropic.json()).toEqual({
			type: "error",
			error: { type: "permission_error", message: "[sigw] だめ" },
		});
		const typesafe = errorResponse(
			PROVIDERS.typesafe,
			429,
			"だめ",
			"rate_limit_error",
		);
		expect(typesafe.status).toBe(429);
		expect(await typesafe.json()).toEqual({ detail: "[sigw] だめ" });
	});
});

describe("暗号とトークン", () => {
	it("暗号化したものを戻せる。鍵が違えば戻せない", async () => {
		const encrypted = await encryptText("secret-a", "sk-test-1234");
		expect(encrypted.startsWith("v1.")).toBe(true);
		expect(await decryptText("secret-a", encrypted)).toBe("sk-test-1234");
		await expect(decryptText("secret-b", encrypted)).rejects.toThrow();
	});

	it("トークンの形", async () => {
		const token = newToken("sgk_");
		expect(token).toMatch(/^sgk_[0-9A-Za-z]{32}$/);
		expect(tokenHint(token)).toMatch(/^sgk_.{3}….{3}$/);
		expect(await sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("日時", () => {
	it("月は日本時間で区切る", () => {
		expect(monthOf(Date.UTC(2026, 10, 30, 14, 59))).toBe("2026-11");
		expect(monthOf(Date.UTC(2026, 10, 30, 15, 0))).toBe("2026-12");
		expect(previousMonth("2026-01")).toBe("2025-12");
	});

	it("有効期限は、その日の終わり(日本時間)", () => {
		expect(endOfJstDate("2026-12-31")).toBe(Date.UTC(2026, 11, 31, 15, 0) - 1);
		expect(endOfJstDate("2026/12/31")).toBeNull();
	});
});

describe("normalizeUserCode", () => {
	it("小文字やハイフンなしの入力を、ABCD-EFGH の形にそろえる", () => {
		expect(normalizeUserCode("bcdf-ghjk")).toBe("BCDF-GHJK");
		expect(normalizeUserCode("bcdfghjk")).toBe("BCDF-GHJK");
		expect(normalizeUserCode(" BCDF GHJK ")).toBe("BCDF-GHJK");
	});
});
