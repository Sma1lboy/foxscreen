import { applyActionBatch, makeTimelineSegment, makeTimeRange } from "@foxscreen/cutti-core";
import { describe, expect, it } from "vitest";
import { runCuttiDemoEdit } from "../integration";

/**
 * Proves the cutti executor is actually PORTED INTO openscreen's source tree and
 * runs here (browser-safe — no node:crypto). The exhaustive executor parity
 * suite lives in daemon/; this is the in-openscreen smoke + the real-edit seam.
 */
describe("ported cutti engine runs in openscreen", () => {
	it("applyActionBatch executes in-tree (web-crypto UUID, no node deps)", () => {
		const seg = makeTimelineSegment({
			id: "a",
			sourceVideoID: "S",
			range: makeTimeRange(0, 10),
			text: "",
			subtitles: [],
		});
		const r = applyActionBatch(
			{ explanation: "t", actions: [{ type: "setSpeed", id: "a", rate: 2 }] },
			[seg],
		);
		expect(r.appliedCount).toBe(1);
		expect(r.segments[0]?.speedRate).toBe(2);
	});

	it("runCuttiDemoEdit drives the REAL executor end-to-end (delete + setSpeed)", () => {
		const out = runCuttiDemoEdit();
		// deleteSegment(filler) + setSpeed(2x) both apply
		expect(out.applied).toBe(2);
		// filler dropped → 3 kept segments → 3 trim regions
		expect(out.regions.trimRegions).toHaveLength(3);
		// the executor's setSpeed produced a speed region (not pre-baked)
		expect(out.regions.speedRegions.length).toBeGreaterThanOrEqual(1);
		// captions survive on the kept segments
		expect(out.regions.annotationRegions.length).toBeGreaterThan(0);
	});
});
