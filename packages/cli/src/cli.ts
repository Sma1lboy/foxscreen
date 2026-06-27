#!/usr/bin/env -S bun run
/**
 * foxscreen cutti CLI — the headless surface an agent (Claude) or a human drives
 * to exercise the cutti engine without the GUI. Thin wrapper over
 * `@foxscreen/cutti-core` (the same engine the desktop renderer runs) + node IO.
 *
 *   cutti init     <project.json>                          fresh empty project
 *   cutti inspect  <project.json>                          dump tracks / segments / duration
 *   cutti apply    <project.json> <batch.json> [--out p]   run an AIActionBatch
 *   cutti firstcut <transcript.json> [--out p] [--src id]  transcript → heuristic keep/cut
 *   cutti ai       <transcript.json> [--out p] [--src id]  transcript → LLM keep/cut (env config)
 *
 * transcript.json is a CaptionSegment[] (or { segments: CaptionSegment[] }),
 * each { startSec, endSec, text }. The firstcut/ai commands are the test harness:
 * feed a transcript, get a project.json + a keep/cut summary, all from the CLI.
 *
 * LLM config for `ai` comes from env:
 *   CUTTI_LLM_API_KEY (or OPENAI_API_KEY), CUTTI_LLM_BASE_URL, CUTTI_LLM_MODEL
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
	type AIActionBatch,
	applyActionBatchToProject,
	type CaptionSegment,
	type CuttiLlmConfig,
	deserializeProject,
	durationSeconds,
	type FirstCutCoreResult,
	flatToSegments,
	makePrimaryVideoTrack,
	type Project,
	primarySegments,
	runFirstCut,
	runFirstCutAI,
	serializeProject,
} from "@foxscreen/cutti-core";

const fmt = (n: number): string => n.toFixed(3);

function composedDuration(project: Project): number {
	return primarySegments(project).reduce((acc, s) => acc + durationSeconds(s), 0);
}

async function loadProject(path: string): Promise<Project> {
	return deserializeProject(await readFile(path, "utf8"));
}

async function saveProject(path: string, project: Project): Promise<void> {
	await writeFile(path, serializeProject(project), "utf8");
}

function parseCaptions(raw: string, sourcePath: string): CaptionSegment[] {
	const data: unknown = JSON.parse(raw);
	const arr = Array.isArray(data) ? data : (data as { segments?: unknown })?.segments;
	if (!Array.isArray(arr)) {
		throw new Error(`${sourcePath}: expected CaptionSegment[] or { segments: [...] }`);
	}
	return arr.map((c, i) => {
		const seg = c as Partial<CaptionSegment>;
		if (typeof seg.startSec !== "number" || typeof seg.endSec !== "number") {
			throw new Error(`${sourcePath}: segment #${i} missing numeric startSec/endSec`);
		}
		return { startSec: seg.startSec, endSec: seg.endSec, text: String(seg.text ?? "") };
	});
}

function llmConfigFromEnv(): CuttiLlmConfig {
	const apiKey = process.env.CUTTI_LLM_API_KEY ?? process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new Error("set CUTTI_LLM_API_KEY (or OPENAI_API_KEY) for `cutti ai`");
	}
	return {
		apiKey,
		baseUrl: process.env.CUTTI_LLM_BASE_URL ?? "https://api.openai.com/v1",
		model: process.env.CUTTI_LLM_MODEL ?? "gpt-4o-mini",
	};
}

/** firstcut/ai shared: turn a core result into a saved project.json + a printed summary. */
async function writeFirstCut(
	core: FirstCutCoreResult,
	outPath: string,
	captions: CaptionSegment[],
	label: string,
): Promise<void> {
	const segments = flatToSegments(core.flat);
	const project: Project = { tracks: [makePrimaryVideoTrack(randomUUID(), segments)] };
	await saveProject(outPath, project);
	const keptTexts = new Set(segments.map((s) => s.text));
	console.log(
		`${label}: ${core.total} phrases → cut ${core.applied}, kept ${core.total - core.applied}`,
	);
	console.log(`composed duration: ${fmt(composedDuration(project))}s`);
	console.log("cut phrases:");
	for (const c of captions) {
		if (!keptTexts.has(c.text)) {
			console.log(`  ✂ [${fmt(c.startSec)}→${fmt(c.endSec)}]s  ${JSON.stringify(c.text)}`);
		}
	}
	console.log(`saved: ${outPath}`);
}

async function cmdInit(path: string): Promise<void> {
	const project: Project = { tracks: [makePrimaryVideoTrack(randomUUID())] };
	await saveProject(path, project);
	console.log(`Initialized empty project at ${path}`);
}

