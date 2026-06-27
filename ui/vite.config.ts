import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standalone cutti editor UI. Proxies /api to the daemon HTTP service so the
// dev origin and the engine share a port-less contract.
export default defineConfig({
  plugins: [react()],
  // The UI ships no PostCSS/Tailwind. Pin an empty inline config so Vite does
  // NOT walk up into the parent openscreen postcss.config.cjs (needs tailwind).
  css: { postcss: { plugins: [] } },
  server: {
    port: 5317,
    proxy: {
      "/api": { target: "http://127.0.0.1:4317", changeOrigin: true },
    },
  },
});
