import { describe, expect, it } from "vitest";
import {
	clipDuration,
	clipEndSec,
	clipsTotalDuration,
	MIN_CLIP_LENGTH,
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
