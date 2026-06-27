import { describe, expect, it } from "vitest";
import {
	clipAtTime,
	clipDuration,
	clipEndSec,
	clipsTotalDuration,
	duplicateClip,
	gainAt,
	MIN_CLIP_LENGTH,
	nextClipStart,
	nudgeClip,
	offsetClips,
	pasteClipsAt,
	rippleDeleteClip,
	splitClipAt,
	type TimelineClip,
	trackEndSec,
} from "./clipModel";

function clip(over: Partial<TimelineClip> = {}): TimelineClip {
	return {
		id: "c1",
		assetId: "a1",
		name: "x.mp4",
		sourcePath: "/x.mp4",
		trackIndex: 0,
		startSec: 0,
		inSec: 0,
		outSec: 5,
		...over,
	};
}

describe("clipDuration / clipEndSec", () => {
	it("duration = outSec - inSec", () => {
		expect(clipDuration(clip({ inSec: 2, outSec: 6 }))).toBe(4);
	});
	it("clamps a negative window to 0", () => {
		expect(clipDuration(clip({ inSec: 6, outSec: 2 }))).toBe(0);
	});
	it("end = startSec + duration (timeline position, not source)", () => {
		expect(clipEndSec(clip({ startSec: 10, inSec: 1, outSec: 4 }))).toBe(13);
	});
});

describe("trackEndSec / clipsTotalDuration", () => {
	const clips = [
		clip({ id: "a", trackIndex: 0, startSec: 0, inSec: 0, outSec: 3 }), // ends 3 on t0
		clip({ id: "b", trackIndex: 0, startSec: 5, inSec: 0, outSec: 2 }), // ends 7 on t0
		clip({ id: "c", trackIndex: 1, startSec: 0, inSec: 0, outSec: 10 }), // ends 10 on t1
	];
	it("trackEndSec is the rightmost edge on that track only", () => {
		expect(trackEndSec(clips, 0)).toBe(7);
		expect(trackEndSec(clips, 1)).toBe(10);
		expect(trackEndSec(clips, 2)).toBe(0); // empty lane
	});
	it("clipsTotalDuration is the rightmost edge across all tracks", () => {
		expect(clipsTotalDuration(clips)).toBe(10);
		expect(clipsTotalDuration([])).toBe(0);
	});
});

describe("clipAtTime", () => {
	// Two contiguous clips on V1, plus an overlapping clip on V2.
	const a = clip({ id: "a", trackIndex: 0, startSec: 0, inSec: 0, outSec: 4 }); // [0,4)
	const b = clip({ id: "b", trackIndex: 0, startSec: 6, inSec: 0, outSec: 3 }); // [6,9)
	const v2 = clip({ id: "v2", trackIndex: 1, startSec: 2, inSec: 0, outSec: 5 }); // [2,7)
	const audio = clip({ id: "au", trackIndex: 2, startSec: 0, inSec: 0, outSec: 100 });
	const clips = [a, b, v2, audio];

	it("returns the clip whose half-open span contains the time", () => {
		expect(clipAtTime(clips, 1)?.id).toBe("a");
		expect(clipAtTime(clips, 6.5)?.id).toBe("b");
	});
	it("topmost video track wins on overlap (trackIndex 0 over 1)", () => {
		// t=3 is inside both a ([0,4) on V1) and v2 ([2,7) on V2) → V1 wins.
		expect(clipAtTime(clips, 3)?.id).toBe("a");
		// t=5 is only inside v2 (a has ended) → V2.
		expect(clipAtTime(clips, 5)?.id).toBe("v2");
	});
	it("ignores audio-track clips", () => {
		// t=10 is only under the audio clip → no video clip.
		expect(clipAtTime(clips, 10)).toBeNull();
	});
	it("returns null in a gap", () => {
		// gap on V1 between [4,6); v2 ends at 7, so 5.5 is still v2 — use a real gap.
		expect(clipAtTime([a, b], 5)).toBeNull();
	});
	it("the end boundary is exclusive (start is inclusive)", () => {
		expect(clipAtTime([a], 0)?.id).toBe("a"); // exact start → this clip
		expect(clipAtTime([a], 4)).toBeNull(); // exact end → not this clip
		// At a contiguous seam the next clip owns the boundary.
		const seam = clip({ id: "seam", trackIndex: 0, startSec: 4, inSec: 0, outSec: 2 });
		expect(clipAtTime([a, seam], 4)?.id).toBe("seam");
	});
	it("returns null for an empty timeline", () => {
		expect(clipAtTime([], 0)).toBeNull();
	});
});

