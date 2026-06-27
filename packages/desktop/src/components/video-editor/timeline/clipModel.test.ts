import { describe, expect, it } from "vitest";
import {
	clipAtTime,
	clipDuration,
	clipEndSec,
	clipsTotalDuration,
	MIN_CLIP_LENGTH,
	nextClipStart,
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
