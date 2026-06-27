/**
 * The framework-agnostic cutti keep/cut pipeline.
 *
 * Transcript (`CaptionSegment[]`) → cutti segments → keep/cut decision → real
 * `applyActionBatch` executor → an edited flat `CuttiProject`. Pure: no renderer
 * types, no DOM, node + browser safe. The desktop renderer maps the resulting
 * flat project to openscreen regions (see `src/lib/cutti/firstCut.ts`); the CLI
 * harness serializes it straight to `project.json`. Both drive the same logic.
 */

import type { CaptionSegment } from "./captionSegment";
import { CUTTI_DEMO_PROJECT } from "./demoProject";
import type { AIActionBatch } from "./engine/actions/aiAction";
import { applyActionBatch } from "./engine/actions/executor";
import {
	makeSubtitleEntry,
	makeTimelineSegment,
	makeTimeRange,
	type TimelineSegment,
} from "./engine/model";
import { aiKeepCut, type CuttiLlmConfig } from "./llm";
import type { CuttiProject } from "./types";

/** Each transcript phrase becomes one cutti segment carrying its own subtitle. */
export function captionsToSegments(
	captions: CaptionSegment[],
	sourceVideoID: string,
): TimelineSegment[] {
	return captions.map((c, i) => {
		const dur = Math.max(0, c.endSec - c.startSec);
		return makeTimelineSegment({
			id: `cap-${i}`,
			sourceVideoID,
			range: makeTimeRange(c.startSec, c.endSec),
			text: c.text,
			subtitles: [
				makeSubtitleEntry({
					id: `cap-${i}-sub`,
					relativeStart: 0,
					relativeDuration: dur,
					text: c.text,
				}),
			],
		});
	});
}

/** Filler phrases worth cutting (zh + en). Whole-phrase match only. */
const FILLER_RE =
	/^[\s,.，。、…!?！？]*(?:u+m+|u+h+|e+r+|a+h+|h+m+|like|you know|呃+|嗯+|那个|这个|就是说?|然后呢?|额+|啊+)[\s,.，。、…!?！？]*$/i;

const MIN_PHRASE_SEC = 0.35;

/** Local heuristic keep/cut: drop filler + ultra-short phrases. */
export function heuristicCutBatch(segments: TimelineSegment[]): AIActionBatch {
	const actions = segments
		.filter((s) => {
			const t = s.text.trim();
			if (t.length === 0) return true;
			if (FILLER_RE.test(t)) return true;
			if (s.range.endSeconds - s.range.startSeconds < MIN_PHRASE_SEC) return true;
			return false;
		})
		.map((s) => ({ type: "deleteSegment" as const, id: s.id }));
	return { explanation: "cutti 初剪:去口头禅 / 过短停顿", actions };
}

/** LLM cut indices (positional over the transcript) → a deleteSegment batch. */
export function cutIndicesToBatch(
	segments: TimelineSegment[],
	cutIndices: number[],
): AIActionBatch {
	const ids = cutIndices
		.map((i) => segments[i]?.id)
		.filter((id): id is string => typeof id === "string");
	return {
		explanation: "cutti AI 初剪:LLM 选定剪除",
		actions: [...new Set(ids)].map((id) => ({ type: "deleteSegment" as const, id })),
	};
}

/** Flat cutti project (persistable shape) → runtime segments the executor edits. */
export function flatToSegments(project: CuttiProject): TimelineSegment[] {
	const track = project.tracks.find((t) => t.kind === "video") ?? project.tracks[0];
	if (!track) return [];
	return track.segments.map((seg) =>
		makeTimelineSegment({
			id: seg.id,
			sourceVideoID: seg.sourceVideoID,
			range: makeTimeRange(seg.startSeconds, seg.endSeconds),
			text: seg.text,
			subtitles: (seg.subtitles ?? []).map((s, i) =>
				makeSubtitleEntry({
					id: s.id ?? `${seg.id}-sub-${i}`,
					relativeStart: s.relativeStart,
					relativeDuration: s.relativeDuration,
					text: s.text,
					speakerID: s.speakerID,
				}),
			),
			speedRate: seg.speedRate,
			volumeLevel: seg.volumeLevel ?? 1,
		}),
	);
}

/** Runtime segments → flat cutti project (so callers can serialize or map it). */
export function segmentsToFlat(segments: TimelineSegment[]): CuttiProject {
	return {
		version: 1,
		tracks: [
			{
				kind: "video",
				segments: segments.map((s) => ({
					id: s.id,
					sourceVideoID: s.sourceVideoID,
					startSeconds: s.range.startSeconds,
					endSeconds: s.range.endSeconds,
					text: s.text,
					speedRate: s.speedRate,
					volumeLevel: s.volumeLevel,
					subtitles: s.subtitles.map((sub) => ({
						id: sub.id,
						relativeStart: sub.relativeStart,
						relativeDuration: sub.relativeDuration,
						text: sub.text,
						speakerID: sub.speakerID,
					})),
				})),
			},
		],
	};
}

export interface FirstCutCoreResult {
	/** The edited project, flat/persistable shape (ready to serialize or map to regions). */
	flat: CuttiProject;
	/** Phrases transcribed. */
	total: number;
	/** Phrases the executor actually dropped. */
	applied: number;
	skipped: number;
}

/**
 * Transcript → first cut → edited flat project, via the real cutti executor.
 * `decide` lets callers swap the heuristic for an LLM-produced batch.
 */
export function runFirstCut(
	captions: CaptionSegment[],
	sourceVideoID: string,
	decide: (segments: TimelineSegment[]) => AIActionBatch = heuristicCutBatch,
): FirstCutCoreResult {
	const segments = captionsToSegments(captions, sourceVideoID);
	const batch = decide(segments);
	const result = applyActionBatch(batch, segments);
	return {
		flat: segmentsToFlat(result.segments),
		total: segments.length,
		applied: result.appliedCount,
		skipped: result.skippedCount,
	};
}

/** Transcript → bring-your-own-key LLM keep/cut → edited flat project. */
export async function runFirstCutAI(
	captions: CaptionSegment[],
	sourceVideoID: string,
	config: CuttiLlmConfig,
	fetchImpl?: typeof fetch,
): Promise<FirstCutCoreResult> {
	const cutIndices = await aiKeepCut(captions, config, fetchImpl);
	return runFirstCut(captions, sourceVideoID, (segs) => cutIndicesToBatch(segs, cutIndices));
}

export interface DemoEditCoreResult {
	flat: CuttiProject;
	applied: number;
	skipped: number;
}

/**
 * Run a real cutti edit on the bundled demo through the ported executor and
 * return the edited flat project. Demo batch: drop a filler segment, then 2x a
 * later segment — both genuine executor ops (applied, not pre-baked).
 */
export function runDemoEditFlat(): DemoEditCoreResult {
	const segments = flatToSegments(CUTTI_DEMO_PROJECT);
	const batch: AIActionBatch = {
		explanation: "cutti demo: 删冗余段 + 提速",
		actions: [
			{ type: "deleteSegment", id: "seg-2" },
			{ type: "setSpeed", id: "seg-3", rate: 2 },
		],
	};
	const result = applyActionBatch(batch, segments);
	return {
		flat: segmentsToFlat(result.segments),
		applied: result.appliedCount,
		skipped: result.skippedCount,
	};
}