describe("nextClipStart", () => {
	const a = clip({ id: "a", trackIndex: 0, startSec: 0, inSec: 0, outSec: 4 });
	const b = clip({ id: "b", trackIndex: 0, startSec: 6, inSec: 0, outSec: 3 });
	const v2 = clip({ id: "v2", trackIndex: 1, startSec: 2, inSec: 0, outSec: 5 });
	const audio = clip({ id: "au", trackIndex: 2, startSec: 12, inSec: 0, outSec: 1 });
	const clips = [a, b, v2, audio];

	it("is the smallest video-clip start strictly greater than t", () => {
		expect(nextClipStart(clips, 0)).toBe(2); // v2 starts at 2
		expect(nextClipStart(clips, 2)).toBe(6); // strictly greater → skips v2 itself
		expect(nextClipStart(clips, 5)).toBe(6);
	});
	it("ignores audio tracks and returns null past the last video clip", () => {
		expect(nextClipStart(clips, 6)).toBeNull(); // audio at 12 is not counted
		expect(nextClipStart([], 0)).toBeNull();
	});
});

describe("splitClipAt", () => {
	// timeline span [10,16], source window [2,8] (dur 6)
	const base = clip({ startSec: 10, inSec: 2, outSec: 8 });

	it("divides both the timeline span and the source window at the cut", () => {
		const res = splitClipAt(base, 13, () => "right-id"); // offset 3
		if (res === null) throw new Error("expected a split");
		const [l, r] = res;
		// left keeps the head, right takes the tail
		expect(l.startSec).toBe(10);
		expect(l.inSec).toBe(2);
		expect(l.outSec).toBe(5); // inSec + offset
		expect(r.id).toBe("right-id");
		expect(r.startSec).toBe(13);
		expect(r.inSec).toBe(5);
		expect(r.outSec).toBe(8);
		// halves are contiguous and conserve the original duration
		expect(clipEndSec(l)).toBe(r.startSec);
		expect(clipDuration(l) + clipDuration(r)).toBeCloseTo(clipDuration(base), 10);
	});

	it("rejects a cut too close to the left edge (< MIN_CLIP_LENGTH)", () => {
		expect(splitClipAt(base, 10 + MIN_CLIP_LENGTH / 2)).toBeNull();
	});
	it("rejects a cut too close to the right edge", () => {
		expect(splitClipAt(base, 16 - MIN_CLIP_LENGTH / 2)).toBeNull();
	});
	it("rejects a cut outside the clip span", () => {
		expect(splitClipAt(base, 5)).toBeNull();
		expect(splitClipAt(base, 20)).toBeNull();
	});
});

describe("duplicateClip", () => {
	// timeline span [10,16], source window [2,8] on track 1
	const base = clip({ id: "orig", trackIndex: 1, startSec: 10, inSec: 2, outSec: 8 });

	it("places the copy immediately after the original on the same track", () => {
		const dup = duplicateClip(base, () => "dup-id");
		expect(dup.id).toBe("dup-id");
		expect(dup.startSec).toBe(clipEndSec(base)); // 16
		expect(dup.trackIndex).toBe(1);
		// source window + audio carried over unchanged
		expect(dup.inSec).toBe(2);
		expect(dup.outSec).toBe(8);
		expect(clipDuration(dup)).toBe(clipDuration(base));
	});

	it("preserves audio fields and only the id + startSec differ", () => {
		const withAudio = clip({ volume: 0.5, muted: true, fadeInSec: 1, fadeOutSec: 2 });
		const dup = duplicateClip(withAudio, () => "x");
		expect(dup.volume).toBe(0.5);
		expect(dup.muted).toBe(true);
		expect(dup.fadeInSec).toBe(1);
		expect(dup.fadeOutSec).toBe(2);
		expect(dup).toMatchObject({ ...withAudio, id: "x", startSec: clipEndSec(withAudio) });
	});

	it("uses an injected makeId for deterministic ids", () => {
		expect(duplicateClip(base, () => "fixed").id).toBe("fixed");
	});
});

