/**
 * Pure "render plan" for sequencing the clip-based timeline into an export.
 *
 * The standard-NLE timeline ({@link TimelineClip}[]) is a set of trimmed source
 * slices placed on tracks. To render it to a single output video we flatten the
 * *topmost* video track into an ordered list of contiguous {@link RenderSegment}s
 * spanning `[0, clipsTotalDuration]`. Each segment is either:
 *
 *  - an **active clip** span — the clip under the playhead (top track wins via
 *    {@link clipAtTime}), with the exact source time window to decode
 *    (`sourceStartSec`/`sourceEndSec` = `clip.inSec + offset`); or
 *  - a **gap** (`clip === null`) — black frames / silence.
 *
 * This module is intentionally render-agnostic and side-effect free so it can be
 * unit-tested headlessly (the selftest vitest runs `src/lib/**`). The exporter
 * consumes the plan to drive decode → compositor → encoder in timeline order.
 *
 * v1 scope: top-video-track sequencing + per-clip trim (in/out) + audio gain that
 * mirrors the active video clip (volume/mute/fade via {@link gainAt}).
 * Out of scope (follow-ups): cross-track compositing (V2 over V1), transitions,
 * and per-clip openscreen effects (zoom/padding/wallpaper).
 */
import {
	clipAtTime,
	clipEndSec,
	clipsTotalDuration,
	gainAt,
	type TimelineClip,
} from "@/components/video-editor/timeline/clipModel";
import {
	effectiveClipGain,
	type TimelineTrack,
	trackAtIndex,
} from "@/components/video-editor/timeline/trackModel";

/** Track indices that carry picture (mirror of clipModel's video-track set). */
const VIDEO_TRACK_INDICES = new Set([0, 1]);

function isVideoClip(clip: TimelineClip): boolean {
	return VIDEO_TRACK_INDICES.has(clip.trackIndex);
}

/** One contiguous span of the flattened output timeline. */
export interface RenderSegment {
	/** Timeline start, inclusive (seconds). */
	startSec: number;
	/** Timeline end, exclusive (seconds). */
	endSec: number;
	/** First output frame index covered, inclusive. */
	startFrame: number;
	/** One past the last output frame index covered (exclusive). */
	endFrame: number;
	/** Active top-track video clip for this span, or `null` for a gap (black). */
	clip: TimelineClip | null;
	/** Source in-point to start decoding from (`clip.inSec + offset`); 0 for gaps. */
	sourceStartSec: number;
	/** Source out-point to stop decoding at; 0 for gaps. */
	sourceEndSec: number;
}

/** The full ordered render plan for an export. */
export interface TimelineRenderPlan {
	/** Ordered, non-overlapping segments covering `[0, totalDuration]`. */
	segments: RenderSegment[];
	/** Output duration in seconds (= {@link clipsTotalDuration}). */
	totalDuration: number;
	/** Output frame rate the plan was built for. */
	fps: number;
	/** Total output frame count (frame-boundary aligned, sums over segments). */
	totalFrames: number;
}

const EPSILON_SEC = 1e-6;

/** Number of output frames a segment contributes. */
export function segmentFrameCount(segment: RenderSegment): number {
	return Math.max(0, segment.endFrame - segment.startFrame);
}

/**
 * Build the flattened render plan for a clip timeline at a given output `fps`.
 *
 * Segment boundaries are placed at every top-track video clip's start/end edge
 * (clamped to `[0, total]`); within each span the active clip is constant, so its
 * source window maps linearly: `source = clip.inSec + (timelineTime - clip.startSec)`.
 * Adjacent spans that resolve to the same clip (or are both gaps) are merged so a
 * clip is decoded in one continuous pass. Frame indices are derived by rounding
 * each boundary to `round(sec * fps)`, which telescopes so the per-segment frame
 * counts sum exactly to `totalFrames` with no drift.
 *
 * An empty timeline yields an empty plan (`segments: []`, `totalFrames: 0`).
 */
export function buildTimelineRenderPlan(clips: TimelineClip[], fps: number): TimelineRenderPlan {
	if (!Number.isFinite(fps) || fps <= 0) {
		throw new Error(`buildTimelineRenderPlan: fps must be a positive number, got ${fps}`);
	}

	const totalDuration = clipsTotalDuration(clips);
	if (totalDuration <= 0) {
		return { segments: [], totalDuration: 0, fps, totalFrames: 0 };
	}

	// Collect ordered, unique boundary times from every video clip edge.
	const boundarySet = new Set<number>([0, totalDuration]);
	for (const clip of clips) {
		if (!isVideoClip(clip)) continue;
		const start = Math.min(Math.max(clip.startSec, 0), totalDuration);
		const end = Math.min(Math.max(clipEndSec(clip), 0), totalDuration);
		boundarySet.add(start);
		boundarySet.add(end);
	}
	const boundaries = Array.from(boundarySet).sort((a, b) => a - b);

	const segments: RenderSegment[] = [];
	for (let i = 0; i < boundaries.length - 1; i++) {
		const startSec = boundaries[i];
		const endSec = boundaries[i + 1];
		if (endSec - startSec <= EPSILON_SEC) continue;

		// The active clip is constant across (startSec, endSec); sample just inside
		// the span so a boundary that is one clip's end and another's start resolves
		// to the span's owner (clipAtTime is half-open `[start, end)`).
		const probe = startSec + Math.min(EPSILON_SEC, (endSec - startSec) / 2);
		const clip = clipAtTime(clips, probe);

		const sourceStartSec = clip ? clip.inSec + (startSec - clip.startSec) : 0;
		const sourceEndSec = clip ? clip.inSec + (endSec - clip.startSec) : 0;

		const startFrame = Math.round(startSec * fps);
		const endFrame = Math.round(endSec * fps);

		const prev = segments[segments.length - 1];
		const sameClip =
			prev &&
			((prev.clip === null && clip === null) ||
				(prev.clip !== null && clip !== null && prev.clip.id === clip.id));
		if (sameClip) {
			// Extend the previous segment so a clip decodes in one continuous pass.
			prev.endSec = endSec;
			prev.endFrame = endFrame;
			prev.sourceEndSec = sourceEndSec;
			continue;
		}

		segments.push({
			startSec,
			endSec,
			startFrame,
			endFrame,
			clip,
			sourceStartSec,
			sourceEndSec,
		});
	}

	const totalFrames = Math.round(totalDuration * fps);
	return { segments, totalDuration, fps, totalFrames };
}

/**
 * Audio gain (0–1) for the output timeline at an absolute time. v1 audio mirrors
 * the active video clip: the gain of the clip under the playhead (top track wins),
 * shaped by its volume/mute/fade envelope ({@link gainAt}); `0` in gaps. When a
 * `tracks` list is supplied the gain is additionally gated by the active clip's
 * lane audibility ({@link effectiveClipGain}) — a muted lane (or a non-soloed lane
 * while something is soloed) contributes silence. Omitting `tracks` keeps the
 * legacy all-audible behaviour. Pure — the source of truth the exporter samples
 * per audio frame.
 */
export function planAudioGainAt(
	clips: TimelineClip[],
	timelineSec: number,
	tracks?: TimelineTrack[],
): number {
	const clip = clipAtTime(clips, timelineSec);
	if (!clip) return 0;
	if (!tracks) return gainAt(clip, timelineSec);
	return effectiveClipGain(clip, trackAtIndex(tracks, clip.trackIndex), tracks, timelineSec);
}
