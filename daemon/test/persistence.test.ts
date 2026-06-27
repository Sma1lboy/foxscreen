import { describe, it, expect } from "vitest";

import {
  serializeProject,
  deserializeProject,
  toPersistableProject,
} from "../src/persistence/projectFile";
import type { Project } from "../src/model/project";
import { makePrimaryVideoTrack, makeTrack, primarySegments } from "../src/model/project";
import { makeTimelineSegment } from "../src/model/timelineSegment";
import { makeTimeRange } from "../src/model/timeRange";
import { makeSubtitleEntry, makeWordTiming } from "../src/model/subtitle";

function richProject(): Project {
  const sub = makeSubtitleEntry({
    id: "sub-1",
    relativeStart: 0.5,
    relativeDuration: 1.25,
    text: "hello",
    speakerID: 2,
    translations: { "zh-Hans": "你好" },
    wordTimings: [makeWordTiming("hello", 0, 0.4)],
  });
  const segment = makeTimelineSegment({
    id: "seg-1",
    sourceVideoID: "src-1",
    range: makeTimeRange(3, 13),
    text: "hello",
    subtitles: [sub],
    volumeLevel: 0.8,
    speedRate: 2.0,
    isVideoHidden: true,
    placementOffset: 1.5,
    alternatives: [
      { id: "alt-1", sourceVideoID: "src-1", startSeconds: 20, endSeconds: 24, text: "alt" },
    ],
  });
  segment.effects.audioFadeInDuration = 0.3;
  segment.effects.audioFadeOutDuration = 0.6;
  segment.effects.brightness = 0.1;
  return { tracks: [makePrimaryVideoTrack("track-1", [segment])] };
}

describe("project.json persistence", () => {
  it("round-trips a rich project losslessly (idempotent serialize)", () => {
    const project = richProject();
    const once = serializeProject(project);
    const twice = serializeProject(deserializeProject(once));
    expect(twice).toBe(once);
  });

  it("preserves meaningful segment + subtitle fields across a round-trip", () => {
    const restored = deserializeProject(serializeProject(richProject()));
    const seg = primarySegments(restored)[0]!;
    expect(seg.id).toBe("seg-1");
    expect(seg.range.startSeconds).toBe(3);
    expect(seg.range.endSeconds).toBe(13);
    expect(seg.volumeLevel).toBe(0.8);
    expect(seg.speedRate).toBe(2.0);
    expect(seg.isVideoHidden).toBe(true);
    expect(seg.placementOffset).toBe(1.5);
    expect(seg.effects.audioFadeInDuration).toBe(0.3);
    expect(seg.effects.audioFadeOutDuration).toBe(0.6);
    expect(seg.effects.brightness).toBe(0.1);
    expect(seg.alternatives).toHaveLength(1);
    expect(seg.alternatives[0]!.text).toBe("alt");

    const sub = seg.subtitles[0]!;
    expect(sub.text).toBe("hello");
    expect(sub.speakerID).toBe(2);
    expect(sub.translations).toEqual({ "zh-Hans": "你好" });
    expect(sub.wordTimings).toHaveLength(1);
    expect(sub.wordTimings![0]!.text).toBe("hello");
  });

  it("fills defaults for a minimal track (missing isLocked -> false)", () => {
    const minimal = {
      version: 1,
      tracks: [
        {
          id: "t",
          kind: "video",
          name: "V1",
          isMuted: false,
          isSolo: false,
          segments: [
            {
              id: "s",
              sourceVideoID: "src",
              startSeconds: 0,
              endSeconds: 4,
              text: "",
              volumeLevel: 1,
              speedRate: 1,
            },
          ],
        },
      ],
    };
    const project = deserializeProject(JSON.stringify(minimal));
    expect(project.tracks[0]!.isLocked).toBe(false);
    const seg = project.tracks[0]!.segments[0]!;
    expect(seg.subtitles).toEqual([]);
    expect(seg.alternatives).toEqual([]);
    expect(seg.effects.audioFadeInDuration).toBe(0);
  });

  it("stamps the current version on write", () => {
    const pp = toPersistableProject({ tracks: [makeTrack({ id: "t", kind: "video", name: "V1" })] });
    expect(pp.version).toBe(1);
  });

  it("rejects malformed json", () => {
    expect(() => deserializeProject("{}")).toThrow();
    expect(() => deserializeProject('{"version":1}')).toThrow();
  });
});
