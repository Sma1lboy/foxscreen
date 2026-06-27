#!/usr/bin/env node
// cuttio self-test harness — verifies the Electron→Tauri migration end to end:
// renderer typechecks (incl the electronApi shim), lint, unit tests (cutti
// engine + shim), the Tauri Rust shell compiles, and the Tauri-mode frontend
// bundles. Run: `npm run selftest`.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const cargoBin = `${homedir()}/.cargo/bin`;
const withCargo = { ...process.env, PATH: `${cargoBin}:${process.env.PATH ?? ""}` };
const tauriEnv = { ...process.env, CUTTIO_SHELL: "tauri" };
const desktop = "packages/desktop";

const steps = [
	{ name: "typecheck (desktop — renderer + shim)", cmd: "bun", args: ["x", "tsc", "--noEmit"], opts: { cwd: desktop } },
	{ name: "typecheck (@foxscreen/cutti-core)", cmd: "bun", args: ["x", "tsc", "--noEmit", "-p", "packages/cutti-core/tsconfig.json"] },
	{ name: "typecheck (@foxscreen/cli)", cmd: "bun", args: ["x", "tsc", "--noEmit", "-p", "packages/cli/tsconfig.json"] },
	{ name: "lint (biome — core + cli + bridge + shim)", cmd: "bun", args: ["x", "biome", "check", "packages/cutti-core/src", "packages/cli/src", "packages/desktop/src/lib/cutti", "packages/desktop/src/lib/tauri"] },
	{ name: "unit tests (cutti engine + shim)", cmd: "bun", args: ["x", "vitest", "run", "src/lib"], opts: { cwd: desktop } },
	{ name: "cli harness smoke (firstcut → project)", cmd: "bun", args: ["run", "packages/cli/src/cli.ts", "firstcut", "packages/cli/fixtures/sample-transcript.json", "--out", "/tmp/foxscreen-selftest.foxscreen"] },
	{ name: "rust build (src-tauri — Tauri shell)", cmd: "cargo", args: ["build"], opts: { cwd: `${desktop}/src-tauri`, env: withCargo } },
	{ name: "frontend build (CUTTIO_SHELL=tauri vite build)", cmd: "bun", args: ["x", "vite", "build"], opts: { cwd: desktop, env: tauriEnv } },
];

const results = [];
let failed = 0;
for (const step of steps) {
	process.stdout.write(`\n▶ ${step.name}\n`);
	const t0 = Date.now();
	const r = spawnSync(step.cmd, step.args, { stdio: "inherit", shell: false, ...(step.opts ?? {}) });
	const ok = r.status === 0;
	results.push({ name: step.name, ok, dt: ((Date.now() - t0) / 1000).toFixed(1) });
	if (!ok) failed += 1;
}

console.log("\n──────── foxscreen selftest ────────");
for (const r of results) console.log(`  ${r.ok ? "✓" : "✗"}  ${r.name}  (${r.dt}s)`);
console.log("─".repeat(34));
console.log(failed === 0 ? "ALL PASS ✓" : `${failed} STEP(S) FAILED ✗`);
process.exit(failed === 0 ? 0 : 1);
