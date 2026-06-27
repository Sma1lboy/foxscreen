/**
 * Clip-based multi-track timeline model — the standard-NLE foundation.
 *
 * A {@link TimelineClip} is one trimmed slice of a source asset placed on a
 * track at a position on the timeline. Its on-timeline span is
 * `[startSec, startSec + (outSec - inSec)]`; the `[inSec, outSec]` window picks
 * which part of the source plays. This is intentionally render-agnostic — the
 * preview today plays a single active clip's source; multi-clip compositing is
 * a later phase.
 */

/** One trimmed slice of a source asset placed on a track. */
export interface TimelineClip {
	id: string;
	/** Id of the source MediaAsset this clip was cut from. */
	assetId: string;
	/** Display name (asset basename). */
	name: string;
	/** Absolute source path on disk (drives the preview when selected). */
	sourcePath: string;
	/** Which track lane this clip lives on (0-based). */
	trackIndex: number;
	/** Timeline position of the clip's left edge, in seconds. */
	startSec: number;
	/** Source in-point (trim from the head of the source), in seconds. */
	inSec: number;
	/** Source out-point (trim from the tail of the source), in seconds. */
	outSec: number;
	/** Linear playback gain, 0–1 (default 1). */
	volume?: number;
	/** Silence the clip regardless of {@link volume}/fades (default false). */
	muted?: boolean;
	/** Fade-in ramp length at the clip head, in timeline seconds (default 0). */
	fadeInSec?: number;
	/** Fade-out ramp length at the clip tail, in timeline seconds (default 0). */
	fadeOutSec?: number;
}

export type TrackKind = "video" | "audio";

/**
 * Per-track lane state ({@link TimelineTrack}, mute/solo/lock) lives in the
 * sibling `./trackModel` module so this file stays purely about clips.
 */

/** Smallest allowed clip length (source window and timeline span), in seconds. */
export const MIN_CLIP_LENGTH = 0.1;

/** Source/timeline duration of a clip. */
export function clipDuration(clip: TimelineClip): number {
	return Math.max(0, clip.outSec - clip.inSec);
}

/** Timeline position of a clip's right edge. */
export function clipEndSec(clip: TimelineClip): number {
	return clip.startSec + clipDuration(clip);
}

/**
 * Playback gain (0–1) for a clip at an absolute timeline time. Returns `0`
 * outside the clip span or when muted; otherwise the clip's `volume`
 * (default 1) shaped by a linear fade envelope — ramping 0→1 across the
 * `fadeInSec` head and 1→0 across the `fadeOutSec` tail, flat `1` in between.
 * Each fade is clamped to at most half the clip duration so the two ramps
 * never overlap. Pure — the single source of truth for "how loud is this clip
 * right now" (preview today, export later).
 */
export function gainAt(clip: TimelineClip, timelineSec: number): number {
	const start = clip.startSec;
	const end = clipEndSec(clip);
	if (timelineSec < start || timelineSec >= end) return 0;
	if (clip.muted) return 0;

	const volume = clip.volume ?? 1;
	const duration = clipDuration(clip);
	if (duration <= 0) return Math.max(0, Math.min(1, volume));

	const half = duration / 2;
	const fadeIn = Math.max(0, Math.min(clip.fadeInSec ?? 0, half));
	const fadeOut = Math.max(0, Math.min(clip.fadeOutSec ?? 0, half));

	let envelope = 1;
	const sinceStart = timelineSec - start;
	const untilEnd = end - timelineSec;
	if (fadeIn > 0 && sinceStart < fadeIn) {
		envelope = Math.min(envelope, sinceStart / fadeIn);
	}
	if (fadeOut > 0 && untilEnd < fadeOut) {
		envelope = Math.min(envelope, untilEnd / fadeOut);
	}

	return Math.max(0, Math.min(1, volume * envelope));
}

let clipCounter = 0;

/** Stable-ish unique id for a new clip. */
export function genClipId(): string {
	clipCounter += 1;
	return `clip-${Date.now().toString(36)}-${clipCounter}`;
}

/**
 * Right edge (timeline seconds) of the last clip on a track — where a freshly
 * appended clip should land. Returns 0 for an empty track.
 */
export function trackEndSec(clips: TimelineClip[], trackIndex: number): number {
	let end = 0;
	for (const clip of clips) {
		if (clip.trackIndex !== trackIndex) continue;
		end = Math.max(end, clipEndSec(clip));
	}
	return end;
}

/** Overall timeline length across every clip on every track. */
export function clipsTotalDuration(clips: TimelineClip[]): number {
	let end = 0;
	for (const clip of clips) end = Math.max(end, clipEndSec(clip));
	return end;
}

/** Track indices that carry picture (drive the single-source preview). */
const VIDEO_TRACK_INDICES = new Set([0, 1]);

function isVideoClip(clip: TimelineClip): boolean {
	return VIDEO_TRACK_INDICES.has(clip.trackIndex);
}

/**
 * The video clip under the playhead, i.e. whose half-open timeline span
 * `[startSec, clipEndSec)` contains `timelineSec`. Only video tracks (0/1) are
 * considered; on overlap the topmost track wins (trackIndex 0 over 1). The end
 * boundary is exclusive, so a playhead exactly on a clip's right edge belongs to
 * the next clip (or a gap), never the one that just ended. Returns `null` for a
 * gap or empty timeline. Pure — this is the single source of truth for "which
 * source should the preview be showing right now".
 */
