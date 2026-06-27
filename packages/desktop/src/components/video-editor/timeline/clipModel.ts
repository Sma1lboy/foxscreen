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
}

export type TrackKind = "video" | "audio";

export interface TimelineTrack {
	index: number;
	kind: TrackKind;
}

/** Smallest allowed clip length (source window and timeline span), in seconds. */
export const MIN_CLIP_LENGTH = 0.1;

/** Default lane layout: two video tracks stacked over one audio track. */
export const DEFAULT_TRACKS: TimelineTrack[] = [
	{ index: 0, kind: "video" },
	{ index: 1, kind: "video" },
	{ index: 2, kind: "audio" },
];

/** Source/timeline duration of a clip. */
export function clipDuration(clip: TimelineClip): number {
	return Math.max(0, clip.outSec - clip.inSec);
}

/** Timeline position of a clip's right edge. */
export function clipEndSec(clip: TimelineClip): number {
	return clip.startSec + clipDuration(clip);
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
