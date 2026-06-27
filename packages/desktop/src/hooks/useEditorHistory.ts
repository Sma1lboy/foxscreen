import { useCallback, useRef, useState } from "react";
import {
	DEFAULT_EDITOR_APPEARANCE_SETTINGS,
	DEFAULT_EDITOR_LAYOUT_SETTINGS,
	DEFAULT_WEBCAM_SETTINGS,
} from "@/components/video-editor/editorDefaults";
import type { TimelineClip } from "@/components/video-editor/timeline/clipModel";
import { DEFAULT_TRACKS, type TimelineTrack } from "@/components/video-editor/timeline/trackModel";
import type {
	AnnotationRegion,
	CropRegion,
	SpeedRegion,
	TrimRegion,
	WebcamLayoutPreset,
	WebcamMaskShape,
	WebcamPosition,
	WebcamSizePreset,
	ZoomRegion,
} from "@/components/video-editor/types";
import {
	DEFAULT_CROP_REGION,
	DEFAULT_WEBCAM_MIRRORED,
	DEFAULT_WEBCAM_REACTIVE_ZOOM,
} from "@/components/video-editor/types";
import type { AspectRatio } from "@/utils/aspectRatioUtils";

// Undoable state. Selection IDs are excluded, since undoing a selection change
// would feel surprising.
export interface EditorState {
	zoomRegions: ZoomRegion[];
	/** Magic-wand auto-zoom toggle. When on, fresh recordings get suggested zooms. */
	autoZoomEnabled: boolean;
	/** Global Auto-Focus toggle: when on, all zooms follow the cursor and the
	 * per-zoom Focus Mode selector is locked. */
	autoFocusAll: boolean;
	trimRegions: TrimRegion[];
	speedRegions: SpeedRegion[];
	annotationRegions: AnnotationRegion[];
	cropRegion: CropRegion;
	wallpaper: string;
	shadowIntensity: number;
	showBlur: boolean;
	showTrimWaveform: boolean;
	motionBlurAmount: number;
	borderRadius: number;
	padding: number;
	aspectRatio: AspectRatio;
	webcamLayoutPreset: WebcamLayoutPreset;
	webcamMaskShape: WebcamMaskShape;
	webcamMirrored: boolean;
	webcamReactiveZoom: boolean;
	webcamSizePreset: WebcamSizePreset;
	webcamPosition: WebcamPosition | null;
	/** Standard-NLE timeline clips (clip-based multi-track editing). Undoable. */
	timelineClips: TimelineClip[];
	/** Explicit timeline lanes (mute/solo/lock). Undoable. */
	tracks: TimelineTrack[];
}

export const INITIAL_EDITOR_STATE: EditorState = {
	zoomRegions: [],
	autoZoomEnabled: true,
	autoFocusAll: false,
	trimRegions: [],
	speedRegions: [],
	annotationRegions: [],
	cropRegion: DEFAULT_CROP_REGION,
	wallpaper: DEFAULT_EDITOR_LAYOUT_SETTINGS.wallpaper,
	shadowIntensity: DEFAULT_EDITOR_APPEARANCE_SETTINGS.shadowIntensity,
	showBlur: DEFAULT_EDITOR_APPEARANCE_SETTINGS.showBlur,
	showTrimWaveform: DEFAULT_EDITOR_APPEARANCE_SETTINGS.showTrimWaveform,
	motionBlurAmount: DEFAULT_EDITOR_APPEARANCE_SETTINGS.motionBlurAmount,
	borderRadius: DEFAULT_EDITOR_APPEARANCE_SETTINGS.borderRadius,
	padding: DEFAULT_EDITOR_LAYOUT_SETTINGS.padding,
	aspectRatio: DEFAULT_EDITOR_LAYOUT_SETTINGS.aspectRatio,
	webcamLayoutPreset: DEFAULT_WEBCAM_SETTINGS.layoutPreset,
	webcamMaskShape: DEFAULT_WEBCAM_SETTINGS.maskShape,
	webcamMirrored: DEFAULT_WEBCAM_MIRRORED,
	webcamReactiveZoom: DEFAULT_WEBCAM_REACTIVE_ZOOM,
	webcamSizePreset: DEFAULT_WEBCAM_SETTINGS.sizePreset,
	webcamPosition: DEFAULT_WEBCAM_SETTINGS.position,
	timelineClips: [],
	tracks: DEFAULT_TRACKS,
};

