/**
 * AIAction discriminated union — the 12 in-scope timeline/subtitle-text actions.
 *
 * Ported from `CuttiKit.AIAction` (AIActionSystem.swift). Out of scope for v0
 * and intentionally absent: `setSubtitleStyle`, `setSubtitlesVisible` (they
 * need the SubtitleStyle/SubtitleStylePatch M2 milestone). This is a *complete*
 * union for what v0 supports — not a stub.
 *
 * Each action carries a `type` discriminant. The JSON wire shape (for the CLI
 * `apply` command and any agent driving the daemon) is exactly these objects.
 * UUIDs are strings.
 */

export interface DeleteSegmentAction {
	type: "deleteSegment";
	id: string;
}

export interface DeleteRangeAction {
	type: "deleteRange";
	start: number;
	end: number;
}

export interface SplitSegmentAction {
	type: "splitSegment";
	id: string;
	atSourceTime: number;
}

export interface TrimStartAction {
	type: "trimStart";
	id: string;
	newStart: number;
}

export interface TrimEndAction {
	type: "trimEnd";
	id: string;
	newEnd: number;
}

export interface SetVolumeAction {
	type: "setVolume";
	id: string;
	level: number;
}

export interface SetSpeedAction {
	type: "setSpeed";
	id: string;
	rate: number;
}

export interface SetSpeedRangeAction {
	type: "setSpeedRange";
	start: number;
	end: number;
	rate: number;
}

export interface ReorderSegmentsAction {
	type: "reorderSegments";
	ids: string[];
}

export interface InsertSourceClipAction {
	type: "insertSourceClip";
	sourceVideoID: string;
	sourceStart: number;
	sourceEnd: number;
	composedInsertAt: number;
	fadeInSeconds: number;
	fadeOutSeconds: number;
}

/**
 * Replace the text of a single subtitle cue. Exactly one of `id` / `atSeconds`
 * should be provided; `id` wins if both are set. Mirrors Swift
 * `editSubtitle(id:atSeconds:newText:)`.
 */
export interface EditSubtitleAction {
	type: "editSubtitle";
	id?: string;
	atSeconds?: number;
	newText: string;
}

/** Batch find-and-replace inside every subtitle cue. */
export interface ReplaceSubtitleTextAction {
	type: "replaceSubtitleText";
	find: string;
	replaceWith: string;
	isRegex: boolean;
}

export type AIAction =
	| DeleteSegmentAction
	| DeleteRangeAction
	| SplitSegmentAction
	| TrimStartAction
	| TrimEndAction
	| SetVolumeAction
	| SetSpeedAction
	| SetSpeedRangeAction
	| ReorderSegmentsAction
	| InsertSourceClipAction
	| EditSubtitleAction
	| ReplaceSubtitleTextAction;

/** A batch of AI actions with an explanation, applied atomically/in order. */
export interface AIActionBatch {
	actions: AIAction[];
	explanation: string;
}
