#!/usr/bin/env -S npx tsx
/**
 * cutti daemon HTTP service — the live engine the editor UI (and an agent)
 * drive. Holds the current Project in memory, persists every applied batch back
 * to project.json (when started with a path), and exposes a tiny JSON API:
 *
 *   GET  /api/health           -> { ok: true }
 *   GET  /api/project          -> { project: ProjectView, path }
 *   POST /api/apply  {batch}    -> { applied, skipped, warnings, project }
 *
 * Zero runtime dependencies (node:http). Start with:
 *   npm run serve -- <project.json> [--port 4317]
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { Project } from "./model/project";
import { makePrimaryVideoTrack } from "./model/project";
import { loadProject, saveProject } from "./persistence/projectFile";
import { applyActionBatchToProject } from "./actions/executor";
import type { AIActionBatch } from "./actions/aiAction";
import { buildProjectView } from "./view";

const args = process.argv.slice(2);
const projectPath = args.find((a) => !a.startsWith("--"));
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 && args[portIdx + 1] ? Number(args[portIdx + 1]) : 4317;

let project: Project;
let loadedFrom: string | null = null;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function init(): Promise<void> {
  if (projectPath && existsSync(projectPath)) {
    project = await loadProject(projectPath);
    loadedFrom = projectPath;
  } else {
    project = { tracks: [makePrimaryVideoTrack(randomUUID())] };
    loadedFrom = projectPath ?? null;
  }
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const method = req.method ?? "GET";
  const url = (req.url ?? "/").split("?")[0];

  if (method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  try {
    if (method === "GET" && url === "/api/health") {
      return sendJSON(res, 200, { ok: true });
    }
    if (method === "GET" && url === "/api/project") {
      return sendJSON(res, 200, { project: buildProjectView(project), path: loadedFrom });
    }
    if (method === "POST" && url === "/api/apply") {
      const batch = JSON.parse(await readBody(req)) as AIActionBatch;
      if (!batch || !Array.isArray(batch.actions)) {
        return sendJSON(res, 400, { error: "expected an AIActionBatch { actions, explanation }" });
      }
      const { project: next, result } = applyActionBatchToProject(project, batch);
      project = next;
      if (loadedFrom) await saveProject(loadedFrom, project);
      return sendJSON(res, 200, {
        applied: result.appliedCount,
        skipped: result.skippedCount,
        warnings: result.warnings,
        project: buildProjectView(project),
      });
    }
    sendJSON(res, 404, { error: `no route for ${method} ${url}` });
  } catch (err) {
    sendJSON(res, 500, { error: String(err instanceof Error ? err.message : err) });
  }
});

init()
  .then(() => {
    server.listen(PORT, "127.0.0.1", () => {
      console.log(
        `cutti daemon http → http://127.0.0.1:${PORT}  (project: ${loadedFrom ?? "in-memory"})`,
      );
    });
  })
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  });