type StateUpdate = Partial<EditorState> | ((prev: EditorState) => Partial<EditorState>);

export interface History {
	past: EditorState[];
	present: EditorState;
	future: EditorState[];
}

const MAX_HISTORY = 80;

/**
 * Apply a partial (or functional) update onto a present state via a generic
 * `{...present, ...partial}` merge. Pure — the single source of truth for how an
 * `EditorState` advances. Exported so the reducer can be unit-tested directly.
 */
export function resolveEditorState(present: EditorState, update: StateUpdate): EditorState {
	const partial = typeof update === "function" ? update(present) : update;
	return { ...present, ...partial };
}

/**
 * Push a new present onto the undo stack: the old present becomes the newest
 * `past` entry (capped at {@link MAX_HISTORY}) and the redo `future` is cleared.
 * Pure.
 */
export function pushHistory(history: History, newPresent: EditorState): History {
	return {
		past: [...history.past.slice(-(MAX_HISTORY - 1)), history.present],
		present: newPresent,
		future: [],
	};
}

/**
 * Replace the present in place WITHOUT touching `past`/`future` — a silent,
 * non-undoable mutation used to reactively seed derived state. Pure.
 */
export function replacePresentHistory(history: History, update: StateUpdate): History {
	return { ...history, present: resolveEditorState(history.present, update) };
}

/** Step back one checkpoint, moving the present onto `future`. Pure (no-op when empty). */
export function undoHistory(history: History): History {
	if (!history.past.length) return history;
	const previous = history.past[history.past.length - 1];
	return {
		past: history.past.slice(0, -1),
		present: previous,
		future: [history.present, ...history.future],
	};
}

/** Step forward one checkpoint, moving the present onto `past`. Pure (no-op when empty). */
export function redoHistory(history: History): History {
	if (!history.future.length) return history;
	const [next, ...remainingFuture] = history.future;
	return { past: [...history.past, history.present], present: next, future: remainingFuture };
}

export function useEditorHistory(initial: EditorState = INITIAL_EDITOR_STATE) {
	const [history, setHistory] = useState<History>({ past: [], present: initial, future: [] });

	// True while a live-update series (e.g. slider drag) is in progress. The first
	// updateState call checkpoints the pre-interaction state.
	const dirtyRef = useRef(false);

	const pushState = useCallback((update: StateUpdate) => {
		setHistory((prev) => pushHistory(prev, resolveEditorState(prev.present, update)));
		dirtyRef.current = false;
	}, []);

	const updateState = useCallback((update: StateUpdate) => {
		const isFirst = !dirtyRef.current;
		dirtyRef.current = true;
		setHistory((prev) => {
			const next = resolveEditorState(prev.present, update);
			return isFirst ? pushHistory(prev, next) : { ...prev, present: next };
		});
	}, []);

	const commitState = useCallback(() => {
		dirtyRef.current = false;
	}, []);

	// Silent present mutation: reactively seed derived state without creating an
	// undo step (does NOT touch past/future).
	const replacePresent = useCallback((update: StateUpdate) => {
		setHistory((prev) => replacePresentHistory(prev, update));
	}, []);

	const undo = useCallback(() => {
		setHistory(undoHistory);
		dirtyRef.current = false;
	}, []);

	const redo = useCallback(() => {
		setHistory(redoHistory);
		dirtyRef.current = false;
	}, []);

	const resetState = useCallback((newInitial: EditorState = INITIAL_EDITOR_STATE) => {
		setHistory({ past: [], present: newInitial, future: [] });
		dirtyRef.current = false;
	}, []);

	return {
		state: history.present,
		pushState,
		updateState,
		commitState,
		replacePresent,
		undo,
		redo,
		resetState,
		canUndo: history.past.length > 0,
		canRedo: history.future.length > 0,
	};
}
