/**
 * A half-open-ish source-time interval `[startSeconds, endSeconds)`.
 *
 * Ported from `CuttiKit.TimeRange` (AICopilotMetadata.swift). Times are in
 * **source-video seconds** (pre-speed) whenever a `TimeRange` lives on a
 * `TimelineSegment.range`; the composed-timeline-vs-source mapping is done
 * by the executor's `sourceTime` math, never by the range itself.
 */
export interface TimeRange {
  startSeconds: number;
  endSeconds: number;
}

export function makeTimeRange(startSeconds: number, endSeconds: number): TimeRange {
  return { startSeconds, endSeconds };
}
