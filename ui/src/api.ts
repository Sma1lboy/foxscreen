/**
 * Thin client for the cutti daemon HTTP service. The daemon owns project.json;
 * the UI is a view + a sender of AIActionBatches. Mirrors daemon/src/view.ts
 * (SegmentView/ProjectView) and the in-scope action shapes.
 */

export interface SegmentView {
  id: string;
  sourceVideoID: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  speedRate: number;
  volumeLevel: number;
  isVideoHidden: boolean;
  sourceDurationSeconds: number;
  composedDurationSeconds: number;
  subtitleCount: number;
}

export interface ProjectView {
  trackCount: number;
  primaryTrackName: string;
  composedDurationSeconds: number;
  segments: SegmentView[];
}

export interface ApplyResponse {
  applied: number;
  skipped: number;
  warnings: string[];
  project: ProjectView;
}

/** The subset of AIAction the UI emits today. */
export type UIAction =
  | { type: "deleteSegment"; id: string }
  | { type: "deleteRange"; start: number; end: number }
  | { type: "splitSegment"; id: string; atSourceTime: number }
  | { type: "setSpeed"; id: string; rate: number }
  | { type: "setVolume"; id: string; level: number };

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text}` : ""}`);
  }
  return (await res.json()) as T;
}

export function getProject(): Promise<{ project: ProjectView; path: string | null }> {
  return http("/api/project");
}

export function applyBatch(explanation: string, actions: UIAction[]): Promise<ApplyResponse> {
  return http("/api/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ explanation, actions }),
  });
}
