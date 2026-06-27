import { describe, expect, it } from "vitest";
import type { TimelineClip } from "@/components/video-editor/timeline/clipModel";
import {
	makeTrack,
	reindexClipsForRemovedTrack,
	removeTrack,
	type TimelineTrack,
} from "@/components/video-editor/timeline/trackModel";
import {
	type EditorState,
	type History,
	INITIAL_EDITOR_STATE,
	pushHistory,
	redoHistory,
	replacePresentHistory,
	resolveEditorState,
	undoHistory,
} from "./useEditorHistory";

/** A trivial full-span clip on a given lane. */
function clip(id: string, trackIndex: number): TimelineClip {
	return {
		id,
		assetId: "asset",
		name: id,
		sourcePath: `/tmp/${id}.mp4`,
		trackIndex,
		startSec: 0,
		inSec: 0,
		outSec: 1,
	};
}

/** A fresh history rooted at `present` with empty past/future. */
function historyOf(present: EditorState): History {
	return { past: [], present, future: [] };
}

/** INITIAL state with the given clips + tracks layered on. */
function stateWith(timelineClips: TimelineClip[], tracks: TimelineTrack[]): EditorState {
	return { ...INITIAL_EDITOR_STATE, timelineClips, tracks };
}

describe("resolveEditorState", () => {
	it("merges a partial object update onto the present", () => {
		const next = resolveEditorState(INITIAL_EDITOR_STATE, { padding: 99 });
		expect(next.padding).toBe(99);
		// Untouched fields are preserved; a new object is returned.
		expect(next.wallpaper).toBe(INITIAL_EDITOR_STATE.wallpaper);
		expect(next).not.toBe(INITIAL_EDITOR_STATE);
	});

	it("supports a functional updater that reads the present", () => {
		const seeded = stateWith([clip("a", 0)], INITIAL_EDITOR_STATE.tracks);
		const next = resolveEditorState(seeded, (prev) => ({
			timelineClips: [...prev.timelineClips, clip("b", 0)],
		}));
		expect(next.timelineClips.map((c) => c.id)).toEqual(["a", "b"]);
	});
});

describe("pushHistory", () => {
	it("checkpoints the old present and clears redo (future)", () => {
		const start = historyOf(INITIAL_EDITOR_STATE);
		const withRedo: History = {
			...start,
			future: [resolveEditorState(start.present, { padding: 1 })],
		};
		const next = pushHistory(withRedo, resolveEditorState(withRedo.present, { padding: 2 }));
		expect(next.past).toHaveLength(1);
		expect(next.past[0]).toBe(INITIAL_EDITOR_STATE);
		expect(next.present.padding).toBe(2);
		// Pushing a new edit invalidates the redo stack.
		expect(next.future).toEqual([]);
	});
});

describe("undo/redo over a removed track", () => {
	it("restores a removed track AND its clips together in ONE undo step", () => {
		const tracks = [makeTrack(0), makeTrack(1), makeTrack(2)];
		const clips = [clip("keep", 0), clip("gone", 1), clip("shift", 2)];
		const before = stateWith(clips, tracks);
		const history = historyOf(before);

		// Remove lane 1: drops its clip and re-indexes lanes/clips above it — one entry.
		const afterPresent = resolveEditorState(before, {
			tracks: removeTrack(tracks, 1),
			timelineClips: reindexClipsForRemovedTrack(clips, 1),
		});
		const removed = pushHistory(history, afterPresent);

		expect(removed.present.tracks).toHaveLength(2);
		expect(removed.present.timelineClips.map((c) => c.id)).toEqual(["keep", "shift"]);
		// The clip that lived above the removed lane shifted down to index 1.
		expect(removed.present.timelineClips.find((c) => c.id === "shift")?.trackIndex).toBe(1);

		// A single undo brings BOTH the track and its clips back atomically.
		const undone = undoHistory(removed);
		expect(undone.present).toBe(before);
		expect(undone.present.tracks).toHaveLength(3);
		expect(undone.present.timelineClips.map((c) => c.id)).toEqual(["keep", "gone", "shift"]);

		// Redo re-applies the same atomic removal.
		const redone = redoHistory(undone);
		expect(redone.present.tracks).toHaveLength(2);
		expect(redone.present.timelineClips.map((c) => c.id)).toEqual(["keep", "shift"]);
	});
});

describe("undo/redo edge cases", () => {
	it("undoHistory is a no-op on an empty past", () => {
		const history = historyOf(INITIAL_EDITOR_STATE);
		expect(undoHistory(history)).toBe(history);
	});

	it("redoHistory is a no-op on an empty future", () => {
		const history = historyOf(INITIAL_EDITOR_STATE);
		expect(redoHistory(history)).toBe(history);
	});
});

describe("replacePresentHistory", () => {
	it("mutates the present WITHOUT touching past/future", () => {
		const past = [stateWith([clip("old", 0)], INITIAL_EDITOR_STATE.tracks)];
		const future = [stateWith([clip("fut", 0)], INITIAL_EDITOR_STATE.tracks)];
		const history: History = { past, present: INITIAL_EDITOR_STATE, future };

		const seeded = replacePresentHistory(history, { timelineClips: [clip("seed", 0)] });
		expect(seeded.present.timelineClips.map((c) => c.id)).toEqual(["seed"]);
		// The silent seed leaves the undo/redo stacks completely untouched.
		expect(seeded.past).toBe(past);
		expect(seeded.future).toBe(future);
	});
});

describe("clip edits and region/setting edits share one stack independently", () => {
	it("a region edit undoes without disturbing already-committed clip edits", () => {
		const seeded = stateWith([clip("a", 0)], INITIAL_EDITOR_STATE.tracks);
		let history = historyOf(seeded);

		// Commit a clip edit, then a region (padding) edit — two checkpoints.
		history = pushHistory(
			history,
			resolveEditorState(history.present, { timelineClips: [clip("a", 0), clip("b", 0)] }),
		);
		history = pushHistory(history, resolveEditorState(history.present, { padding: 42 }));
		expect(history.past).toHaveLength(2);

		// Undo the region edit: padding reverts but the clip edit stays applied.
		const undone = undoHistory(history);
		expect(undone.present.padding).toBe(INITIAL_EDITOR_STATE.padding);
		expect(undone.present.timelineClips.map((c) => c.id)).toEqual(["a", "b"]);
	});
});
