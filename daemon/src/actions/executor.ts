/**
 * AIActionExecutor — applies an `AIActionBatch` to a frozen segment snapshot.
 *
 * Faithful 1:1 port of `CuttiKit.AIActionExecutor` (AIActionSystem.swift,
 * lines 104-844). Range actions (deleteRange, setSpeedRange) are resolved
 * against the *composed* timeline deterministically. The function is PURE: the
 * input `segments` array and its elements are never mutated — we deep-clone on
 * entry (Swift value semantics) and every derived segment is freshly built.
 *
 * Out of scope for v0 (see aiAction.ts): setSubtitleStyle / setSubtitlesVisible.
 * Hence the result drops the Swift `subtitleStyle` / `showSubtitles` fields.
 *
 * Parity notes worth preserving:
 *  - `makeDerivedSegment` (used by split / trim / deleteRange / setSpeedRange /
 *    insertSourceClip) copies only volumeLevel, speedRate, effects, alternatives
 *    from the original — it intentionally does NOT carry isVideoHidden,
 *    placementOffset, linkedSegmentID, pipLayout, overlaySpec. This mirrors the
 *    Swift implementation exactly (a derived fragment resets those to defaults).
 *  - The two-epsilon scheme matters: the clip-degeneracy / clipDuration guards
 *    use 0.01, the composed-overlap boundary comparisons use 0.001, and
 *    `normalize` uses 0.05. Do not unify them.
 *  - "No real change" counts as *skipped*, not applied (setVolume / setSpeed /
 *    editSubtitle / replaceSubtitleText).
 */

import { randomUUID } from "node:crypto";

import type { TimelineSegment } from "../model/timelineSegment";
import {
  MINIMUM_SPEED_RATE,
  MAXIMUM_SPEED_RATE,
  durationSeconds,
  normalizedSpeedRate,
  makeTimelineSegment,
  cloneTimelineSegment,
} from "../model/timelineSegment";
import { cloneSegmentEffects } from "../model/segmentEffects";
import { cloneAlternativeTake } from "../model/alternativeTake";
import type { TimeRange } from "../model/timeRange";
import { makeTimeRange } from "../model/timeRange";
import type { SubtitleEntry } from "../model/subtitle";
import { makeSubtitleEntry } from "../model/subtitle";
import type { Project } from "../model/project";
import { primarySegments, withPrimarySegments } from "../model/project";

import type { AIAction, AIActionBatch } from "./aiAction";
import type { TranscriptLookup } from "./transcriptLookup";
import { emptyTranscriptLookup } from "./transcriptLookup";

const MINIMUM_SEGMENT_DURATION = 0.2;

export interface ApplyResult {
  segments: TimelineSegment[];
  appliedCount: number;
  skippedCount: number;
  /**
   * Human-readable diagnostics produced while applying the batch. Empty in v0
   * (the only Swift producer was the subtitle-style patch path, which is out of
   * scope). Kept so the field shape is stable when M2 lands.
   */
  warnings: string[];
}

export interface ApplyOptions {
  /**
   * Re-slicing dependency. Defaults to {@link emptyTranscriptLookup}, matching
   * the Swift unit-test default of `{ _, _ in [] }`.
   */
  transcriptLookup?: TranscriptLookup;
  /** UUID generator for derived/inserted segments. Defaults to crypto UUID. */
  newID?: () => string;
}

// MARK: - Public API

/**
 * Apply actions to a snapshot. Mirrors `AIActionExecutor.apply(batch:to:...)`.
 * Actions that reference missing IDs or invalid composed-time ranges are skipped.
 */
