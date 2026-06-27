/**
 * cutti ↔ openscreen bridge.
 *
 * cutti's editing model is segment-based: the primary video track is an ordered
 * list of kept source-ranges (each with its own speed + subtitles), and the
 * COMPOSED timeline is their concatenation — so composed-time ≠ source-time once
 * anything is cut or sped. openscreen, by contrast, keeps a single continuous
 * recording with flat region arrays (Trim/Speed/Annotation) in SOURCE time and
 * today treats composed-time == source-time (trim is rendered but not enforced
 * in preview/export).
 *
 * This module does two things:
 *   1. `cuttiToRegions` — express cutti segments in openscreen's region model
 *      (TrimRegion + SpeedRegion + caption AnnotationRegion), in source-ms, so
 *      openscreen's existing timeline + overlay rendering can show them.
 *   2. `buildComposedTimeline` — the piece openscreen is missing: the
 *      composed→source map the preview/export clock must apply so trim actually
 *      cuts (the playhead is composed time; `video.currentTime` is source time).
 *
 * SCOPE / LIMITATION (v0): this maps the PRIMARY video track only, and assumes
 * segments are in source order (the transcript keep/cut case). cutti reordering
 * or multi-source inserts (insertSourceClip) cannot be represented by
 * openscreen's single-source flat-region model and are out of scope here.
 */

import type { CuttiProject, CuttiSegment } from "@foxscreen/cutti-core";
import {
	type AnnotationRegion,
	clampPlaybackSpeed,
	DEFAULT_ANNOTATION_STYLE,
	type SpeedRegion,
	type TrimRegion,
} from "@/components/video-editor/types";
import { type EditorState, INITIAL_EDITOR_STATE } from "@/hooks/useEditorHistory";

/** cutti's own speed clamp (mirrors CuttiKit TimelineSegment.normalizedSpeedRate). */
const CUTTI_MIN_SPEED = 0.25;
const CUTTI_MAX_SPEED = 4.0;

function clampCuttiSpeed(rate: number): number {
	return Math.max(CUTTI_MIN_SPEED, Math.min(rate, CUTTI_MAX_SPEED));
}

/** The primary video track's segments (first `video` track, else first track). */
export function primarySegments(project: CuttiProject): CuttiSegment[] {
	const track = project.tracks.find((t) => t.kind === "video") ?? project.tracks[0];
	return track ? track.segments : [];
}

export interface CuttiRegions {
	trimRegions: TrimRegion[];
	speedRegions: SpeedRegion[];
	annotationRegions: AnnotationRegion[];
}

/**
 * Express cutti segments as openscreen regions (source-ms). One TrimRegion per
 * kept segment; a SpeedRegion per non-1x segment; one caption AnnotationRegion
 * per subtitle, placed at its absolute source time.
 */
export function cuttiToRegions(project: CuttiProject): CuttiRegions {
	const segs = primarySegments(project);
	const trimRegions: TrimRegion[] = [];
	const speedRegions: SpeedRegion[] = [];
	const annotationRegions: AnnotationRegion[] = [];

	for (const seg of segs) {
		const startMs = seg.startSeconds * 1000;
		const endMs = seg.endSeconds * 1000;
		trimRegions.push({ id: `trim-${seg.id}`, startMs, endMs });

		const speed = clampCuttiSpeed(seg.speedRate);
		if (speed !== 1) {
			speedRegions.push({
				id: `speed-${seg.id}`,
				startMs,
				endMs,
				speed: clampPlaybackSpeed(speed),
			});
		}

		const subs = seg.subtitles ?? [];
		subs.forEach((sub, i) => {
			const subStartMs = (seg.startSeconds + sub.relativeStart) * 1000;
			const subEndMs = subStartMs + sub.relativeDuration * 1000;
			annotationRegions.push({
				id: `sub-${seg.id}-${i}`,
				startMs: subStartMs,
				endMs: subEndMs,
				type: "text",
				content: sub.text,
				textContent: sub.text,
				position: { x: 50, y: 85 },
				size: { width: 90, height: 16 },
				style: { ...DEFAULT_ANNOTATION_STYLE },
				zIndex: 0,
				annotationSource: "auto-caption",
			});
		});
	}

	return { trimRegions, speedRegions, annotationRegions };
}

/**
 * Load a cutti project into a full openscreen `EditorState` — the regions from
 * {@link cuttiToRegions} merged onto a base state (defaults to
 * `INITIAL_EDITOR_STATE`). This is the data path: a cutti project.json becomes
 * the openscreen editor's working state. (The preview clock still needs the
 * composed→source map from {@link buildComposedTimeline} to enforce the cuts.)
 */
export function cuttiProjectToEditorState(
	project: CuttiProject,
	base: EditorState = INITIAL_EDITOR_STATE,
): EditorState {
	const { trimRegions, speedRegions, annotationRegions } = cuttiToRegions(project);
	return { ...base, trimRegions, speedRegions, annotationRegions };
}

export interface ComposedSegment {
	seg: CuttiSegment;
	composedStartMs: number;
	composedEndMs: number;
	/** Clamped speed used for the composed-duration math. */
	speed: number;
}

export interface SourcePoint {
	sourceVideoID: string;
	sourceMs: number;
}

export interface ComposedTimeline {
	totalComposedMs: number;
	segments: ComposedSegment[];
	/**
	 * Map a composed-timeline position to the source-video time the player should
	 * seek to. Mirrors CuttiKit `AIActionExecutor.sourceTime`: within a segment,
	 * sourceMs = segStartMs + composedOffset * speed. Returns null for an empty
	 * timeline; clamps to [0, total]; at/after the end returns the last segment's
	 * out-point.
	 */
	composedToSource(composedMs: number): SourcePoint | null;
	/** The composed segment active at a composed-time, or null. */
	activeAt(composedMs: number): ComposedSegment | null;
}

export function buildComposedTimeline(project: CuttiProject): ComposedTimeline {
	const segs = primarySegments(project);
	const composed: ComposedSegment[] = [];
	let offset = 0;
	for (const seg of segs) {
		const speed = clampCuttiSpeed(seg.speedRate);
		const sourceDurMs = (seg.endSeconds - seg.startSeconds) * 1000;
		const composedDurMs = sourceDurMs / speed;
		composed.push({
			seg,
			composedStartMs: offset,
			composedEndMs: offset + composedDurMs,
			speed,
		});
		offset += composedDurMs;
	}
	const total = offset;

	function activeAt(composedMs: number): ComposedSegment | null {
		if (composed.length === 0) return null;
		const clamped = Math.max(0, Math.min(composedMs, total));
		for (const c of composed) {
			if (clamped >= c.composedStartMs && clamped < c.composedEndMs) return c;
		}
		return composed[composed.length - 1] ?? null;
	}

	return {
		totalComposedMs: total,
		segments: composed,
		activeAt,
		composedToSource(composedMs: number): SourcePoint | null {
			const c = activeAt(composedMs);
			if (!c) return null;
			const clamped = Math.max(0, Math.min(composedMs, total));
			const withinComposed = Math.max(0, clamped - c.composedStartMs);
			const sourceMs = c.seg.startSeconds * 1000 + withinComposed * c.speed;
			const outMs = c.seg.endSeconds * 1000;
			return { sourceVideoID: c.seg.sourceVideoID, sourceMs: Math.min(sourceMs, outMs) };
		},
	};
}
