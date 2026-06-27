/**
 * TranscriptLookup — the re-slicing dependency used by the executor.
 *
 * ## What it is (Swift parity)
 * In Swift this is `AIActionExecutor.TranscriptLookup = ([TimeRange], UUID) ->
 * [SubtitleEntry]`. `makeDerivedSegment` calls it every time a segment is
 * split / trimmed / range-deleted to re-fetch the subtitles that fall inside
 * the *new* source-time range of the derived segment. `insertSourceClip` also
 * calls it to pull subtitles for the spliced-in foreign-source range.
 *
 * The Swift call sites always pass a **single** range, but the signature is
 * `[TimeRange]` (a list); we keep the list signature for faithfulness and union
 * the results across ranges.
 *
 * ## Design decision (daemon implementation)
 * The daemon holds a per-source **source-time transcript map**:
 *
 *     sourceVideoID (string) -> SubtitleEntry[]   // times in SOURCE seconds
 *
 * Each entry's `relativeStart` / `relativeDuration` in this map are interpreted
 * as **absolute source-video seconds** (not segment-relative), because that is
 * the only timebase that is stable across timeline edits — a segment's
 * source-time `range` indexes directly into it. `makeDefaultTranscriptLookup`
 * turns that map into the lookup closure by:
 *
 *   1. selecting entries that overlap the requested source range,
 *   2. clipping each entry to the range (so a cue half-inside the range keeps
 *      only its in-range portion), and
 *   3. rebasing the clipped entry to be **relative to the new range start**, so
 *      the returned `SubtitleEntry.relativeStart` is segment-relative source
 *      time — exactly the shape `TimelineSegment.subtitles` expects.
 *
 * This is why split / trim / deleteRange preserve subtitles: the executor asks
 * for the derived segment's source range, and the lookup returns the slice of
 * the original transcript that lives in that window, rebased to the new
 * segment's local timebase.
 *
 * A caller that does not have transcripts (or wants the Swift test default of
 * "no subtitles") can pass `emptyTranscriptLookup`.
 */

import type { TimeRange } from "../model/timeRange";
import type { SubtitleEntry } from "../model/subtitle";
import { cloneSubtitleEntry } from "../model/subtitle";

export type TranscriptLookup = (
  ranges: TimeRange[],
  sourceVideoID: string,
) => SubtitleEntry[];

/** Returns no subtitles, matching the Swift tests' `{ _, _ in [] }` default. */
export const emptyTranscriptLookup: TranscriptLookup = () => [];

/**
 * A per-source transcript store keyed by `sourceVideoID`. Entries' relative
 * fields are **absolute source-video seconds** (see file header).
 */
export type SourceTranscriptMap = Map<string, SubtitleEntry[]>;

const EPSILON = 1e-9;

/**
 * Builds the default lookup over a source-time transcript map. Clips + rebases
 * cues into each requested range, unioned across ranges, preserving reading
 * order. New ids are generated for clipped cues so split halves don't collide
 * on subtitle identity (the daemon owns id generation).
 */
export function makeDefaultTranscriptLookup(
  transcripts: SourceTranscriptMap,
  newID: () => string,
): TranscriptLookup {
  return (ranges, sourceVideoID) => {
    const source = transcripts.get(sourceVideoID);
    if (!source || source.length === 0) return [];

    const out: SubtitleEntry[] = [];
    for (const range of ranges) {
      const lo = Math.min(range.startSeconds, range.endSeconds);
      const hi = Math.max(range.startSeconds, range.endSeconds);
      if (hi <= lo + EPSILON) continue;

      for (const entry of source) {
        const entryStart = entry.relativeStart;
        const entryEnd = entry.relativeStart + entry.relativeDuration;
        const overlapStart = Math.max(lo, entryStart);
        const overlapEnd = Math.min(hi, entryEnd);
        if (overlapEnd <= overlapStart + EPSILON) continue;

        const clipped = cloneSubtitleEntry(entry);
        clipped.id = newID();
        clipped.relativeStart = overlapStart - lo;
        clipped.relativeDuration = overlapEnd - overlapStart;
        // Word timings on the source entry are entry-relative; once we clip
        // the entry, those timings no longer line up with the clipped text,
        // so we drop them (same posture as a text edit). runs/styleOverride
        // are opaque carry-through; runs would also drift, so drop runs too.
        clipped.wordTimings = undefined;
        clipped.runs = undefined;
        out.push(clipped);
      }
    }
    return out;
  };
}
