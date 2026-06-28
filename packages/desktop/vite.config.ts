import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
	clearScreen: false,
	envPrefix: ["VITE_", "TAURI_ENV_"],
	server: {
		port: 17420,
		strictPort: true,
		host: process.env.TAURI_DEV_HOST || undefined,
		watch: { ignored: ["**/src-tauri/**"] },
	},
	plugins: [react()],
	resolve: {
		alias: {
			"@foxscreen/cutti-core": path.resolve(__dirname, "../cutti-core/src/index.ts"),
			"@": path.resolve(__dirname, "src"),
			// @xenova/transformers: env.js statically imports fs/path/url; onnx.js imports
			// onnxruntime-node (must not be bundled in the renderer — it requires fs).
			fs: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			path: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			url: path.resolve(__dirname, "src/lib/vite-stubs/empty-node-module.ts"),
			"onnxruntime-node": path.resolve(__dirname, "src/lib/vite-stubs/onnxruntime-node-stub.ts"), // re-exports web ORT
		},
	},
	optimizeDeps: {
		exclude: ["@xenova/transformers"],
	},
	// The captioning worker dynamically imports @xenova/transformers, which makes the
	// worker bundle code-split — unsupported by the default "iife" worker format.
	worker: {
		format: "es",
	},
	build: {
		target: "esnext",
		minify: "terser",
		terserOptions: {
			compress: {
				drop_console: true,
				drop_debugger: true,
				pure_funcs: ["console.log", "console.debug"],
			},
		},
		rollupOptions: {
			output: {
				manualChunks(id) {
					if (id.includes("pixi.js") || id.includes("pixi-filters") || id.includes("@pixi/"))
						return "pixi";
					if (id.includes("react-dom") || id.includes("/react/")) return "react-vendor";
					if (
						id.includes("mediabunny") ||
						id.includes("mp4box") ||
						id.includes("fix-webm-duration")
					)
						return "video-processing";
				},
			},
		},
		chunkSizeWarningLimit: 1000,
	},
});
