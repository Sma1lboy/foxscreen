import { readFileSync } from "node:fs";
import type { CuttiProject } from "@foxscreen/cutti-core";
import { describe, expect, it } from "vitest";
import { buildComposedTimeline, cuttiProjectToEditorState, cuttiToRegions } from "../adapter";

/**
 * End-to-end data-path check against a REAL cutti daemon project.json
 * (examples/sample-project.json), proving the daemon's output flows into
 * openscreen's EditorState. vitest runs with cwd = project root.
 */
const sample = JSON.parse(readFileSync("examples/sample-project.json", "utf8")) as CuttiProject;

describe("sample-project.json → openscreen", () => {
	it("converts the 4-segment sample into trim/caption regions", () => {
		const r = cuttiToRegions(sample);
		// 4 kept segments → 4 trim regions
		expect(r.trimRegions).toHaveLength(4);
		// all 1x → no speed regions
		expect(r.speedRegions).toHaveLength(0);
		// seg-1 carries 2 subtitles → 2 caption annotations
		expect(r.annotationRegions).toHaveLength(2);
		expect(r.annotationRegions[0]?.textContent).toContain("今天聊聊");
		expect(r.annotationRegions.every((a) => a.annotationSource === "auto-caption")).toBe(true);
	});

	it("produces a valid openscreen EditorState", () => {
		const state = cuttiProjectToEditorState(sample);
		expect(state.trimRegions).toHaveLength(4);
		expect(state.cropRegion).toEqual({ x: 0, y: 0, width: 1, height: 1 });
	});

	it("composes to 24s (0..6,6..9,9..18,18..24 all 1x)", () => {
		const tl = buildComposedTimeline(sample);
		expect(tl.totalComposedMs).toBe(24000);
		// composed 8s falls in seg-2 [6..9] → source 8s (1x, contiguous)
		expect(tl.composedToSource(8000)).toEqual({ sourceVideoID: "src-A", sourceMs: 8000 });
	});
});
