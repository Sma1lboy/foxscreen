/**
 * Read-side projection of a Project for UIs / the HTTP API. Keeps the wire
 * shape flat and pre-computes composed durations so clients don't need the
 * speed math. This is the DTO the cutti editor UI renders.
 */

import type { Project } from "./model/project";
import { primarySegments, primaryVideoTrackIndex } from "./model/project";
import { durationSeconds, sourceDurationSeconds } from "./model/timelineSegment";

export interface SegmentView {
  id: string;
  sourceVideoID: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  speedRate: number;
  volumeLevel: number;
  isVideoHidden: boolean;
  /** Pre-speed (source) length. */
  sourceDurationSeconds: number;
  /** Post-speed length on the composed timeline. */
  composedDurationSeconds: number;
  subtitleCount: number;
}

export interface ProjectView {
  trackCount: number;
  primaryTrackName: string;
  composedDurationSeconds: number;
  segments: SegmentView[];
}

export function buildProjectView(project: Project): ProjectView {
  const segs = primarySegments(project);
  const idx = primaryVideoTrackIndex(project);
  const track = project.tracks[idx];
  const segments: SegmentView[] = segs.map((s) => ({
    id: s.id,
    sourceVideoID: s.sourceVideoID,
    startSeconds: s.range.startSeconds,
    endSeconds: s.range.endSeconds,
    text: s.text,
    speedRate: s.speedRate,
    volumeLevel: s.volumeLevel,
    isVideoHidden: s.isVideoHidden,
    sourceDurationSeconds: sourceDurationSeconds(s),
    composedDurationSeconds: durationSeconds(s),
    subtitleCount: s.subtitles.length,
  }));
  return {
    trackCount: project.tracks.length,
    primaryTrackName: track ? track.name : "V1",
    composedDurationSeconds: segments.reduce((acc, s) => acc + s.composedDurationSeconds, 0),
    segments,
  };
}
