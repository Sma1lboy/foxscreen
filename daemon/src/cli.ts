#!/usr/bin/env -S npx tsx
/**
 * cutti daemon CLI — the surface an agent (Claude) or a human drives to edit a
 * project.json. Thin wrapper over the pure executor + persistence.
 *
 *   cutti init <project.json>
 *   cutti inspect <project.json>
 *   cutti apply <project.json> <batch.json> [--out <project.json>]
 *
 * Run in dev via `npm run cli -- <args>` (tsx).
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Project } from "./model/project";
import { makePrimaryVideoTrack, primarySegments } from "./model/project";
import { durationSeconds } from "./model/timelineSegment";
import { loadProject, saveProject } from "./persistence/projectFile";
import { applyActionBatchToProject } from "./actions/executor";
import type { AIActionBatch } from "./actions/aiAction";

function composedDuration(project: Project): number {
  return primarySegments(project).reduce((acc, s) => acc + durationSeconds(s), 0);
}

function fmt(n: number): string {
  return n.toFixed(3);
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
  const after = composedDuration(next);
  console.log(`applied=${result.appliedCount} skipped=${result.skippedCount}`);
  if (result.warnings.length > 0) {
    console.log(`warnings:\n  ${result.warnings.join("\n  ")}`);
  }
  console.log(`composed duration: ${fmt(before)}s → ${fmt(after)}s`);
  console.log(`saved: ${outPath}`);
}

function usage(): void {
  console.log(`cutti daemon CLI
Usage:
  cutti init <project.json>
  cutti inspect <project.json>
  cutti apply <project.json> <batch.json> [--out <project.json>]

batch.json is an AIActionBatch, e.g.:
  { "explanation": "trim head", "actions": [ { "type": "deleteRange", "start": 2, "end": 5 } ] }

Note (v0): subtitle re-slicing on split/trim uses an empty transcript lookup;
wiring per-source transcripts is a later milestone.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case "init": {
      if (!rest[0]) return usage();
      return cmdInit(rest[0]);
    }
    case "inspect": {
      if (!rest[0]) return usage();
      return cmdInspect(rest[0]);
    }
    case "apply": {
      const projectPath = rest[0];
      const batchPath = rest[1];
      if (!projectPath || !batchPath) return usage();
      const outIdx = rest.indexOf("--out");
      const outPath = outIdx >= 0 ? rest[outIdx + 1] : projectPath;
      if (!outPath) return usage();
      return cmdApply(projectPath, batchPath, outPath);
    }
    default: {
      usage();
      if (cmd !== undefined && cmd !== "help" && cmd !== "--help") {
        process.exitCode = 1;
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exitCode = 1;
});
