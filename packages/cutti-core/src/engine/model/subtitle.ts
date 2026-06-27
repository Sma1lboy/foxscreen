/**
 * Subtitle value types.
 *
 * Ported from `CuttiKit.SubtitleEntry` + `CuttiKit.WordTiming`
 * (AICopilotMetadata.swift / SubtitleKaraoke.swift).
 *
 * `relativeStart` / `relativeDuration` are **source-time (pre-speed)** offsets
 * within the parent segment, matching the Swift comment in
 * `AIActionExecutor.locateSubtitle`. `WordTiming` times are entry-relative
 * (seconds from `relativeStart`).
 *
 * `runs` and `styleOverride` are out-of-scope for the v0 action set (they live
 * in the M2 SubtitleStyle milestone), so they are typed as opaque `unknown`
 * here: the executor only ever **drops** them (sets to undefined) on a text
 * edit, and persistence carries them through verbatim. Typing them `unknown`
 * keeps round-tripping honest without modelling the style system.
 */

export interface WordTiming {
	/**
	 * The word / token text as emitted by the transcriber. May carry leading
	 * whitespace (e.g. " hello").
	 */
	text: string;
	/** Entry-relative start time in seconds. */
	startSeconds: number;
	/** Entry-relative end time in seconds. Always >= startSeconds. */
	endSeconds: number;
}

/** Mirrors `WordTiming.init`, which clamps `endSeconds >= startSeconds`. */
export function makeWordTiming(text: string, startSeconds: number, endSeconds: number): WordTiming {
	return { text, startSeconds, endSeconds: Math.max(startSeconds, endSeconds) };
}

export interface SubtitleEntry {
	id: string;
	/** Offset in seconds from the start of the parent segment (source-time). */
	relativeStart: number;
	/** Duration in seconds within the parent segment (source-time). */
	relativeDuration: number;
	text: string;
	/** Zero-based diarization speaker index; undefined = not diarized. */
	speakerID?: number;
	/** Translations keyed by BCP-47 locale. Empty object = none. */
	translations: Record<string, string>;
	/**
	 * Per-run rich-text styling. Opaque in v0 — carried through persistence,
	 * dropped (set undefined) on a text edit, never interpreted by the executor.
	 */
	runs?: unknown;
	/** Per-word timestamps for karaoke. undefined = none. */
	wordTimings?: WordTiming[];
	/**
	 * Per-cue style override. Opaque in v0 (M2 SubtitleStyle milestone). Carried
	 * through persistence; preserved across a text edit (matching Swift's
	 * `editSubtitle` which keeps `styleOverride`).
	 */
	styleOverride?: unknown;
}

export interface MakeSubtitleEntryArgs {
	id: string;
	relativeStart: number;
	relativeDuration: number;
	text: string;
	speakerID?: number;
	translations?: Record<string, string>;
	runs?: unknown;
	wordTimings?: WordTiming[];
	styleOverride?: unknown;
}

/** Mirrors the Swift `SubtitleEntry.init` defaults. */
export function makeSubtitleEntry(args: MakeSubtitleEntryArgs): SubtitleEntry {
	return {
		id: args.id,
		relativeStart: args.relativeStart,
		relativeDuration: args.relativeDuration,
		text: args.text,
		speakerID: args.speakerID,
		translations: args.translations ?? {},
		runs: args.runs,
		wordTimings: args.wordTimings,
		styleOverride: args.styleOverride,
	};
}

export function cloneSubtitleEntry(e: SubtitleEntry): SubtitleEntry {
	return {
		id: e.id,
		relativeStart: e.relativeStart,
		relativeDuration: e.relativeDuration,
		text: e.text,
		speakerID: e.speakerID,
		translations: { ...e.translations },
		runs: e.runs,
		wordTimings: e.wordTimings ? e.wordTimings.map((w) => ({ ...w })) : undefined,
		styleOverride: e.styleOverride,
	};
}
