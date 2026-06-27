/**
 * cutti project.json shape (the flat persistable form the cutti daemon writes —
 * see daemon/src/persistence/projectFile.ts). Times are in SECONDS. The
 * adapter converts these into openscreen's region model (which works in ms).
 */

export interface CuttiSubtitle {
	id?: string;
	/** Seconds from the parent segment start (source time, pre-speed). */
	relativeStart: number;
	relativeDuration: number;
	text: string;
	speakerID?: number;
}

export interface CuttiSegment {
	id: string;
	sourceVideoID: string;
	/** Source-video in-point (seconds). */
	startSeconds: number;
	/** Source-video out-point (seconds). */
	endSeconds: number;
	text: string;
	/** Per-segment speed (cutti clamps 0.25..4.0). */
	speedRate: number;
	volumeLevel?: number;
	isVideoHidden?: boolean;
	subtitles?: CuttiSubtitle[];
}

export interface CuttiTrack {
	kind: string; // "video" | "audio" | "overlay"
	segments: CuttiSegment[];
}

export interface CuttiProject {
	version: number;
	tracks: CuttiTrack[];
}
