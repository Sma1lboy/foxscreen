import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "jsdom",
		include: ["{src,electron}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
		exclude: ["src/**/*.browser.test.{ts,tsx}"],
	},
	resolve: {
		alias: {
			"@foxscreen/cutti-core": path.resolve(__dirname, "../cutti-core/src/index.ts"),
			"@": path.resolve(__dirname, "src"),
		},
	},
});
