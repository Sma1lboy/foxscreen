import { describe, it, expect } from "vitest";

import {
  makeDefaultTranscriptLookup,
  emptyTranscriptLookup,
  type SourceTranscriptMap,
} from "../src/actions/transcriptLookup";
import { makeSubtitleEntry, type SubtitleEntry } from "../src/model/subtitle";
import { makeTimeRange } from "../src/model/timeRange";

const SRC = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";

function sourceEntry(start: number, dur: number, text: string): SubtitleEntry {
  return makeSubtitleEntry({
    id: `${text}-${start}`,
    relativeStart: start, // interpreted as ABSOLUTE source seconds in the map
    relativeDuration: dur,
    text,
  });
}

describe("makeDefaultTranscriptLookup", () => {
  let counter = 0;
  const newID = () => `clip-${(counter += 1)}`;

  const map: SourceTranscriptMap = new Map([
    [SRC, [sourceEntry(0, 2, "a"), sourceEntry(2, 2, "b"), sourceEntry(4, 2, "c")]],
  ]);

  it("clips and rebases cues into the requested range", () => {
    const lookup = makeDefaultTranscriptLookup(map, newID);
    const out = lookup([makeTimeRange(1, 5)], SRC);

    expect(out.map((e) => e.text)).toEqual(["a", "b", "c"]);
    // a: source [0,2] clipped to [1,2] -> rebased start 0, dur 1
    expect(out[0]!.relativeStart).toBeCloseTo(0, 9);
    expect(out[0]!.relativeDuration).toBeCloseTo(1, 9);
    // b: source [2,4] fully inside [1,5] -> rebased start 1, dur 2
    expect(out[1]!.relativeStart).toBeCloseTo(1, 9);
    expect(out[1]!.relativeDuration).toBeCloseTo(2, 9);
    // c: source [4,6] clipped to [4,5] -> rebased start 3, dur 1
    expect(out[2]!.relativeStart).toBeCloseTo(3, 9);
    expect(out[2]!.relativeDuration).toBeCloseTo(1, 9);
  });

  it("returns nothing for an unknown source", () => {
    const lookup = makeDefaultTranscriptLookup(map, newID);
    expect(lookup([makeTimeRange(0, 10)], "unknown")).toHaveLength(0);
  });

  it("assigns fresh ids so split halves don't collide", () => {
    const lookup = makeDefaultTranscriptLookup(map, newID);
    const a = lookup([makeTimeRange(0, 6)], SRC);
    const b = lookup([makeTimeRange(0, 6)], SRC);
    const ids = new Set([...a, ...b].map((e) => e.id));
    expect(ids.size).toBe(a.length + b.length);
  });

  it("emptyTranscriptLookup returns nothing", () => {
    expect(emptyTranscriptLookup([makeTimeRange(0, 10)], SRC)).toHaveLength(0);
  });
});
