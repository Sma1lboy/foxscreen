import { describe, it, expect } from "vitest";

import {
  applyActionBatch,
  type ApplyOptions,
} from "../src/actions/executor";
import type { AIAction } from "../src/actions/aiAction";
import type { TranscriptLookup } from "../src/actions/transcriptLookup";
import {
  makeTimelineSegment,
  durationSeconds,
  normalizedSpeedRate,
  type TimelineSegment,
} from "../src/model/timelineSegment";
import { makeTimeRange } from "../src/model/timeRange";
import { makeSubtitleEntry, type SubtitleEntry } from "../src/model/subtitle";

const SRC_A = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const FOREIGN = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";

let idCounter = 0;
function uid(prefix = "id"): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

function seg(args: {
  id?: string;
  src?: string;
  start: number;
  end: number;
  speed?: number;
  text?: string;
  subtitles?: SubtitleEntry[];
}): TimelineSegment {
  return makeTimelineSegment({
    id: args.id ?? uid("seg"),
    sourceVideoID: args.src ?? SRC_A,
    range: makeTimeRange(args.start, args.end),
    text: args.text ?? "",
    subtitles: args.subtitles ?? [],
    speedRate: args.speed ?? 1.0,
  });
}

function applyOne(action: AIAction, segments: TimelineSegment[], opts?: ApplyOptions) {
  return applyActionBatch({ actions: [action], explanation: "test" }, segments, opts);
}

function totalDuration(segments: TimelineSegment[]): number {
  return segments.reduce((acc, s) => acc + durationSeconds(s), 0);
}

// ---------------------------------------------------------------------------
// insertSourceClip — mirrors InsertSourceClipExecutorTests.swift
// ---------------------------------------------------------------------------

