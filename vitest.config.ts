import { defineConfig } from "vitest/config";

// 中継や精算の計算は Web 標準の API しか使わないので、テストは Node.js で動かす
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
	},
});
