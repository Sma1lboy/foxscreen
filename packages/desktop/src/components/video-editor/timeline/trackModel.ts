/**
 * Per-track state for the standard-NLE timeline — the lane-level controls that
 * sit above the per-clip model in {@link ./clipModel}.
 *
 * A {@link TimelineClip} only carries an implicit `trackIndex`; a
 * {@link TimelineTrack} is the explicit lane it lives on, holding the mixer-style
 * flags an editor expects: **mute**, **solo**, and **lock**. These are pure,
 * render-agnostic helpers (browser+node safe, fully unit-tested) so playback,
 * export and the timeline UI all read "is this lane audible / editable" from one
 * source of truth.
 *
 * `kind` (video/audio) is retained from the previous implicit lane layout so the
 * timeline can still draw a poster frame vs. a waveform and label V1/A3; it is
 * derivable from the index (see {@link trackKindForIndex}) and never user-set.
 */
import { gainAt, type TimelineClip, type TrackKind } from "./clipModel";

/** One explicit lane: its index, a derivable name/kind, and its mixer flags. */
export interface TimelineTrack {
	/** 0-based lane position (matches {@link TimelineClip.trackIndex}). */
	index: number;
	/** Simple, derivable display name (`Track ${index + 1}`); UI may re-i18n. */
	name: string;
	/** Whether the lane carries picture or sound (drives the timeline visuals). */
	kind: TrackKind;
	/** Silence every clip on this lane regardless of per-clip gain. */
	muted: boolean;
	/** Forbid moving/trimming/deleting clips on this lane. */
	locked: boolean;
	/** When any lane is soloed, only soloed lanes are audible. */
	solo: boolean;
}

/**
 * The kind of a lane derived purely from its index, reproducing the historic
 * default layout: lane 2 is the audio lane, every other lane carries video.
 * (Extending past index 2 keeps adding video lanes, matching the old behaviour.)
 */
export function trackKindForIndex(index: number): TrackKind {
	return index === 2 ? "audio" : "video";
}

/** A fresh, all-flags-false track for a lane index. */
export function makeTrack(index: number): TimelineTrack {
	return {
		index,
		name: `Track ${index + 1}`,
		kind: trackKindForIndex(index),
		muted: false,
		locked: false,
		solo: false,
	};
}

/** Default lane layout when a project carries no explicit tracks: V1 / V2 / A3. */
export const DEFAULT_TRACKS: TimelineTrack[] = [makeTrack(0), makeTrack(1), makeTrack(2)];

/**
 * Derive the explicit track list for a set of clips: one contiguous lane per
 * index from 0 up to the highest `trackIndex` present (so a clip never lacks a
 * lane), with a minimum of one lane. All flags default false. Used as the
 * fallback when restoring a project whose clips arrived without a `tracks` array.
 */
export function defaultTracksForClips(clips: TimelineClip[]): TimelineTrack[] {
	let maxIndex = 0;
	for (const clip of clips) {
		if (clip.trackIndex > maxIndex) maxIndex = clip.trackIndex;
	}
	const tracks: TimelineTrack[] = [];
	for (let i = 0; i <= maxIndex; i++) tracks.push(makeTrack(i));
	return tracks;
}

/** Look up a track by lane index, or `null` when absent. */
export function trackAtIndex(tracks: TimelineTrack[], index: number): TimelineTrack | null {
	return tracks.find((t) => t.index === index) ?? null;
}

/**
 * Solo-aware audibility for a single lane: if **any** lane is soloed, only
 * soloed lanes are audible; otherwise a lane is audible unless it is muted. A
 * `null` track (lane has no explicit entry) is treated as audible so behaviour
 * is unchanged when tracks aren't threaded through. Pure — the single source of
 * truth for "should this lane make sound right now".
 */
export function isTrackAudible(track: TimelineTrack | null, allTracks: TimelineTrack[]): boolean {
	if (!track) {
		// No explicit lane: only silence it if some OTHER lane is soloing.
		return !allTracks.some((t) => t.solo);
	}
	const anySolo = allTracks.some((t) => t.solo);
	if (anySolo) return track.solo;
	return !track.muted;
}

/**
 * Effective playback gain (0–1) for a clip at an absolute timeline time,
 * combining the per-clip envelope ({@link gainAt}) with its lane's solo-aware
 * audibility ({@link isTrackAudible}). Returns `0` when the lane is inaudible.
 * Pure — playback and export both read loudness from here.
 */
export function effectiveClipGain(
	clip: TimelineClip,
	track: TimelineTrack | null,
	allTracks: TimelineTrack[],
	atSec: number,
): number {
	if (!isTrackAudible(track, allTracks)) return 0;
	return gainAt(clip, atSec);
}

/** Whether a lane is locked (clips on it can't be edited). `null`/missing = unlocked. */
export function isTrackLocked(tracks: TimelineTrack[], index: number): boolean {
	return trackAtIndex(tracks, index)?.locked ?? false;
}

/** Append a fresh lane after the last one. Pure — returns a new array. */
export function addTrack(tracks: TimelineTrack[]): TimelineTrack[] {
	const nextIndex = tracks.reduce((m, t) => Math.max(m, t.index), -1) + 1;
	return [...tracks, makeTrack(nextIndex)];
}

/**
 * Remove the lane at `index` and re-index the lanes above it so the list stays
 * contiguous (`0..n-1`), recomputing each shifted lane's name/kind from its new
 * index while preserving its flags. Returns the input unchanged when there is
 * only one lane (a timeline always keeps at least one). Pure.
 *
 * NOTE: the caller is responsible for the matching clip edit — dropping clips on
 * the removed lane and decrementing `trackIndex` on lanes above it (see
 * {@link reindexClipsForRemovedTrack}).
 */
export function removeTrack(tracks: TimelineTrack[], index: number): TimelineTrack[] {
	if (tracks.length <= 1) return tracks;
	const kept = tracks.filter((t) => t.index !== index);
	return kept.map((t) => {
		if (t.index < index) return t;
		const newIndex = t.index - 1;
		return {
			...t,
			index: newIndex,
			name: `Track ${newIndex + 1}`,
			kind: trackKindForIndex(newIndex),
		};
	});
}

/**
 * The clip-side of {@link removeTrack}: drop every clip on the removed lane and
 * shift clips on higher lanes down by one so they stay aligned with the
 * re-indexed track list. Pure — returns a new array.
 */
export function reindexClipsForRemovedTrack(clips: TimelineClip[], index: number): TimelineClip[] {
	return clips
		.filter((c) => c.trackIndex !== index)
		.map((c) => (c.trackIndex > index ? { ...c, trackIndex: c.trackIndex - 1 } : c));
}

/** Toggle the `muted` flag on the lane at `index`. Pure. */
export function toggleMuted(tracks: TimelineTrack[], index: number): TimelineTrack[] {
	return tracks.map((t) => (t.index === index ? { ...t, muted: !t.muted } : t));
}

/** Toggle the `locked` flag on the lane at `index`. Pure. */
export function toggleLocked(tracks: TimelineTrack[], index: number): TimelineTrack[] {
	return tracks.map((t) => (t.index === index ? { ...t, locked: !t.locked } : t));
}

/** Toggle the `solo` flag on the lane at `index`. Pure. */
export function toggleSolo(tracks: TimelineTrack[], index: number): TimelineTrack[] {
	return tracks.map((t) => (t.index === index ? { ...t, solo: !t.solo } : t));
}
