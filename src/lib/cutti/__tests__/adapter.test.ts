import type { CuttiProject } from "@foxscreen/cutti-core";
import { describe, expect, it } from "vitest";
import { buildComposedTimeline, cuttiProjectToEditorState, cuttiToRegions } from "../adapter";

function project(segments: CuttiProject["tracks"][number]["segments"]): CuttiProject {
	return { version: 1, tracks: [{ kind: "video", segments }] };
}

describe("cuttiToRegions", () => {
	it("maps segments to trim/speed/caption regions in source-ms", () => {
		const p = project([
			{
				id: "s1",
				sourceVideoID: "A",
				startSeconds: 0,
				endSeconds: 6,
				text: "hello",
				speedRate: 1,
				subtitles: [{ relativeStart: 0, relativeDuration: 3, text: "hi" }],
			},
			{ id: "s2", sourceVideoID: "A", startSeconds: 9, endSeconds: 18, text: "fast", speedRate: 2 },
		]);
		const r = cuttiToRegions(p);

		expect(r.trimRegions).toEqual([
			{ id: "trim-s1", startMs: 0, endMs: 6000 },
			{ id: "trim-s2", startMs: 9000, endMs: 18000 },
		]);
		// only the 2x segment yields a speed region
		expect(r.speedRegions).toHaveLength(1);
		expect(r.speedRegions[0]).toMatchObject({
			id: "speed-s2",
			startMs: 9000,
			endMs: 18000,
			speed: 2,
		});
		// subtitle placed at ABSOLUTE source time (segStart + relativeStart)
		expect(r.annotationRegions).toHaveLength(1);
		expect(r.annotationRegions[0]).toMatchObject({
			id: "sub-s1-0",
			startMs: 0,
			endMs: 3000,
			type: "text",
			textContent: "hi",
			annotationSource: "auto-caption",
		});
	});

	it("places a subtitle on a later segment at the right absolute time", () => {
		const p = project([
			{
				id: "s2",
				sourceVideoID: "A",
				startSeconds: 9,
				endSeconds: 18,
				text: "core",
				speedRate: 1,
				subtitles: [{ relativeStart: 1, relativeDuration: 2, text: "x" }],
			},
		]);
		const r = cuttiToRegions(p);
		// 9s + 1s = 10s ... 12s
		expect(r.annotationRegions[0]).toMatchObject({ startMs: 10000, endMs: 12000 });
	});
});

describe("buildComposedTimeline", () => {
	const p = project([
		{ id: "s1", sourceVideoID: "A", startSeconds: 0, endSeconds: 10, text: "", speedRate: 1 },
		{ id: "s2", sourceVideoID: "A", startSeconds: 10, endSeconds: 20, text: "", speedRate: 2 },
	]);

	it("concatenates composed durations (speed shortens)", () => {
		const tl = buildComposedTimeline(p);
		// s1: 10s/1 = 10s composed; s2: 10s/2 = 5s composed
		expect(tl.totalComposedMs).toBe(15000);
		expect(tl.segments[0]).toMatchObject({ composedStartMs: 0, composedEndMs: 10000 });
		expect(tl.segments[1]).toMatchObject({ composedStartMs: 10000, composedEndMs: 15000 });
	});

	it("maps composed time back to source time (sped segment runs faster)", () => {
		const tl = buildComposedTimeline(p);
		// composed 5s -> inside s1 -> source 5s
		expect(tl.composedToSource(5000)).toEqual({ sourceVideoID: "A", sourceMs: 5000 });
		// composed 12s -> 2s into s2 (composedStart 10s) -> source 10s + 2s*2 = 14s
		expect(tl.composedToSource(12000)).toEqual({ sourceVideoID: "A", sourceMs: 14000 });
		// at the boundary 10s -> start of s2 -> source 10s
		expect(tl.composedToSource(10000)).toEqual({ sourceVideoID: "A", sourceMs: 10000 });
	});

	it("clamps past-the-end to the last segment out-point", () => {
		const tl = buildComposedTimeline(p);
		expect(tl.composedToSource(99999)).toEqual({ sourceVideoID: "A", sourceMs: 20000 });
	});

	it("handles an empty project", () => {
		const tl = buildComposedTimeline(project([]));
		expect(tl.totalComposedMs).toBe(0);
		expect(tl.composedToSource(0)).toBeNull();
		expect(tl.activeAt(0)).toBeNull();
	});
});

describe("cuttiProjectToEditorState", () => {
	it("merges cutti regions onto a base editor state, preserving other fields", () => {
		const p = project([
			{ id: "s1", sourceVideoID: "A", startSeconds: 0, endSeconds: 6, text: "", speedRate: 2 },
		]);
		const state = cuttiProjectToEditorState(p);
		expect(state.trimRegions).toHaveLength(1);
		expect(state.speedRegions).toHaveLength(1);
		// untouched defaults survive
		expect(state.cropRegion).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		expect(state.autoZoomEnabled).toBe(true);
		expect(state.zoomRegions).toEqual([]);
	});
});