export function applyActionBatch(
  batch: AIActionBatch,
  segments: readonly TimelineSegment[],
  options: ApplyOptions = {},
): ApplyResult {
  const transcriptLookup = options.transcriptLookup ?? emptyTranscriptLookup;
  const newID = options.newID ?? randomUUID;

  // Value semantics: never mutate the caller's segments.
  let segs: TimelineSegment[] = segments.map(cloneTimelineSegment);
  let applied = 0;
  let skipped = 0;
  const warnings: string[] = [];

  for (const action of batch.actions) {
    switch (action.type) {
      case "deleteSegment": {
        const idx = segs.findIndex((s) => s.id === action.id);
        if (idx >= 0) {
          segs.splice(idx, 1);
          applied += 1;
        } else {
          skipped += 1;
        }
        break;
      }

      case "deleteRange": {
        const updated = deleteComposedRange(
          makeTimeRange(action.start, action.end),
          segs,
          transcriptLookup,
          newID,
        );
        if (updated) {
          segs = updated;
          applied += 1;
        } else {
          skipped += 1;
        }
        break;
      }

      case "splitSegment": {
        const idx = segs.findIndex((s) => s.id === action.id);
        if (idx < 0) {
          skipped += 1;
          break;
        }
        const original = segs[idx]!;
        const splitTime = action.atSourceTime;
        if (
          !(splitTime > original.range.startSeconds + MINIMUM_SEGMENT_DURATION) ||
          !(splitTime < original.range.endSeconds - MINIMUM_SEGMENT_DURATION)
        ) {
          skipped += 1;
          break;
        }
        const leftRange = makeTimeRange(original.range.startSeconds, splitTime);
        const rightRange = makeTimeRange(splitTime, original.range.endSeconds);
        const left = makeDerivedSegment({ original, range: leftRange, transcriptLookup, newID });
        const right = makeDerivedSegment({ original, range: rightRange, transcriptLookup, newID });
        if (left && right) {
          segs.splice(idx, 1, left, right);
          applied += 1;
        } else {
          skipped += 1;
        }
        break;
      }

      case "trimStart": {
        const idx = segs.findIndex((s) => s.id === action.id);
        if (idx < 0) {
          skipped += 1;
          break;
        }
        const original = segs[idx]!;
        const clamped = Math.max(
          0,
          Math.min(action.newStart, original.range.endSeconds - MINIMUM_SEGMENT_DURATION),
        );
        const updatedRange = makeTimeRange(clamped, original.range.endSeconds);
        const updated = makeDerivedSegment({
          original,
          id: original.id,
          range: updatedRange,
          transcriptLookup,
          newID,
        });
        if (updated) {
          segs[idx] = updated;
          applied += 1;
        } else {
          skipped += 1;
        }
        break;
      }

      case "trimEnd": {
        const idx = segs.findIndex((s) => s.id === action.id);
        if (idx < 0) {
          skipped += 1;
          break;
        }
        const original = segs[idx]!;
        const clamped = Math.max(
          original.range.startSeconds + MINIMUM_SEGMENT_DURATION,
          action.newEnd,
        );
        const updatedRange = makeTimeRange(original.range.startSeconds, clamped);
        const updated = makeDerivedSegment({
          original,
          id: original.id,
          range: updatedRange,
          transcriptLookup,
          newID,
        });
        if (updated) {
          segs[idx] = updated;
          applied += 1;
        } else {
          skipped += 1;
        }
        break;
      }

      case "setVolume": {
        const idx = segs.findIndex((s) => s.id === action.id);
        if (idx < 0) {
          skipped += 1;
          break;
        }
        const clamped = Math.max(0, Math.min(1, action.level));
        if (!(Math.abs(segs[idx]!.volumeLevel - clamped) > 0.001)) {
          skipped += 1;
          break;
        }
        segs[idx]!.volumeLevel = clamped;
        applied += 1;
        break;
      }

      case "setSpeed": {
        const idx = segs.findIndex((s) => s.id === action.id);
        if (idx < 0) {
          skipped += 1;
          break;
        }
        const clamped = clampRate(action.rate);
        if (!(Math.abs(normalizedSpeedRate(segs[idx]!) - clamped) > 0.001)) {
          skipped += 1;
          break;
        }
        segs[idx]!.speedRate = clamped;
        applied += 1;
        break;
      }

      case "setSpeedRange": {
        const updated = setSpeedForComposedRange(
          makeTimeRange(action.start, action.end),
          action.rate,
          segs,
          transcriptLookup,
          newID,
        );
        if (updated) {
          segs = updated;
          applied += 1;
        } else {
          skipped += 1;
        }
        break;
      }

      case "reorderSegments": {
        const reordered: TimelineSegment[] = [];
        for (const id of action.ids) {
          const seg = segs.find((s) => s.id === id);
          if (seg) reordered.push(seg);
        }
        for (const seg of segs) {
          if (!action.ids.includes(seg.id)) reordered.push(seg);
        }
        segs = reordered;
        applied += 1;
        break;
      }

      case "insertSourceClip": {
        const updated = insertSourceClip({
          sourceVideoID: action.sourceVideoID,
          sourceStart: action.sourceStart,
          sourceEnd: action.sourceEnd,
          composedInsertAt: action.composedInsertAt,
          fadeInSeconds: action.fadeInSeconds,
          fadeOutSeconds: action.fadeOutSeconds,
          segments: segs,
          transcriptLookup,
          newID,
        });
        if (updated) {
          segs = updated;
          applied += 1;
        } else {
          skipped += 1;
        }
        break;
      }

      case "editSubtitle": {
        const trimmed = action.newText.trim();
        if (trimmed.length === 0) {
          skipped += 1;
          break;
        }
        let targetID: string | undefined;
        if (action.id !== undefined) {
          targetID = action.id;
        } else if (action.atSeconds !== undefined) {
          targetID = locateSubtitle(action.atSeconds, segs) ?? undefined;
        } else {
          targetID = undefined;
        }
        const loc = targetID !== undefined ? findSubtitle(targetID, segs) : null;
        if (targetID === undefined || !loc) {
          skipped += 1;
          break;
        }
        const old = segs[loc.segment]!.subtitles[loc.entry]!;
        if (!(old.text !== trimmed)) {
          skipped += 1;
          break;
        }
        segs[loc.segment]!.subtitles[loc.entry] = makeSubtitleEntry({
          id: old.id,
          relativeStart: old.relativeStart,
          relativeDuration: old.relativeDuration,
          text: trimmed,
          speakerID: old.speakerID,
          translations: { ...old.translations },
          runs: undefined,
          wordTimings: undefined,
          styleOverride: old.styleOverride,
        });
        applied += 1;
        break;
      }

      case "replaceSubtitleText": {
        if (action.find.length === 0) {
          skipped += 1;
          break;
        }
        const replacer = makeReplacer(action.find, action.replaceWith, action.isRegex);
        if (!replacer) {
          skipped += 1;
          break;
        }
        let changed = 0;
        for (const seg of segs) {
          for (let subIdx = 0; subIdx < seg.subtitles.length; subIdx += 1) {
            const old = seg.subtitles[subIdx]!;
            const next = replacer(old.text);
            if (next !== old.text) {
              seg.subtitles[subIdx] = makeSubtitleEntry({
                id: old.id,
                relativeStart: old.relativeStart,
                relativeDuration: old.relativeDuration,
                text: next,
                speakerID: old.speakerID,
                translations: { ...old.translations },
                runs: undefined,
                wordTimings: undefined,
                styleOverride: old.styleOverride,
              });
              changed += 1;
            }
          }
        }
        if (changed > 0) {
          applied += 1;
        } else {
          skipped += 1;
        }
        break;
      }

      default: {
        // Exhaustiveness guard — every AIAction case is handled above.
        const _never: never = action;
        void _never;
        skipped += 1;
        break;
      }
    }
  }

  return { segments: segs, appliedCount: applied, skippedCount: skipped, warnings };
}

