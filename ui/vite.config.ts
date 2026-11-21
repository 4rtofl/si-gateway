import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 手元では「pnpm dev」(wrangler dev、:8787)を起動しておき、API とログインはそちらに渡す
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			"@api": fileURLToPath(new URL("../src/api", import.meta.url)),
		},
	},
	server: {
		proxy: {
			"/api": "http://localhost:8787",
			"/auth": "http://localhost:8787",
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
});
