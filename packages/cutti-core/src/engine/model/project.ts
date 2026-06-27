/**
 * Project / Track model.
 *
 * Ported from `CuttiKit.Project` + `CuttiKit.Track` + `CuttiKit.TrackKind`
 * (Project.swift). The daemon edits the **primary video track's segments** —
 * `primarySegments` is the read/write accessor every in-scope action operates
 * through, exactly like the Swift `Project.primarySegments` shim.
 *
 * VoiceEnhancer settings are out of scope for v0, so `voiceEnhancer` is omitted
 * from the runtime model (persistence does not carry it either; project.json is
 * a tracks-first schema based on PersistableTrack).
 */

import type { TimelineSegment } from "./timelineSegment";

export type TrackKind = "video" | "audio" | "overlay";

export interface Track {
	id: string;
	kind: TrackKind;
	name: string;
	isMuted: boolean;
	isSolo: boolean;
	isLocked: boolean;
	segments: TimelineSegment[];
}

export interface MakeTrackArgs {
	id: string;
	kind: TrackKind;
	name: string;
	isMuted?: boolean;
	isSolo?: boolean;
	isLocked?: boolean;
	segments?: TimelineSegment[];
}

export function makeTrack(args: MakeTrackArgs): Track {
	return {
		id: args.id,
		kind: args.kind,
		name: args.name,
		isMuted: args.isMuted ?? false,
		isSolo: args.isSolo ?? false,
		isLocked: args.isLocked ?? false,
		segments: args.segments ?? [],
	};
}

export interface Project {
	tracks: Track[];
}

/** Mirrors `Project.makePrimaryVideoTrack`. Requires an id (UUIDs are strings). */
export function makePrimaryVideoTrack(id: string, segments: TimelineSegment[] = []): Track {
	return makeTrack({ id, kind: "video", name: "V1 (Main)", segments });
}

/**
 * Index of the primary video track. Mirrors
 * `Project.primaryVideoTrackIndex` — first `.video` track, else 0.
 */
export function primaryVideoTrackIndex(project: Project): number {
	const idx = project.tracks.findIndex((t) => t.kind === "video");
	return idx >= 0 ? idx : 0;
}

/** Read accessor mirroring `Project.primarySegments` getter. */
export function primarySegments(project: Project): TimelineSegment[] {
	const idx = primaryVideoTrackIndex(project);
	const track = project.tracks[idx];
	return track ? track.segments : [];
}

/**
 * Write accessor mirroring `Project.primarySegments` setter (returns a new
 * project value; the daemon treats Project as an immutable value like the
 * Swift struct).
 */
export function withPrimarySegments(
	project: Project,
	segments: TimelineSegment[],
	newTrackID: () => string,
): Project {
	const idx = primaryVideoTrackIndex(project);
	const tracks = project.tracks.slice();
	if (idx < tracks.length) {
		tracks[idx] = { ...tracks[idx], segments };
	} else {
		tracks.push(makePrimaryVideoTrack(newTrackID(), segments));
	}
	return { tracks };
}

export function audioTracks(project: Project): Track[] {
	return project.tracks.filter((t) => t.kind === "audio");
}

export function overlayTracks(project: Project): Track[] {
	return project.tracks.filter((t) => t.kind === "overlay");
}