export function clipAtTime(clips: TimelineClip[], timelineSec: number): TimelineClip | null {
	let best: TimelineClip | null = null;
	for (const clip of clips) {
		if (!isVideoClip(clip)) continue;
		if (timelineSec < clip.startSec || timelineSec >= clipEndSec(clip)) continue;
		if (best === null || clip.trackIndex < best.trackIndex) best = clip;
	}
	return best;
}

/**
 * The smallest video-clip `startSec` strictly greater than `timelineSec`, used to
 * skip a gap (or hop to the next clip) during sequence playback. Returns `null`
 * when nothing starts later — i.e. the playhead is at/after the last clip.
 */
export function nextClipStart(clips: TimelineClip[], timelineSec: number): number | null {
	let next: number | null = null;
	for (const clip of clips) {
		if (!isVideoClip(clip)) continue;
		if (clip.startSec <= timelineSec) continue;
		if (next === null || clip.startSec < next) next = clip.startSec;
	}
	return next;
}

/**
 * A copy of a clip placed immediately after the original on the same track
 * (its left edge lands on the original's right edge), keeping the same source
 * window, track and audio. The copy gets a fresh id. Pure — used by the
 * "duplicate" shortcut/command.
 */
export function duplicateClip(clip: TimelineClip, makeId: () => string = genClipId): TimelineClip {
	return { ...clip, id: makeId(), startSec: clipEndSec(clip) };
}

/**
 * Shift a clip along the timeline by `deltaSec`, clamped so its left edge never
 * goes negative. Pure — the single source of truth for keyboard nudging.
 */
export function nudgeClip(clip: TimelineClip, deltaSec: number): TimelineClip {
	return { ...clip, startSec: Math.max(0, clip.startSec + deltaSec) };
}

/**
 * Clone a set of clips with fresh ids, every `startSec` shifted by `deltaSec`
 * while preserving the clips' relative offsets. The shift is clamped so the
 * earliest clip's left edge never goes below 0 (the whole set moves together).
 * Pure — the engine behind paste.
 */
export function offsetClips(
	clips: TimelineClip[],
	deltaSec: number,
	makeId: () => string = genClipId,
): TimelineClip[] {
	if (clips.length === 0) return [];
	const earliest = clips.reduce((min, c) => Math.min(min, c.startSec), Number.POSITIVE_INFINITY);
	// Never push the earliest clip before 0; the rest keep their relative spacing.
	const clampedDelta = Math.max(deltaSec, -earliest);
	return clips.map((c) => ({ ...c, id: makeId(), startSec: c.startSec + clampedDelta }));
}

/**
 * Paste a clipboard of clips so the earliest one lands at `atSec`, relative
 * offsets preserved and ids freshly minted. Returns `[]` for an empty
 * clipboard. Pure — wraps {@link offsetClips}.
 */
export function pasteClipsAt(
	clipboard: TimelineClip[],
	atSec: number,
	makeId: () => string = genClipId,
): TimelineClip[] {
	if (clipboard.length === 0) return [];
	const earliest = clipboard.reduce(
		(min, c) => Math.min(min, c.startSec),
		Number.POSITIVE_INFINITY,
	);
	return offsetClips(clipboard, atSec - earliest, makeId);
}

/**
 * Remove the clip with `clipId` and close the gap it leaves: every later clip on
 * the same track shifts left by the removed clip's duration (clamped at 0).
 * Clips before it, and clips on other tracks, are untouched. Returns the input
 * unchanged when the id isn't found. Pure — the shared engine for ripple-delete
 * (toolbar button + keyboard Shift+Delete).
 */
export function rippleDeleteClip(clips: TimelineClip[], clipId: string): TimelineClip[] {
	const target = clips.find((c) => c.id === clipId);
	if (!target) return clips;
	const gap = clipDuration(target);
	const cutEnd = clipEndSec(target);
	return clips
		.filter((c) => c.id !== clipId)
		.map((c) =>
			c.trackIndex === target.trackIndex && c.startSec >= cutEnd
				? { ...c, startSec: Math.max(0, c.startSec - gap) }
				: c,
		);
}

/**
 * Split a clip at an absolute timeline position into a left/right pair.
 * Returns `null` if the cut lands outside the clip (or too close to an edge to
 * leave both halves at least {@link MIN_CLIP_LENGTH} long).
 */
export function splitClipAt(
	clip: TimelineClip,
	atSec: number,
	makeId: () => string = genClipId,
): [TimelineClip, TimelineClip] | null {
	const offset = atSec - clip.startSec;
	if (offset < MIN_CLIP_LENGTH) return null;
	if (clipDuration(clip) - offset < MIN_CLIP_LENGTH) return null;
	const cutSource = clip.inSec + offset;
	const left: TimelineClip = { ...clip, outSec: cutSource };
	const right: TimelineClip = {
		...clip,
		id: makeId(),
		inSec: cutSource,
		startSec: clip.startSec + offset,
	};
	return [left, right];
}
