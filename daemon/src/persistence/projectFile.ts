/**
 * project.json — the daemon's single source of truth on disk.
 *
 * Schema is the flat, Codable-friendly shape modelled on Swift
 * `EditorRevision.PersistableTrack/PersistableSegment/PersistableSubtitle`
 * (EditorRevision.swift). Differences from the Swift revision format, on
 * purpose (the daemon owns this schema):
 *   - a top-level `version` for forward migration;
 *   - `effects` IS persisted (Swift revisions drop it and reset to default on
 *     reload — we keep it so insertSourceClip fades and color tweaks round-trip).
 *
 * Conversions mirror `PersistableSegment.toTimelineSegment` /
 * `PersistableTrack.toTrack` defaults exactly (isLocked ?? false, speedRate ??
 * 1.0, translations ?? {}, isVideoHidden ?? false, alternatives ?? []).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { Project, Track, TrackKind } from "../model/project";
import { makeTrack } from "../model/project";
import type { TimelineSegment } from "../model/timelineSegment";
import { makeTimelineSegment } from "../model/timelineSegment";
import type { SegmentEffects } from "../model/segmentEffects";
import { defaultSegmentEffects, cloneSegmentEffects } from "../model/segmentEffects";
import type { SubtitleEntry, WordTiming } from "../model/subtitle";
import { makeSubtitleEntry } from "../model/subtitle";
import type { AlternativeTake } from "../model/alternativeTake";

export const PROJECT_FILE_VERSION = 1 as const;

const TRACK_KINDS: readonly TrackKind[] = ["video", "audio", "overlay"];

export interface PersistableSubtitle {
  id: string;
  relativeStart: number;
  relativeDuration: number;
  text: string;
  speakerID?: number;
  translations?: Record<string, string>;
  runs?: unknown;
  wordTimings?: WordTiming[];
  styleOverride?: unknown;
}

export interface PersistableSegment {
  id: string;
  sourceVideoID: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  volumeLevel: number;
  speedRate: number;
  isVideoHidden?: boolean;
  placementOffset?: number;
  subtitles?: PersistableSubtitle[];
  alternatives?: AlternativeTake[];
  linkedSegmentID?: string;
  pipLayout?: unknown;
  overlaySpec?: unknown;
  effects?: SegmentEffects;
}

export interface PersistableTrack {
  id: string;
  kind: string; // "video" | "audio" | "overlay"
  name: string;
  isMuted: boolean;
  isSolo: boolean;
  isLocked?: boolean;
  segments: PersistableSegment[];
}

export interface PersistableProject {
  version: number;
  tracks: PersistableTrack[];
}

// MARK: - runtime -> persistable

function toPersistableSubtitle(e: SubtitleEntry): PersistableSubtitle {
  const out: PersistableSubtitle = {
    id: e.id,
    relativeStart: e.relativeStart,
    relativeDuration: e.relativeDuration,
    text: e.text,
  };
  if (e.speakerID !== undefined) out.speakerID = e.speakerID;
  if (Object.keys(e.translations).length > 0) out.translations = { ...e.translations };
  if (e.runs !== undefined) out.runs = e.runs;
  if (e.wordTimings !== undefined) out.wordTimings = e.wordTimings.map((w) => ({ ...w }));
  if (e.styleOverride !== undefined) out.styleOverride = e.styleOverride;
  return out;
}

function toPersistableSegment(s: TimelineSegment): PersistableSegment {
  const out: PersistableSegment = {
    id: s.id,
    sourceVideoID: s.sourceVideoID,
    startSeconds: s.range.startSeconds,
    endSeconds: s.range.endSeconds,
    text: s.text,
    volumeLevel: s.volumeLevel,
    speedRate: s.speedRate,
    effects: cloneSegmentEffects(s.effects),
  };
  if (s.isVideoHidden) out.isVideoHidden = true;
  if (s.placementOffset !== undefined) out.placementOffset = s.placementOffset;
  if (s.subtitles.length > 0) out.subtitles = s.subtitles.map(toPersistableSubtitle);
  if (s.alternatives.length > 0) out.alternatives = s.alternatives.map((a) => ({ ...a }));
  if (s.linkedSegmentID !== undefined) out.linkedSegmentID = s.linkedSegmentID;
  if (s.pipLayout !== undefined) out.pipLayout = s.pipLayout;
  if (s.overlaySpec !== undefined) out.overlaySpec = s.overlaySpec;
  return out;
}

function toPersistableTrack(t: Track): PersistableTrack {
  return {
    id: t.id,
    kind: t.kind,
    name: t.name,
    isMuted: t.isMuted,
    isSolo: t.isSolo,
    isLocked: t.isLocked,
    segments: t.segments.map(toPersistableSegment),
  };
}

export function toPersistableProject(project: Project): PersistableProject {
  return {
    version: PROJECT_FILE_VERSION,
    tracks: project.tracks.map(toPersistableTrack),
  };
}

// MARK: - persistable -> runtime

function fromPersistableSubtitle(p: PersistableSubtitle): SubtitleEntry {
  return makeSubtitleEntry({
    id: p.id,
    relativeStart: p.relativeStart,
    relativeDuration: p.relativeDuration,
    text: p.text,
    speakerID: p.speakerID,
    translations: p.translations ?? {},
    runs: p.runs,
    wordTimings: p.wordTimings,
    styleOverride: p.styleOverride,
  });
}

function fromPersistableSegment(p: PersistableSegment): TimelineSegment {
  const seg = makeTimelineSegment({
    id: p.id,
    sourceVideoID: p.sourceVideoID,
    range: { startSeconds: p.startSeconds, endSeconds: p.endSeconds },
    text: p.text,
    subtitles: (p.subtitles ?? []).map(fromPersistableSubtitle),
    volumeLevel: p.volumeLevel,
    speedRate: p.speedRate ?? 1.0,
    isVideoHidden: p.isVideoHidden ?? false,
    placementOffset: p.placementOffset,
    alternatives: (p.alternatives ?? []).map((a) => ({ ...a })),
    linkedSegmentID: p.linkedSegmentID,
    pipLayout: p.pipLayout,
    overlaySpec: p.overlaySpec,
    effects: p.effects ? cloneSegmentEffects(p.effects) : defaultSegmentEffects(),
  });
  return seg;
}

function fromPersistableTrack(p: PersistableTrack): Track {
  const kind: TrackKind = (TRACK_KINDS as readonly string[]).includes(p.kind)
    ? (p.kind as TrackKind)
    : "video";
  return makeTrack({
    id: p.id,
    kind,
    name: p.name,
    isMuted: p.isMuted,
    isSolo: p.isSolo,
    isLocked: p.isLocked ?? false,
    segments: p.segments.map(fromPersistableSegment),
  });
}

export function fromPersistableProject(p: PersistableProject): Project {
  return { tracks: p.tracks.map(fromPersistableTrack) };
}

// MARK: - file IO

export function serializeProject(project: Project): string {
  return JSON.stringify(toPersistableProject(project), null, 2) + "\n";
}

export function deserializeProject(json: string): Project {
  const parsed = JSON.parse(json) as PersistableProject;
  if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.tracks)) {
    throw new Error("project.json: malformed (expected { version, tracks: [...] })");
  }
  return fromPersistableProject(parsed);
}

export async function loadProject(path: string): Promise<Project> {
  const json = await readFile(path, "utf8");
  return deserializeProject(json);
}

export async function saveProject(path: string, project: Project): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeProject(project), "utf8");
}
