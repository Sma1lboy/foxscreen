import { describe, expect, it } from "vitest";
import type { TimelineClip } from "./clipModel";
import {
	addTrack,
	defaultTracksForClips,
	effectiveClipGain,
	isTrackAudible,
	isTrackLocked,
	makeTrack,
	reindexClipsForRemovedTrack,
	removeTrack,
	type TimelineTrack,
	toggleLocked,
	toggleMuted,
	toggleSolo,
	trackAtIndex,
	trackKindForIndex,
} from "./trackModel";

/** A full-volume clip spanning [start, start+len) on a lane. */
function clip(trackIndex: number, opts: Partial<TimelineClip> = {}): TimelineClip {
	return {
		id: `c${trackIndex}-${opts.startSec ?? 0}`,
		assetId: "a",
		name: "clip",
		sourcePath: "/tmp/x.mp4",
		trackIndex,
		startSec: 0,
		inSec: 0,
		outSec: 5,
		...opts,
	};
}

function tracks(...flags: Partial<TimelineTrack>[]): TimelineTrack[] {
	return flags.map((f, i) => ({ ...makeTrack(i), ...f, index: i }));
}

describe("trackKindForIndex", () => {
	it("treats lane 2 as audio, others as video", () => {
		expect(trackKindForIndex(0)).toBe("video");
		expect(trackKindForIndex(1)).toBe("video");
		expect(trackKindForIndex(2)).toBe("audio");
		expect(trackKindForIndex(3)).toBe("video");
	});
});

describe("makeTrack", () => {
	it("builds an all-flags-false track with a derived name + kind", () => {
		expect(makeTrack(0)).toEqual({
			index: 0,
			name: "Track 1",
			kind: "video",
			muted: false,
			locked: false,
			solo: false,
		});
		expect(makeTrack(2).kind).toBe("audio");
	});
});

describe("defaultTracksForClips", () => {
	it("returns a single lane for no clips (min 1)", () => {
		const result = defaultTracksForClips([]);
		expect(result).toHaveLength(1);
		expect(result[0].index).toBe(0);
	});

	it("covers every lane index up to the highest clip, contiguously", () => {
		const result = defaultTracksForClips([clip(0), clip(2)]);
		expect(result.map((t) => t.index)).toEqual([0, 1, 2]);
		expect(result[2].kind).toBe("audio");
	});

	it("defaults all flags to false", () => {
		for (const t of defaultTracksForClips([clip(1)])) {
			expect(t.muted).toBe(false);
			expect(t.locked).toBe(false);
			expect(t.solo).toBe(false);
		}
	});
});

describe("isTrackAudible", () => {
	it("is audible by default", () => {
		const ts = tracks({}, {});
		expect(isTrackAudible(ts[0], ts)).toBe(true);
	});

	it("is silent when muted (and nothing soloed)", () => {
		const ts = tracks({ muted: true }, {});
		expect(isTrackAudible(ts[0], ts)).toBe(false);
		expect(isTrackAudible(ts[1], ts)).toBe(true);
	});

	it("solo takes precedence: only soloed lanes are audible", () => {
		const ts = tracks({ solo: true }, {}, { muted: true });
		expect(isTrackAudible(ts[0], ts)).toBe(true); // soloed
		expect(isTrackAudible(ts[1], ts)).toBe(false); // not soloed
		expect(isTrackAudible(ts[2], ts)).toBe(false); // not soloed (mute irrelevant)
	});

	it("a soloed-but-muted lane is still silent under its own solo gate? no — solo wins", () => {
		// A lane that is both soloed and muted: solo gate makes it audible.
		const ts = tracks({ solo: true, muted: true }, {});
		expect(isTrackAudible(ts[0], ts)).toBe(true);
		expect(isTrackAudible(ts[1], ts)).toBe(false);
	});

	it("treats a null track as audible unless something is soloed", () => {
		expect(isTrackAudible(null, tracks({}, {}))).toBe(true);
		expect(isTrackAudible(null, tracks({ solo: true }, {}))).toBe(false);
	});
});

describe("effectiveClipGain", () => {
	it("equals the clip gain when the lane is audible", () => {
		const ts = tracks({});
		const c = clip(0, { volume: 0.5 });
		expect(effectiveClipGain(c, ts[0], ts, 1)).toBeCloseTo(0.5);
	});

	it("is 0 when the lane is muted", () => {
		const ts = tracks({ muted: true });
		expect(effectiveClipGain(clip(0), ts[0], ts, 1)).toBe(0);
	});

	it("is 0 for a non-soloed lane when another lane is soloed", () => {
		const ts = tracks({ solo: true }, {});
		expect(effectiveClipGain(clip(1), ts[1], ts, 1)).toBe(0);
		expect(effectiveClipGain(clip(0), ts[0], ts, 1)).toBeCloseTo(1);
	});

	it("falls back to clip gain when the track is null", () => {
		expect(effectiveClipGain(clip(0), null, [], 1)).toBeCloseTo(1);
	});
});

describe("isTrackLocked / trackAtIndex", () => {
	it("looks up the locked flag, false when missing", () => {
		const ts = tracks({}, { locked: true });
		expect(isTrackLocked(ts, 0)).toBe(false);
		expect(isTrackLocked(ts, 1)).toBe(true);
		expect(isTrackLocked(ts, 9)).toBe(false);
	});

	it("trackAtIndex returns null when absent", () => {
		expect(trackAtIndex(tracks({}), 5)).toBeNull();
	});
});

describe("addTrack", () => {
	it("appends a fresh lane after the last index", () => {
		const ts = addTrack(tracks({}, {}));
		expect(ts).toHaveLength(3);
		expect(ts[2]).toEqual(makeTrack(2));
	});
});

describe("removeTrack + reindexClipsForRemovedTrack", () => {
	it("removes a lane and re-indexes the lanes above it, keeping flags", () => {
		const ts = tracks({}, { locked: true }, { muted: true });
		const result = removeTrack(ts, 1);
		expect(result.map((t) => t.index)).toEqual([0, 1]);
		// The old lane 2 (muted) shifts down to index 1, keeping its mute.
		expect(result[1].muted).toBe(true);
		expect(result[1].name).toBe("Track 2");
		expect(result[1].kind).toBe("video");
	});

	it("never drops below one lane", () => {
		const ts = tracks({});
		expect(removeTrack(ts, 0)).toBe(ts);
	});

	it("drops clips on the removed lane and shifts higher clips down", () => {
		const clips = [clip(0), clip(1, { startSec: 2 }), clip(2, { startSec: 3 })];
		const result = reindexClipsForRemovedTrack(clips, 1);
		expect(result).toHaveLength(2);
		expect(result.map((c) => c.trackIndex)).toEqual([0, 1]);
	});
});

describe("toggle helpers", () => {
	it("toggleMuted/Locked/Solo flip only the targeted lane, purely", () => {
		const ts = tracks({}, {});
		const muted = toggleMuted(ts, 1);
		expect(muted[1].muted).toBe(true);
		expect(muted[0].muted).toBe(false);
		expect(ts[1].muted).toBe(false); // original untouched

		expect(toggleLocked(ts, 0)[0].locked).toBe(true);
		expect(toggleSolo(ts, 0)[0].solo).toBe(true);
	});
});