describe("insertSourceClip", () => {
  function insert(
    over: {
      sourceStart: number;
      sourceEnd: number;
      composedInsertAt: number;
      fadeInSeconds?: number;
      fadeOutSeconds?: number;
    },
  ): AIAction {
    return {
      type: "insertSourceClip",
      sourceVideoID: FOREIGN,
      sourceStart: over.sourceStart,
      sourceEnd: over.sourceEnd,
      composedInsertAt: over.composedInsertAt,
      fadeInSeconds: over.fadeInSeconds ?? 0,
      fadeOutSeconds: over.fadeOutSeconds ?? 0,
    };
  }

  it("at 0 prepends before all segments", () => {
    const hostID = uid("host");
    const r = applyOne(insert({ sourceStart: 100, sourceEnd: 105, composedInsertAt: 0 }), [
      seg({ id: hostID, start: 0, end: 10, text: "host" }),
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.skippedCount).toBe(0);
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]!.sourceVideoID).toBe(FOREIGN);
    expect(r.segments[0]!.range.startSeconds).toBeCloseTo(100, 3);
    expect(r.segments[0]!.range.endSeconds).toBeCloseTo(105, 3);
    expect(r.segments[1]!.id).toBe(hostID);
    expect(r.segments[1]!.range.endSeconds).toBeCloseTo(10, 3);
  });

  it("at timeline end appends last", () => {
    const a = uid("a");
    const b = uid("b");
    const r = applyOne(insert({ sourceStart: 0, sourceEnd: 5, composedInsertAt: 8 }), [
      seg({ id: a, start: 0, end: 4 }),
      seg({ id: b, start: 0, end: 4 }),
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]!.id).toBe(a);
    expect(r.segments[1]!.id).toBe(b);
    expect(r.segments[2]!.sourceVideoID).toBe(FOREIGN);
  });

  it("clamps a negative insert to zero", () => {
    const r = applyOne(insert({ sourceStart: 0, sourceEnd: 3, composedInsertAt: -42 }), [
      seg({ start: 0, end: 10, text: "host" }),
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments[0]!.sourceVideoID).toBe(FOREIGN);
  });

  it("clamps a huge insert to the timeline end", () => {
    const r = applyOne(insert({ sourceStart: 0, sourceEnd: 3, composedInsertAt: 9999 }), [
      seg({ start: 0, end: 4, text: "host" }),
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments[r.segments.length - 1]!.sourceVideoID).toBe(FOREIGN);
  });

  it("at a segment boundary splices between without splitting", () => {
    const a = uid("a");
    const b = uid("b");
    const r = applyOne(insert({ sourceStart: 0, sourceEnd: 2, composedInsertAt: 5 }), [
      seg({ id: a, start: 0, end: 5, text: "A" }),
      seg({ id: b, start: 0, end: 5, text: "B" }),
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]!.id).toBe(a);
    expect(r.segments[1]!.sourceVideoID).toBe(FOREIGN);
    expect(r.segments[2]!.id).toBe(b);
  });

  it("mid-segment splits the host and inserts", () => {
    const host = uid("host");
    const r = applyOne(insert({ sourceStart: 0, sourceEnd: 3, composedInsertAt: 4 }), [
      seg({ id: host, start: 0, end: 10, text: "host" }),
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]!.range.startSeconds).toBeCloseTo(0, 3);
    expect(r.segments[0]!.range.endSeconds).toBeCloseTo(4, 3);
    expect(r.segments[1]!.sourceVideoID).toBe(FOREIGN);
    expect(r.segments[1]!.range.startSeconds).toBeCloseTo(0, 3);
    expect(r.segments[1]!.range.endSeconds).toBeCloseTo(3, 3);
    expect(r.segments[2]!.range.startSeconds).toBeCloseTo(4, 3);
    expect(r.segments[2]!.range.endSeconds).toBeCloseTo(10, 3);
    expect(totalDuration(r.segments)).toBeCloseTo(13, 3);
  });

  it("mid-segment with speedRate splits at the correct source time", () => {
    const host = uid("host");
    const r = applyOne(insert({ sourceStart: 50, sourceEnd: 53, composedInsertAt: 2 }), [
      seg({ id: host, start: 0, end: 10, speed: 2.0, text: "fast" }),
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]!.range.startSeconds).toBeCloseTo(0, 2);
    expect(r.segments[0]!.range.endSeconds).toBeCloseTo(4, 2);
    expect(normalizedSpeedRate(r.segments[0]!)).toBeCloseTo(2.0, 3);
    expect(r.segments[1]!.sourceVideoID).toBe(FOREIGN);
    expect(normalizedSpeedRate(r.segments[1]!)).toBeCloseTo(1.0, 3);
    expect(r.segments[2]!.range.startSeconds).toBeCloseTo(4, 2);
    expect(r.segments[2]!.range.endSeconds).toBeCloseTo(10, 2);
    expect(normalizedSpeedRate(r.segments[2]!)).toBeCloseTo(2.0, 3);
  });

  it("clamps and applies fades", () => {
    const r = applyOne(
      insert({ sourceStart: 0, sourceEnd: 1, composedInsertAt: 0, fadeInSeconds: 5, fadeOutSeconds: -3 }),
      [seg({ start: 0, end: 5, text: "host" })],
    );
    expect(r.appliedCount).toBe(1);
    expect(r.segments[0]!.effects.audioFadeInDuration).toBeCloseTo(0.5, 3);
    expect(r.segments[0]!.effects.audioFadeOutDuration).toBeCloseTo(0.0, 3);
  });

  it("mid-segment clears interior fades on host halves", () => {
    const host = seg({ start: 0, end: 10, text: "host" });
    host.effects.audioFadeInDuration = 0.4;
    host.effects.audioFadeOutDuration = 0.6;
    const r = applyOne(insert({ sourceStart: 0, sourceEnd: 2, composedInsertAt: 4 }), [host]);
    expect(r.segments).toHaveLength(3);
    expect(r.segments[0]!.effects.audioFadeInDuration).toBeCloseTo(0.4, 3);
    expect(r.segments[0]!.effects.audioFadeOutDuration).toBeCloseTo(0.0, 3);
    expect(r.segments[2]!.effects.audioFadeInDuration).toBeCloseTo(0.0, 3);
    expect(r.segments[2]!.effects.audioFadeOutDuration).toBeCloseTo(0.6, 3);
  });

  it("pulls subtitles from the foreign source via the lookup", () => {
    const lookup: TranscriptLookup = (ranges, sourceID) => {
      const range = ranges[0];
      if (sourceID !== FOREIGN || !range) return [];
      return [
        makeSubtitleEntry({
          id: uid("sub"),
          relativeStart: 0,
          relativeDuration: range.endSeconds - range.startSeconds,
          text: "金句",
        }),
      ];
    };
    const r = applyOne(insert({ sourceStart: 100, sourceEnd: 103, composedInsertAt: 0 }), [
      seg({ start: 0, end: 4, text: "host" }),
    ], { transcriptLookup: lookup });
    expect(r.appliedCount).toBe(1);
    expect(r.segments[0]!.subtitles).toHaveLength(1);
    expect(r.segments[0]!.subtitles[0]!.text).toBe("金句");
    expect(r.segments[0]!.text).toBe("金句");
  });

  it("unknown source with empty lookup still inserts (no subtitles)", () => {
    const r = applyOne(insert({ sourceStart: 0, sourceEnd: 2, composedInsertAt: 0 }), [
      seg({ start: 0, end: 4, text: "host" }),
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments[0]!.sourceVideoID).toBe(FOREIGN);
    expect(r.segments[0]!.subtitles).toHaveLength(0);
  });

  it("inverted source range is skipped", () => {
    const r = applyOne(insert({ sourceStart: 5, sourceEnd: 1, composedInsertAt: 0 }), [
      seg({ start: 0, end: 4, text: "host" }),
    ]);
    expect(r.appliedCount).toBe(0);
    expect(r.skippedCount).toBe(1);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.text).toBe("host");
  });

  it("sub-second source range still inserts", () => {
    const r = applyOne(insert({ sourceStart: 0, sourceEnd: 0.1, composedInsertAt: 0 }), [
      seg({ start: 0, end: 4, text: "host" }),
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments[0]!.range.endSeconds).toBeCloseTo(0.1, 3);
  });

  it("into an empty timeline appends as the only segment", () => {
    const r = applyOne(insert({ sourceStart: 0, sourceEnd: 5, composedInsertAt: 0 }), []);
    expect(r.appliedCount).toBe(1);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.sourceVideoID).toBe(FOREIGN);
  });

  it("mixed batch: insert then deleteRange applies against the mutated timeline", () => {
    const host = uid("host");
    const r = applyActionBatch(
      {
        explanation: "teaser then trim host head",
        actions: [
          {
            type: "insertSourceClip",
            sourceVideoID: FOREIGN,
            sourceStart: 0,
            sourceEnd: 5,
            composedInsertAt: 0,
            fadeInSeconds: 0,
            fadeOutSeconds: 0,
          },
          { type: "deleteRange", start: 5, end: 7 },
        ],
      },
      [seg({ id: host, src: SRC_A, start: 0, end: 10, text: "host" })],
    );
    expect(r.appliedCount).toBe(2);
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]!.sourceVideoID).toBe(FOREIGN);
    expect(r.segments[1]!.sourceVideoID).toBe(SRC_A);
    expect(r.segments[1]!.range.startSeconds).toBeCloseTo(2, 3);
    expect(r.segments[1]!.range.endSeconds).toBeCloseTo(10, 3);
  });
});

