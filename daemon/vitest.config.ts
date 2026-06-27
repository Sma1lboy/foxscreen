import { defineConfig } from "vitest/config";

export default defineConfig({
  // The daemon ships no CSS. Pin an empty inline PostCSS config so Vite does
  // NOT walk up into the parent openscreen project's postcss.config.cjs (which
  // requires tailwindcss, absent from the daemon's deps).
  css: { postcss: { plugins: [] } },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});
