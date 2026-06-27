import { describe, expect, it } from "vitest";
import type { TimelineClip } from "@/components/video-editor/timeline/clipModel";
import { buildTimelineRenderPlan, planAudioGainAt, segmentFrameCount } from "./timelineRender";

/** Build a video clip with sane defaults; override what each test needs. */
function clip(partial: Partial<TimelineClip> & { id: string }): TimelineClip {
	return {
		assetId: "asset",
		name: "clip",
		sourcePath: "/tmp/source.mp4",
		trackIndex: 0,
		startSec: 0,
		inSec: 0,
		outSec: 1,
		...partial,
	};
}

describe("buildTimelineRenderPlan", () => {
	it("returns an empty plan for an empty timeline", () => {
		const plan = buildTimelineRenderPlan([], 30);
		expect(plan.segments).toEqual([]);
		expect(plan.totalDuration).toBe(0);
		expect(plan.totalFrames).toBe(0);
		expect(plan.fps).toBe(30);
	});

	it("rejects a non-positive fps", () => {
		expect(() => buildTimelineRenderPlan([clip({ id: "a" })], 0)).toThrow();
		expect(() => buildTimelineRenderPlan([clip({ id: "a" })], -5)).toThrow();
		expect(() => buildTimelineRenderPlan([clip({ id: "a" })], Number.NaN)).toThrow();
	});

	it("handles the single-clip degenerate case (one full-span segment)", () => {
		// One 4s clip at the head of the timeline, full source [0,4].
		const clips = [clip({ id: "a", startSec: 0, inSec: 0, outSec: 4 })];
		const plan = buildTimelineRenderPlan(clips, 30);

		expect(plan.totalDuration).toBe(4);
		expect(plan.totalFrames).toBe(120);
		expect(plan.segments).toHaveLength(1);

		const seg = plan.segments[0];
		expect(seg.startSec).toBe(0);
		expect(seg.endSec).toBe(4);
		expect(seg.clip?.id).toBe("a");
		expect(seg.sourceStartSec).toBe(0);
		expect(seg.sourceEndSec).toBe(4);
		expect(seg.startFrame).toBe(0);
		expect(seg.endFrame).toBe(120);
		expect(segmentFrameCount(seg)).toBe(120);
	});

	it("maps trims to source times (in/out offset)", () => {
		// Clip plays source seconds [10,13] but sits at timeline [2,5].
		const clips = [clip({ id: "a", startSec: 2, inSec: 10, outSec: 13 })];
		const plan = buildTimelineRenderPlan(clips, 25);

		// Timeline runs [0,5] -> a leading gap [0,2] then the clip [2,5].
		expect(plan.totalDuration).toBe(5);
		expect(plan.segments).toHaveLength(2);

		const [gap, body] = plan.segments;
		expect(gap.clip).toBeNull();
		expect(gap.startSec).toBe(0);
		expect(gap.endSec).toBe(2);

		expect(body.clip?.id).toBe("a");
		expect(body.startSec).toBe(2);
		expect(body.endSec).toBe(5);
		// Source window is the clip's [inSec, outSec], not the timeline position.
		expect(body.sourceStartSec).toBeCloseTo(10);
		expect(body.sourceEndSec).toBeCloseTo(13);
	});

	it("sequences two adjacent clips in timeline order with their own source windows", () => {
		const clips = [
			clip({ id: "a", startSec: 0, inSec: 5, outSec: 8 }), // 3s, source [5,8]
			clip({ id: "b", startSec: 3, inSec: 0, outSec: 2 }), // 2s, source [0,2]
		];
		const plan = buildTimelineRenderPlan(clips, 30);

		expect(plan.totalDuration).toBe(5);
		expect(plan.segments.map((s) => s.clip?.id)).toEqual(["a", "b"]);

		const [a, b] = plan.segments;
		expect(a.sourceStartSec).toBeCloseTo(5);
		expect(a.sourceEndSec).toBeCloseTo(8);
		expect(b.startSec).toBe(3);
		expect(b.sourceStartSec).toBeCloseTo(0);
		expect(b.sourceEndSec).toBeCloseTo(2);

		// Frame counts tile the whole output with no drift.
		const sum = plan.segments.reduce((n, s) => n + segmentFrameCount(s), 0);
		expect(sum).toBe(plan.totalFrames);
	});

	it("emits a black gap segment between two clips", () => {
		const clips = [
			clip({ id: "a", startSec: 0, inSec: 0, outSec: 2 }),
			clip({ id: "b", startSec: 5, inSec: 0, outSec: 2 }),
		];
		const plan = buildTimelineRenderPlan(clips, 30);

		expect(plan.segments.map((s) => s.clip?.id ?? "gap")).toEqual(["a", "gap", "b"]);
		const gap = plan.segments[1];
		expect(gap.clip).toBeNull();
		expect(gap.startSec).toBe(2);
		expect(gap.endSec).toBe(5);
		expect(gap.sourceStartSec).toBe(0);
		expect(gap.sourceEndSec).toBe(0);
	});

	it("lets the top track win where clips overlap", () => {
		// Track 1 (lower) spans [0,6]; track 0 (top) overrides [2,4].
		const clips = [
			clip({ id: "lower", trackIndex: 1, startSec: 0, inSec: 0, outSec: 6 }),
			clip({ id: "top", trackIndex: 0, startSec: 2, inSec: 0, outSec: 2 }),
		];
		const plan = buildTimelineRenderPlan(clips, 30);

		expect(plan.totalDuration).toBe(6);
		expect(plan.segments.map((s) => s.clip?.id)).toEqual(["lower", "top", "lower"]);
		// The middle override reads the top clip's source window.
		expect(plan.segments[1].sourceStartSec).toBeCloseTo(0);
		expect(plan.segments[1].sourceEndSec).toBeCloseTo(2);
		// The lower clip resumes at its own source offset (2..4 was covered -> 4..6).
		expect(plan.segments[2].sourceStartSec).toBeCloseTo(4);
		expect(plan.segments[2].sourceEndSec).toBeCloseTo(6);
	});

	it("merges adjacent spans that resolve to the same clip", () => {
		// An audio clip edge on track 2 must NOT split the video segment.
		const clips = [
			clip({ id: "v", trackIndex: 0, startSec: 0, inSec: 0, outSec: 6 }),
			clip({ id: "aud", trackIndex: 2, startSec: 3, inSec: 0, outSec: 1 }),
		];
		const plan = buildTimelineRenderPlan(clips, 30);
		expect(plan.segments).toHaveLength(1);
		expect(plan.segments[0].clip?.id).toBe("v");
		expect(plan.segments[0].sourceEndSec).toBeCloseTo(6);
	});

	it("frame counts always sum to totalFrames (no drift) at awkward fps", () => {
		const clips = [
			clip({ id: "a", startSec: 0, inSec: 0, outSec: 1.337 }),
			clip({ id: "b", startSec: 1.337, inSec: 0, outSec: 2.111 }),
		];
		for (const fps of [24, 25, 30, 59.94, 60]) {
			const plan = buildTimelineRenderPlan(clips, fps);
			const sum = plan.segments.reduce((n, s) => n + segmentFrameCount(s), 0);
			expect(sum).toBe(plan.totalFrames);
		}
	});
});