/**
 * Convenience: apply a batch to a `Project`'s primary video track and return a
 * new Project value plus the apply stats. Mirrors how the macOS ViewModel
 * commits `AIActionExecutor.apply` back onto `timelineSegments`.
 */
export function applyActionBatchToProject(
  project: Project,
  batch: AIActionBatch,
  options: ApplyOptions = {},
): { project: Project; result: ApplyResult } {
  const newID = options.newID ?? randomUUID;
  const result = applyActionBatch(batch, primarySegments(project), options);
  const next = withPrimarySegments(project, result.segments, newID);
  return { project: next, result };
}

// MARK: - Formatting (parity with AIActionExecutor.formatTime/formatRate)

export function formatTime(seconds: number): string {
  const totalMilliseconds = Math.round(seconds * 1000);
  const totalSeconds = Math.trunc(totalMilliseconds / 1000);
  const minutes = Math.trunc(totalSeconds / 60);
  const secs = totalSeconds % 60;
  const milliseconds = totalMilliseconds % 1000;
  if (milliseconds === 0) {
    return `${minutes}:${pad2(secs)}`;
  }
  return `${minutes}:${pad2(secs)}.${pad3(milliseconds)}`;
}

export function formatRate(rate: number): string {
  if (Math.abs(Math.round(rate) - rate) < 0.001) {
    return rate.toFixed(0);
  }
  return rate.toFixed(2);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

// MARK: - Composed-range helpers

function deleteComposedRange(
  range: TimeRange,
  segments: readonly TimelineSegment[],
  transcriptLookup: TranscriptLookup,
  newID: () => string,
): TimelineSegment[] | null {
  const normalizedRange = normalize(range, segments);
  if (!normalizedRange) return null;

  const result: TimelineSegment[] = [];
  let composedOffset = 0;
  let changed = false;

  for (const segment of segments) {
    const segmentStart = composedOffset;
    const segmentEnd = composedOffset + durationSeconds(segment);
    composedOffset = segmentEnd; // == Swift `defer { composedOffset = segmentEnd }`

    const overlapStart = Math.max(normalizedRange.startSeconds, segmentStart);
    const overlapEnd = Math.min(normalizedRange.endSeconds, segmentEnd);
    if (!(overlapEnd > overlapStart + 0.001)) {
      result.push(segment);
      continue;
    }

    changed = true;

    if (overlapStart > segmentStart + 0.001) {
      const leftEndSource = sourceTime(segment, segmentStart, overlapStart);
      const left = makeDerivedSegment({
        original: segment,
        range: makeTimeRange(segment.range.startSeconds, leftEndSource),
        transcriptLookup,
        newID,
      });
      if (left) result.push(left);
    }

    if (overlapEnd < segmentEnd - 0.001) {
      const rightStartSource = sourceTime(segment, segmentStart, overlapEnd);
      const right = makeDerivedSegment({
        original: segment,
        range: makeTimeRange(rightStartSource, segment.range.endSeconds),
        transcriptLookup,
        newID,
      });
      if (right) result.push(right);
    }
  }

  return changed ? result : null;
}

interface InsertSourceClipArgs {
  sourceVideoID: string;
  sourceStart: number;
  sourceEnd: number;
  composedInsertAt: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  segments: readonly TimelineSegment[];
  transcriptLookup: TranscriptLookup;
  newID: () => string;
}

function insertSourceClip(args: InsertSourceClipArgs): TimelineSegment[] | null {
  const { sourceVideoID, sourceStart, sourceEnd, composedInsertAt, segments, transcriptLookup, newID } =
    args;

  const clipDuration = sourceEnd - sourceStart;
  if (!(clipDuration > 0.01)) return null;
  if (!(sourceEnd > sourceStart)) return null;

  const clipRange = makeTimeRange(sourceStart, sourceEnd);
  const subtitles = transcriptLookup([clipRange], sourceVideoID);
  const text = buildText(subtitles, "");

  const halfDuration = clipDuration / 2;
  const safeFadeIn = Math.max(0, Math.min(args.fadeInSeconds, halfDuration));
  const safeFadeOut = Math.max(0, Math.min(args.fadeOutSeconds, halfDuration));

  const newSegment = makeTimelineSegment({
    id: newID(),
    sourceVideoID,
    range: clipRange,
    text,
    subtitles,
  });
  newSegment.effects.audioFadeInDuration = safeFadeIn;
  newSegment.effects.audioFadeOutDuration = safeFadeOut;

  const totalDuration = segments.reduce((acc, s) => acc + durationSeconds(s), 0);
  const clamped = Math.max(0, Math.min(composedInsertAt, totalDuration));

  let composedOffset = 0;
  let inserted = false;
  const result: TimelineSegment[] = [];

  for (const segment of segments) {
    const segmentStart = composedOffset;
    const segmentEnd = composedOffset + durationSeconds(segment);
    composedOffset = segmentEnd;

    // Land before this segment? Insert the new clip first (then fall through to
    // also append the segment itself — no `continue` here, matching Swift).
    if (!inserted && clamped <= segmentStart + 0.001) {
      result.push(newSegment);
      inserted = true;
    }

    // Land strictly inside this segment? Split host, insert in the middle.
    if (!inserted && clamped > segmentStart + 0.001 && clamped < segmentEnd - 0.001) {
      const cutSourceTime = sourceTime(segment, segmentStart, clamped);
      const leftRange = makeTimeRange(segment.range.startSeconds, cutSourceTime);
      const rightRange = makeTimeRange(cutSourceTime, segment.range.endSeconds);
      const left = makeDerivedSegment({ original: segment, range: leftRange, transcriptLookup, newID });
      const right = makeDerivedSegment({ original: segment, range: rightRange, transcriptLookup, newID });
      if (left && right) {
        // Clear interior-edge fades so host fades don't bleed into the splice.
        left.effects.audioFadeOutDuration = 0;
        right.effects.audioFadeInDuration = 0;
        result.push(left, newSegment, right);
        inserted = true;
        continue;
      }
      // Split failed (degenerate fragment) — fall through and append original.
    }

    result.push(segment);
  }

  if (!inserted) {
    result.push(newSegment);
  }

  return result;
}

function setSpeedForComposedRange(
  range: TimeRange,
  rate: number,
  segments: readonly TimelineSegment[],
  transcriptLookup: TranscriptLookup,
  newID: () => string,
): TimelineSegment[] | null {
  const normalizedRange = normalize(range, segments);
  if (!normalizedRange) return null;

  const clampedRate = clampRate(rate);
  const result: TimelineSegment[] = [];
  let composedOffset = 0;
  let changed = false;

  for (const segment of segments) {
    const segmentStart = composedOffset;
    const segmentEnd = composedOffset + durationSeconds(segment);
    composedOffset = segmentEnd;

    const overlapStart = Math.max(normalizedRange.startSeconds, segmentStart);
    const overlapEnd = Math.min(normalizedRange.endSeconds, segmentEnd);
    if (!(overlapEnd > overlapStart + 0.001)) {
      result.push(segment);
      continue;
    }

    if (!(Math.abs(normalizedSpeedRate(segment) - clampedRate) > 0.001)) {
      result.push(segment);
      continue;
    }

    changed = true;

    const fullyCovered =
      overlapStart <= segmentStart + 0.001 && overlapEnd >= segmentEnd - 0.001;
    if (fullyCovered) {
      const updated = cloneTimelineSegment(segment);
      updated.speedRate = clampedRate;
      result.push(updated);
      continue;
    }

    if (overlapStart > segmentStart + 0.001) {
      const leftEndSource = sourceTime(segment, segmentStart, overlapStart);
      const left = makeDerivedSegment({
        original: segment,
        range: makeTimeRange(segment.range.startSeconds, leftEndSource),
        transcriptLookup,
        newID,
      });
      if (left) result.push(left);
    }

    const middleStartSource = sourceTime(segment, segmentStart, overlapStart);
    const middleEndSource = sourceTime(segment, segmentStart, overlapEnd);
    const middle = makeDerivedSegment({
      original: segment,
      range: makeTimeRange(middleStartSource, middleEndSource),
      speedRate: clampedRate,
      transcriptLookup,
      newID,
    });
    if (middle) result.push(middle);

    if (overlapEnd < segmentEnd - 0.001) {
      const rightStartSource = sourceTime(segment, segmentStart, overlapEnd);
      const right = makeDerivedSegment({
        original: segment,
        range: makeTimeRange(rightStartSource, segment.range.endSeconds),
        transcriptLookup,
        newID,
      });
      if (right) result.push(right);
    }
  }

  return changed ? result : null;
}

function normalize(range: TimeRange, segments: readonly TimelineSegment[]): TimeRange | null {
  const totalDuration = segments.reduce((acc, s) => acc + durationSeconds(s), 0);
  if (!(totalDuration > 0)) return null;

  const lower = Math.max(0, Math.min(range.startSeconds, range.endSeconds));
  const upper = Math.min(totalDuration, Math.max(range.startSeconds, range.endSeconds));
  if (!(upper > lower + 0.05)) return null;

  return makeTimeRange(lower, upper);
}

function sourceTime(
  segment: TimelineSegment,
  segmentComposedStart: number,
  composedTime: number,
): number {
  const clamped = Math.max(
    segmentComposedStart,
    Math.min(composedTime, segmentComposedStart + durationSeconds(segment)),
  );
  const relativeComposedTime = clamped - segmentComposedStart;
  const t = segment.range.startSeconds + relativeComposedTime * normalizedSpeedRate(segment);
  return Math.max(segment.range.startSeconds, Math.min(t, segment.range.endSeconds));
}

interface MakeDerivedSegmentArgs {
  original: TimelineSegment;
  id?: string;
  range: TimeRange;
  speedRate?: number;
  transcriptLookup: TranscriptLookup;
  newID: () => string;
}

function makeDerivedSegment(args: MakeDerivedSegmentArgs): TimelineSegment | null {
  const { original, id, range, speedRate, transcriptLookup, newID } = args;
  if (!(range.endSeconds > range.startSeconds + 0.01)) {
    return null;
  }

  const subtitles = transcriptLookup([range], original.sourceVideoID);
  const text = buildText(subtitles, original.text);
  const segment = makeTimelineSegment({
    id: id ?? newID(),
    sourceVideoID: original.sourceVideoID,
    range: makeTimeRange(range.startSeconds, range.endSeconds),
    text,
    subtitles,
  });
  segment.volumeLevel = original.volumeLevel;
  segment.speedRate = speedRate ?? original.speedRate;
  segment.effects = cloneSegmentEffects(original.effects);
  segment.alternatives = original.alternatives.map(cloneAlternativeTake);
  return segment;
}

function buildText(subtitles: readonly SubtitleEntry[], fallback: string): string {
  const joined = subtitles
    .map((s) => s.text)
    .join(" ")
    .trim();
  return joined.length === 0 ? fallback : joined;
}

function clampRate(rate: number): number {
  return Math.max(MINIMUM_SPEED_RATE, Math.min(rate, MAXIMUM_SPEED_RATE));
}

// MARK: - Subtitle helpers

/**
 * Finds the subtitle whose composed time-range contains `composedSeconds`.
 * Mirrors `AIActionExecutor.locateSubtitle`. SubtitleEntry relative times are
 * source-time (pre-speed); composed-time within a segment is source-time
 * divided by the segment's speed rate.
 */
export function locateSubtitle(
  composedSeconds: number,
  segments: readonly TimelineSegment[],
): string | null {
  let composedOffset = 0;
  for (const segment of segments) {
    const segmentStart = composedOffset;
    const segmentEnd = composedOffset + durationSeconds(segment);
    composedOffset = segmentEnd;
    if (!(composedSeconds >= segmentStart && composedSeconds < segmentEnd)) {
      continue;
    }
    const within = composedSeconds - segmentStart;
    const speed = normalizedSpeedRate(segment);
    for (const entry of segment.subtitles) {
      const s = entry.relativeStart / speed;
      const e = (entry.relativeStart + entry.relativeDuration) / speed;
      if (within >= s && within < e) return entry.id;
    }
  }
  return null;
}

export function findSubtitle(
  id: string,
  segments: readonly TimelineSegment[],
): { segment: number; entry: number } | null {
  for (let segIdx = 0; segIdx < segments.length; segIdx += 1) {
    const entryIdx = segments[segIdx]!.subtitles.findIndex((e) => e.id === id);
    if (entryIdx >= 0) {
      return { segment: segIdx, entry: entryIdx };
    }
  }
  return null;
}

/**
 * Returns a closure applying the find/replace rule to a single string.
 * Mirrors `AIActionExecutor.makeReplacer`.
 *
 * Swift uses ICU `NSRegularExpression`; JS `RegExp` differs in two ways that we
 * bridge here so regex-mode `replaceSubtitleText` stays parity-faithful for the
 * documented use cases:
 *   1. ICU accepts a leading bare inline flag-setter group like `(?i)` /
 *      `(?ims)` (the Swift doc-comment names `(?i)` as the case-insensitivity
 *      mechanism). JS has scoped modifier groups `(?i:…)` but not the bare form,
 *      so we lift a leading `(?flags)` into JS RegExp flags.
 *   2. ICU `$0` (whole match) is `$&` in JS templates; we translate it.
 * A pattern using an inline flag we cannot faithfully map (e.g. ICU `x`
 * extended mode) is left untouched and will fail to compile → null → skip,
 * matching the Swift "skip on bad pattern" posture.
 */
export function makeReplacer(
  find: string,
  replaceWith: string,
  isRegex: boolean,
): ((text: string) => string) | null {
  if (isRegex) {
    const { source, flags } = extractLeadingInlineFlags(find);
    let regex: RegExp;
    try {
      regex = new RegExp(source, `g${flags}`);
    } catch {
      return null;
    }
    const template = translateReplacementTemplate(replaceWith);
    return (text) => text.replace(regex, template);
  }
  return (text) => text.split(find).join(replaceWith);
}

/** ICU inline flags that map cleanly onto JS RegExp flags. */
const MAPPABLE_INLINE_FLAGS: Record<string, string> = { i: "i", m: "m", s: "s", u: "u" };

/**
 * Lifts a leading ICU inline flag-setter group `(?<letters>)` into JS RegExp
 * flags. Returns the stripped source + mapped flags. If there is no such leading
 * group, or any letter is unmappable, returns the source unchanged with no extra
 * flags (so an exotic pattern still fails closed → skip). A scoped modifier
 * group like `(?i:…)` is left untouched (the `)` won't immediately follow the
 * letters), since modern JS handles those natively.
 */
function extractLeadingInlineFlags(pattern: string): { source: string; flags: string } {
  const match = /^\(\?([a-zA-Z]+)\)/.exec(pattern);
  if (!match) return { source: pattern, flags: "" };
  const letters = match[1]!;
  let mapped = "";
  for (const ch of letters) {
    const js = MAPPABLE_INLINE_FLAGS[ch];
    if (!js) return { source: pattern, flags: "" };
    if (!mapped.includes(js)) mapped += js;
  }
  return { source: pattern.slice(match[0].length), flags: mapped };
}

/** Translate ICU `$0` (whole match) to JS `$&`, leaving `$1..$n` and `$$` alone. */
function translateReplacementTemplate(template: string): string {
  // Replacement is `$$&` so the literal characters `$&` are emitted (a bare
  // `$&` here would itself mean "the matched substring").
  return template.replace(/\$0(?!\d)/g, "$$&");
}