async function cmdInspect(path: string): Promise<void> {
	const project = await loadProject(path);
	console.log(`project: ${path}`);
	console.log(`tracks: ${project.tracks.length}`);
	for (const track of project.tracks) {
		console.log(`  [${track.kind}] ${track.name}  (${track.segments.length} segments)`);
	}
	const segs = primarySegments(project);
	console.log(`primary segments: ${segs.length}`);
	segs.forEach((s, i) => {
		const text = s.text.length > 40 ? `${s.text.slice(0, 40)}…` : s.text;
		console.log(
			`  #${i} ${s.id.slice(0, 8)} src=${s.sourceVideoID.slice(0, 8)} ` +
				`[${fmt(s.range.startSeconds)}→${fmt(s.range.endSeconds)}]s ` +
				`x${s.speedRate} dur=${fmt(durationSeconds(s))}s  ${JSON.stringify(text)}`,
		);
	});
	console.log(`composed duration: ${fmt(composedDuration(project))}s`);
}

async function cmdApply(projectPath: string, batchPath: string, outPath: string): Promise<void> {
	const project = await loadProject(projectPath);
	const batch = JSON.parse(await readFile(batchPath, "utf8")) as AIActionBatch;
	if (!batch || !Array.isArray(batch.actions)) {
		throw new Error(`${batchPath}: expected an AIActionBatch { actions: [...], explanation }`);
	}
	const before = composedDuration(project);
	const { project: next, result } = applyActionBatchToProject(project, batch);
	await saveProject(outPath, next);
	console.log(`applied=${result.appliedCount} skipped=${result.skippedCount}`);
	if (result.warnings.length > 0) {
		console.log(`warnings:\n  ${result.warnings.join("\n  ")}`);
	}
	console.log(`composed duration: ${fmt(before)}s → ${fmt(composedDuration(next))}s`);
	console.log(`saved: ${outPath}`);
}

async function cmdFirstCut(transcriptPath: string, outPath: string, src: string): Promise<void> {
	const captions = parseCaptions(await readFile(transcriptPath, "utf8"), transcriptPath);
	await writeFirstCut(runFirstCut(captions, src), outPath, captions, "heuristic keep/cut");
}

async function cmdAi(transcriptPath: string, outPath: string, src: string): Promise<void> {
	const captions = parseCaptions(await readFile(transcriptPath, "utf8"), transcriptPath);
	const core = await runFirstCutAI(captions, src, llmConfigFromEnv());
	await writeFirstCut(core, outPath, captions, "LLM keep/cut");
}

function usage(): void {
	console.log(`foxscreen cutti CLI
Usage:
  cutti init     <project.json>
  cutti inspect  <project.json>
  cutti apply    <project.json> <batch.json> [--out <project.json>]
  cutti firstcut <transcript.json> [--out <project.json>] [--src <sourceVideoID>]
  cutti ai       <transcript.json> [--out <project.json>] [--src <sourceVideoID>]

transcript.json: CaptionSegment[] or { segments: [...] }, each { startSec, endSec, text }.
\`ai\` reads CUTTI_LLM_API_KEY (or OPENAI_API_KEY), CUTTI_LLM_BASE_URL, CUTTI_LLM_MODEL from env.`);
}

function flag(rest: string[], name: string, fallback: string): string {
	const i = rest.indexOf(name);
	return i >= 0 && rest[i + 1] ? (rest[i + 1] as string) : fallback;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const cmd = argv[0];
	const rest = argv.slice(1);

	switch (cmd) {
		case "init":
			if (!rest[0]) return usage();
			return cmdInit(rest[0]);
		case "inspect":
			if (!rest[0]) return usage();
			return cmdInspect(rest[0]);
		case "apply": {
			if (!rest[0] || !rest[1]) return usage();
			return cmdApply(rest[0], rest[1], flag(rest, "--out", rest[0]));
		}
		case "firstcut":
			if (!rest[0]) return usage();
			return cmdFirstCut(
				rest[0],
				flag(rest, "--out", "project.foxscreen"),
				flag(rest, "--src", "cli-src"),
			);
		case "ai":
			if (!rest[0]) return usage();
			return cmdAi(
				rest[0],
				flag(rest, "--out", "project.foxscreen"),
				flag(rest, "--src", "cli-src"),
			);
		default:
			usage();
			if (cmd !== undefined && cmd !== "help" && cmd !== "--help") {
				process.exitCode = 1;
			}
	}
}

main().catch((err: unknown) => {
	console.error(String(err instanceof Error ? err.message : err));
	process.exitCode = 1;
});