// ---------------------------------------------------------------------------
// Other timeline actions
// ---------------------------------------------------------------------------

describe("segment actions", () => {
  it("deleteSegment removes by id; missing id is skipped", () => {
    const a = uid("a");
    const b = uid("b");
    const segments = [seg({ id: a, start: 0, end: 5 }), seg({ id: b, start: 0, end: 5 })];
    const r = applyOne({ type: "deleteSegment", id: a }, segments);
    expect(r.appliedCount).toBe(1);
    expect(r.segments.map((s) => s.id)).toEqual([b]);

    const miss = applyOne({ type: "deleteSegment", id: "nope" }, segments);
    expect(miss.appliedCount).toBe(0);
    expect(miss.skippedCount).toBe(1);
  });

  it("setVolume applies a real change, and skips a clamp that lands on the current value", () => {
    const id = uid("s");
    // Real change: default volume 1.0 -> 0.3.
    const r = applyOne({ type: "setVolume", id, level: 0.3 }, [seg({ id, start: 0, end: 5 })]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments[0]!.volumeLevel).toBeCloseTo(0.3, 9);

    // level 2 clamps to 1.0 == the segment's current volume -> skipped (parity
    // with Swift: `abs(volumeLevel - clamped) > 0.001` is false).
    const clampNoop = applyOne({ type: "setVolume", id, level: 2 }, [seg({ id, start: 0, end: 5 })]);
    expect(clampNoop.appliedCount).toBe(0);
    expect(clampNoop.skippedCount).toBe(1);
    expect(clampNoop.segments[0]!.volumeLevel).toBe(1);

    // Explicit no-op at the current value.
    const noop = applyOne({ type: "setVolume", id, level: 1 }, [seg({ id, start: 0, end: 5 })]);
    expect(noop.skippedCount).toBe(1);
  });

  it("setSpeed clamps to [0.25, 4.0]", () => {
    const id = uid("s");
    const r = applyOne({ type: "setSpeed", id, rate: 10 }, [seg({ id, start: 0, end: 8 })]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments[0]!.speedRate).toBe(4.0);

    const noop = applyOne({ type: "setSpeed", id, rate: 1 }, [seg({ id, start: 0, end: 8 })]);
    expect(noop.skippedCount).toBe(1);
  });

  it("splitSegment enforces the 0.2s minimum and splits otherwise", () => {
    const id = uid("s");
    const tooEarly = applyOne({ type: "splitSegment", id, atSourceTime: 0.1 }, [
      seg({ id, start: 0, end: 10 }),
    ]);
    expect(tooEarly.skippedCount).toBe(1);

    const ok = applyOne({ type: "splitSegment", id, atSourceTime: 5 }, [
      seg({ id, start: 0, end: 10 }),
    ]);
    expect(ok.appliedCount).toBe(1);
    expect(ok.segments).toHaveLength(2);
    expect(ok.segments[0]!.range.endSeconds).toBeCloseTo(5, 3);
    expect(ok.segments[1]!.range.startSeconds).toBeCloseTo(5, 3);
  });

  it("trimStart / trimEnd clamp to the minimum segment duration", () => {
    const id = uid("s");
    const ts = applyOne({ type: "trimStart", id, newStart: 3 }, [seg({ id, start: 0, end: 10 })]);
    expect(ts.appliedCount).toBe(1);
    expect(ts.segments[0]!.range.startSeconds).toBeCloseTo(3, 3);
    expect(ts.segments[0]!.id).toBe(id); // id preserved on trim

    const te = applyOne({ type: "trimEnd", id, newEnd: 6 }, [seg({ id, start: 0, end: 10 })]);
    expect(te.appliedCount).toBe(1);
    expect(te.segments[0]!.range.endSeconds).toBeCloseTo(6, 3);
  });

  it("deleteRange cuts composed time and re-derives fragments", () => {
    const r = applyOne({ type: "deleteRange", start: 2, end: 5 }, [seg({ start: 0, end: 10 })]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0]!.range.startSeconds).toBeCloseTo(0, 3);
    expect(r.segments[0]!.range.endSeconds).toBeCloseTo(2, 3);
    expect(r.segments[1]!.range.startSeconds).toBeCloseTo(5, 3);
    expect(r.segments[1]!.range.endSeconds).toBeCloseTo(10, 3);
    expect(totalDuration(r.segments)).toBeCloseTo(7, 3);
  });

  it("setSpeedRange covering the whole segment sets its speed", () => {
    const r = applyOne({ type: "setSpeedRange", start: 0, end: 10, rate: 2 }, [
      seg({ start: 0, end: 10 }),
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.speedRate).toBe(2);
    expect(durationSeconds(r.segments[0]!)).toBeCloseTo(5, 3);
  });

  it("reorderSegments moves listed ids to front, others keep order", () => {
    const a = uid("a");
    const b = uid("b");
    const c = uid("c");
    const r = applyOne({ type: "reorderSegments", ids: [c, a] }, [
      seg({ id: a, start: 0, end: 1 }),
      seg({ id: b, start: 0, end: 1 }),
      seg({ id: c, start: 0, end: 1 }),
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments.map((s) => s.id)).toEqual([c, a, b]);
  });
});

describe("subtitle text actions", () => {
  function segWithSub(subID: string, text: string): TimelineSegment {
    return seg({
      start: 0,
      end: 5,
      subtitles: [
        makeSubtitleEntry({ id: subID, relativeStart: 0, relativeDuration: 2, text }),
      ],
    });
  }

  it("editSubtitle by id replaces text and drops word timings; no-op is skipped", () => {
    const subID = uid("sub");
    const r = applyOne({ type: "editSubtitle", id: subID, newText: "  new  " }, [
      segWithSub(subID, "old"),
    ]);
    expect(r.appliedCount).toBe(1);
    expect(r.segments[0]!.subtitles[0]!.text).toBe("new");
    expect(r.segments[0]!.subtitles[0]!.wordTimings).toBeUndefined();

    const noop = applyOne({ type: "editSubtitle", id: subID, newText: "old" }, [
      segWithSub(subID, "old"),
    ]);
    expect(noop.skippedCount).toBe(1);
  });

  it("replaceSubtitleText replaces all literal occurrences", () => {
    const subID = uid("sub");
    const r = applyOne(
      { type: "replaceSubtitleText", find: "world", replaceWith: "there", isRegex: false },
      [segWithSub(subID, "world world")],
    );
    expect(r.appliedCount).toBe(1);
    expect(r.segments[0]!.subtitles[0]!.text).toBe("there there");

    const noop = applyOne(
      { type: "replaceSubtitleText", find: "zzz", replaceWith: "x", isRegex: false },
      [segWithSub(subID, "hello")],
    );
    expect(noop.skippedCount).toBe(1);
  });

  it("replaceSubtitleText honors a leading ICU inline (?i) flag (parity with NSRegularExpression)", () => {
    const subID = uid("sub");
    const r = applyOne(
      { type: "replaceSubtitleText", find: "(?i)hello", replaceWith: "hi", isRegex: true },
      [segWithSub(subID, "Hello HELLO hello")],
    );
    expect(r.appliedCount).toBe(1);
    expect(r.segments[0]!.subtitles[0]!.text).toBe("hi hi hi");
  });

  it("replaceSubtitleText translates ICU $0 (whole match) to the matched text", () => {
    const subID = uid("sub");
    const r = applyOne(
      { type: "replaceSubtitleText", find: "ab", replaceWith: "[$0]", isRegex: true },
      [segWithSub(subID, "ab cd ab")],
    );
    expect(r.appliedCount).toBe(1);
    expect(r.segments[0]!.subtitles[0]!.text).toBe("[ab] cd [ab]");
  });

  it("replaceSubtitleText supports capture groups via $1", () => {
    const subID = uid("sub");
    const r = applyOne(
      { type: "replaceSubtitleText", find: "(\\w+)@(\\w+)", replaceWith: "$2.$1", isRegex: true },
      [segWithSub(subID, "user@host")],
    );
    expect(r.appliedCount).toBe(1);
    expect(r.segments[0]!.subtitles[0]!.text).toBe("host.user");
  });
});

describe("purity", () => {
  it("does not mutate the caller's input segments", () => {
    const id = uid("s");
    const input = [seg({ id, start: 0, end: 10 })];
    const snapshot = JSON.stringify(input);
    applyOne({ type: "setVolume", id, level: 0.5 }, input);
    applyOne({ type: "deleteRange", start: 2, end: 5 }, input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