describe("planAudioGainAt", () => {
	it("is 0 in a gap and the clip volume inside a clip", () => {
		const clips = [clip({ id: "a", startSec: 2, inSec: 0, outSec: 4, volume: 0.5 })];
		expect(planAudioGainAt(clips, 1)).toBe(0); // before the clip
		expect(planAudioGainAt(clips, 3)).toBeCloseTo(0.5); // mid-clip
		expect(planAudioGainAt(clips, 99)).toBe(0); // after the clip
	});

	it("respects mute", () => {
		const clips = [clip({ id: "a", startSec: 0, inSec: 0, outSec: 4, volume: 1, muted: true })];
		expect(planAudioGainAt(clips, 2)).toBe(0);
	});

	it("ramps across fade-in and fade-out", () => {
		// 4s clip, 1s fade-in and 1s fade-out, full volume.
		const clips = [
			clip({ id: "a", startSec: 0, inSec: 0, outSec: 4, fadeInSec: 1, fadeOutSec: 1 }),
		];
		expect(planAudioGainAt(clips, 0)).toBeCloseTo(0); // fade-in start
		expect(planAudioGainAt(clips, 0.5)).toBeCloseTo(0.5); // mid fade-in
		expect(planAudioGainAt(clips, 2)).toBeCloseTo(1); // plateau
		expect(planAudioGainAt(clips, 3.5)).toBeCloseTo(0.5); // mid fade-out
	});

	it("follows the top clip where clips overlap", () => {
		const clips = [
			clip({ id: "lower", trackIndex: 1, startSec: 0, inSec: 0, outSec: 6, volume: 0.2 }),
			clip({ id: "top", trackIndex: 0, startSec: 2, inSec: 0, outSec: 2, volume: 0.9 }),
		];
		expect(planAudioGainAt(clips, 1)).toBeCloseTo(0.2);
		expect(planAudioGainAt(clips, 3)).toBeCloseTo(0.9);
		expect(planAudioGainAt(clips, 5)).toBeCloseTo(0.2);
	});
});