describe("nudgeClip", () => {
	const base = clip({ startSec: 5 });

	it("shifts startSec by the (signed) delta", () => {
		expect(nudgeClip(base, 1.5).startSec).toBe(6.5);
		expect(nudgeClip(base, -2).startSec).toBe(3);
	});
	it("clamps the left edge at 0", () => {
		expect(nudgeClip(base, -100).startSec).toBe(0);
	});
	it("leaves every other field untouched", () => {
		expect(nudgeClip(base, 1)).toMatchObject({ ...base, startSec: 6 });
	});
});

describe("offsetClips", () => {
	const clips = [
		clip({ id: "a", startSec: 4, inSec: 0, outSec: 2 }),
		clip({ id: "b", startSec: 9, inSec: 0, outSec: 3 }),
	];

	it("returns [] for an empty set", () => {
		expect(offsetClips([], 5, () => "x")).toEqual([]);
	});

	it("shifts every clip and preserves relative offsets", () => {
		let n = 0;
		const out = offsetClips(clips, 3, () => `id-${++n}`);
		expect(out.map((c) => c.startSec)).toEqual([7, 12]); // +3 each
		// relative gap (5s) is preserved
		expect(out[1].startSec - out[0].startSec).toBe(9 - 4);
	});

	it("mints fresh deterministic ids from makeId", () => {
		let n = 0;
		const out = offsetClips(clips, 0, () => `id-${++n}`);
		expect(out.map((c) => c.id)).toEqual(["id-1", "id-2"]);
	});

	it("clamps so the earliest clip never goes below 0, moving the whole set together", () => {
		// earliest is at 4; a -10 shift would push it to -6, so clamp to -4.
		const out = offsetClips(clips, -10, () => "x");
		expect(out[0].startSec).toBe(0); // 4 - 4
		expect(out[1].startSec).toBe(5); // 9 - 4 — relative gap intact
	});
});

describe("pasteClipsAt", () => {
	const clipboard = [
		clip({ id: "a", startSec: 4, inSec: 0, outSec: 2 }),
		clip({ id: "b", startSec: 9, inSec: 0, outSec: 3 }),
	];

	it("returns [] for an empty clipboard", () => {
		expect(pasteClipsAt([], 10, () => "x")).toEqual([]);
	});

	it("lands the earliest clip at atSec, preserving relative offsets + fresh ids", () => {
		let n = 0;
		const out = pasteClipsAt(clipboard, 20, () => `p-${++n}`);
		expect(out[0].startSec).toBe(20); // earliest (was 4) → atSec
		expect(out[1].startSec).toBe(25); // kept its +5 gap
		expect(out.map((c) => c.id)).toEqual(["p-1", "p-2"]);
	});

	it("clamps a paste at 0 (or negative) so nothing goes below 0", () => {
		const out = pasteClipsAt(clipboard, 0, () => "x");
		expect(out[0].startSec).toBe(0);
		expect(out[1].startSec).toBe(5);
	});
});

