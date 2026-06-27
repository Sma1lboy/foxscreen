import { describe, expect, it } from "vitest";
import type { TrimRegion } from "@/components/video-editor/types";
import { decidePlayback, keptSpansFromTrim } from "../playback";

function trim(spans: Array<[number, number]>): TrimRegion[] {
	return spans.map(([a, b], i) => ({ id: `t${i}`, startMs: a * 1000, endMs: b * 1000 }));
}

describe("keptSpansFromTrim", () => {
	it("converts ms→s, drops degenerate, sorts", () => {
		const spans = keptSpansFromTrim(
			trim([
				[9, 18],
				[0, 6],
				[3, 3],
			]),
		);
		expect(spans).toEqual([
			{ startSec: 0, endSec: 6 },
			{ startSec: 9, endSec: 18 },
		]);
	});
});

describe("decidePlayback", () => {
	// kept [0,6] and [9,18]; 6..9 is cut.
	const spans = keptSpansFromTrim(
		trim([
			[0, 6],
			[9, 18],
		]),
	);

	it("no trim => always play (openscreen default untouched)", () => {
		expect(decidePlayback(3, [])).toEqual({ kind: "play" });
	});

	it("inside a kept span => play", () => {
		expect(decidePlayback(3, spans)).toEqual({ kind: "play" });
		expect(decidePlayback(12, spans)).toEqual({ kind: "play" });
		expect(decidePlayback(5.99, spans)).toEqual({ kind: "play" }); // near end, still inside
	});

	it("entering the cut gap => seek to next kept span", () => {
		expect(decidePlayback(6.0, spans)).toEqual({ kind: "seek", toSec: 9 });
		expect(decidePlayback(7.5, spans)).toEqual({ kind: "seek", toSec: 9 });
	});

	it("before the first kept span => seek to it", () => {
		const s2 = keptSpansFromTrim(trim([[2, 6]]));
		expect(decidePlayback(0, s2)).toEqual({ kind: "seek", toSec: 2 });
	});

	it("past the last kept span => end", () => {
		expect(decidePlayback(18, spans)).toEqual({ kind: "end" });
		expect(decidePlayback(20, spans)).toEqual({ kind: "end" });
	});

	it("contiguous kept spans never seek at the seam", () => {
		const contig = keptSpansFromTrim(
			trim([
				[0, 6],
				[6, 9],
			]),
		);
		expect(decidePlayback(6.0, contig)).toEqual({ kind: "play" });
	});

	it("a just-landed seek counts as inside (start eps)", () => {
		expect(decidePlayback(8.99, spans)).toEqual({ kind: "play" }); // landed ~9
	});
});
