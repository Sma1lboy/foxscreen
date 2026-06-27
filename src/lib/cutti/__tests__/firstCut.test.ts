import type { CaptionSegment } from "@foxscreen/cutti-core";
import { describe, expect, it } from "vitest";
import { captionsToSegments, heuristicCutBatch, transcriptToFirstCut } from "../firstCut";

const transcript: CaptionSegment[] = [
	{ startSec: 0, endSec: 3, text: "今天聊聊 agent 驱动的剪辑" },
	{ startSec: 3, endSec: 3.2, text: "呃" }, // filler -> cut
	{ startSec: 3.2, endSec: 7, text: "核心是 project.json 当真相源" },
	{ startSec: 7, endSec: 7.5, text: "um" }, // filler -> cut
	{ startSec: 7.5, endSec: 7.6, text: "ok" }, // too short (<0.35) -> cut
];

describe("transcript → real keep/cut", () => {
	it("each phrase becomes a segment carrying its subtitle", () => {
		const segs = captionsToSegments(transcript, "S");
		expect(segs).toHaveLength(5);
		expect(segs[0]?.text).toBe("今天聊聊 agent 驱动的剪辑");
		expect(segs[0]?.subtitles[0]?.text).toBe("今天聊聊 agent 驱动的剪辑");
		expect(segs[0]?.range.endSeconds).toBe(3);
	});

	it("heuristic cuts filler + ultra-short phrases", () => {
		const batch = heuristicCutBatch(captionsToSegments(transcript, "S"));
		// 呃, um, ok(too short) -> 3 deletes
		expect(batch.actions).toHaveLength(3);
		expect(batch.actions.every((a) => a.type === "deleteSegment")).toBe(true);
	});

	it("runs the REAL executor: drops fillers, keeps 2 content phrases as regions", () => {
		const out = transcriptToFirstCut(transcript, "S");
		expect(out.total).toBe(5);
		expect(out.applied).toBe(3); // three deletes applied
		expect(out.regions.trimRegions).toHaveLength(2); // two kept phrases
		expect(out.regions.annotationRegions).toHaveLength(2); // their captions
		expect(out.regions.annotationRegions.map((a) => a.textContent)).toEqual([
			"今天聊聊 agent 驱动的剪辑",
			"核心是 project.json 当真相源",
		]);
	});

	it("a custom decider (e.g. future LLM batch) is honored", () => {
		const out = transcriptToFirstCut(transcript, "S", (segs) => ({
			explanation: "keep all",
			actions: [],
		}));
		expect(out.applied).toBe(0);
		expect(out.regions.trimRegions).toHaveLength(5);
	});
});