describe("rippleDeleteClip", () => {
	const clips = [
		clip({ id: "a", trackIndex: 0, startSec: 0, inSec: 0, outSec: 3 }), // [0,3)
		clip({ id: "b", trackIndex: 0, startSec: 3, inSec: 0, outSec: 4 }), // [3,7) — to delete (dur 4)
		clip({ id: "c", trackIndex: 0, startSec: 8, inSec: 0, outSec: 2 }), // [8,10)
		clip({ id: "d", trackIndex: 1, startSec: 9, inSec: 0, outSec: 2 }), // other track
	];

	it("removes the clip and shifts later same-track clips left by its duration", () => {
		const out = rippleDeleteClip(clips, "b");
		expect(out.map((c) => c.id)).toEqual(["a", "c", "d"]);
		expect(out.find((c) => c.id === "a")?.startSec).toBe(0); // before the cut — unchanged
		expect(out.find((c) => c.id === "c")?.startSec).toBe(4); // 8 - 4
		expect(out.find((c) => c.id === "d")?.startSec).toBe(9); // other track — unchanged
	});

	it("returns the input unchanged when the id is missing", () => {
		expect(rippleDeleteClip(clips, "nope")).toBe(clips);
	});

	it("clamps shifted starts at 0", () => {
		const two = [
			clip({ id: "x", trackIndex: 0, startSec: 0, inSec: 0, outSec: 5 }), // dur 5
			clip({ id: "y", trackIndex: 0, startSec: 2, inSec: 0, outSec: 1 }), // overlaps; start < cutEnd → untouched
		];
		// y.startSec (2) < clipEndSec(x)=5, so y is not "after" → left as-is, only x removed.
		const out = rippleDeleteClip(two, "x");
		expect(out).toEqual([two[1]]);
	});
});

describe("gainAt", () => {
	// timeline span [10,20] (dur 10)
	const base = clip({ startSec: 10, inSec: 0, outSec: 10 });

	it("returns 0 outside the clip span (both edges exclusive at the tail)", () => {
		expect(gainAt(base, 9.999)).toBe(0);
		expect(gainAt(base, 20)).toBe(0); // right edge is exclusive
		expect(gainAt(base, 25)).toBe(0);
	});

	it("muted is always 0, even mid-clip with volume + fades", () => {
		expect(gainAt({ ...base, muted: true, volume: 1, fadeInSec: 2, fadeOutSec: 2 }, 15)).toBe(0);
	});

	it("plays the clip volume flat in the middle (default 1)", () => {
		expect(gainAt(base, 15)).toBe(1);
		expect(gainAt({ ...base, volume: 0.5 }, 15)).toBe(0.5);
	});

	it("ramps 0→volume across the fade-in head", () => {
		const c = { ...base, volume: 1, fadeInSec: 4 };
		expect(gainAt(c, 10)).toBe(0); // exact start
		expect(gainAt(c, 11)).toBeCloseTo(0.25, 10);
		expect(gainAt(c, 12)).toBeCloseTo(0.5, 10);
		expect(gainAt(c, 14)).toBeCloseTo(1, 10); // fade-in done
		// fade-in scales the clip volume too
		expect(gainAt({ ...c, volume: 0.5 }, 12)).toBeCloseTo(0.25, 10);
	});

	it("ramps volume→0 across the fade-out tail", () => {
		const c = { ...base, volume: 1, fadeOutSec: 4 };
		expect(gainAt(c, 16)).toBeCloseTo(1, 10); // just before fade-out
		expect(gainAt(c, 18)).toBeCloseTo(0.5, 10);
		expect(gainAt(c, 19)).toBeCloseTo(0.25, 10);
	});

	it("clamps each fade to half the clip duration so they never overlap", () => {
		// dur 10 → half is 5; ask for 8s fades, both clamp to 5s and meet at the middle.
		const c = { ...base, volume: 1, fadeInSec: 8, fadeOutSec: 8 };
		expect(gainAt(c, 12.5)).toBeCloseTo(0.5, 10); // halfway up the (clamped) 5s fade-in
		expect(gainAt(c, 15)).toBeCloseTo(1, 10); // they meet at full gain at the midpoint
		expect(gainAt(c, 17.5)).toBeCloseTo(0.5, 10); // halfway down the 5s fade-out
	});
});
