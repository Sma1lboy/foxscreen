/**
 * A single segment in the timeline, representing one AI-kept range or a
 * user-added range.
 *
 * Ported from `CuttiKit.TimelineSegment` (AICopilotMetadata.swift). Only the
 * fields the in-scope action set + persistence touch are modelled as first
 * class; the rest of the Swift struct (pipLayout, freeTransform, overlaySpec,
 * linkedSegmentID, placementOffset, isVideoHidden) are carried so split/trim
 * derivations and project.json round-trips stay faithful.
 *
 * Speed semantics (1:1 with Swift):
 *   normalizedSpeedRate = clamp(speedRate, MIN, MAX)
 *   sourceDurationSeconds = range.end - range.start         (source/pre-speed)
 *   durationSeconds       = sourceDurationSeconds / normalizedSpeedRate  (composed)
 */

import type { AlternativeTake } from "./alternativeTake";
import { cloneAlternativeTake } from "./alternativeTake";
import type { SegmentEffects } from "./segmentEffects";
import { cloneSegmentEffects, defaultSegmentEffects } from "./segmentEffects";
import type { SubtitleEntry } from "./subtitle";
import { cloneSubtitleEntry } from "./subtitle";
import type { TimeRange } from "./timeRange";

export const MINIMUM_SPEED_RATE = 0.25;
export const MAXIMUM_SPEED_RATE = 4.0;

export interface TimelineSegment {
	id: string;
	/** Which source video this segment comes from. */
	sourceVideoID: string;
	range: TimeRange;
	text: string;
	subtitles: SubtitleEntry[];
	/** Per-segment volume level (0.0 = mute, 1.0 = full). */
	volumeLevel: number;
	/** Video hidden from composition (audio still plays, duration preserved). */
	isVideoHidden: boolean;
	/** Per-segment playback speed (1.0 = normal, 2.0 = 2x faster). */
	speedRate: number;
	effects: SegmentEffects;
	/** Composed-time anchor override (overlay/B-roll tracks). undefined = flow. */
	placementOffset?: number;
	alternatives: AlternativeTake[];
	/** Audio-detach two-way link UUID; undefined for regular segments. */
	linkedSegmentID?: string;
	/** Opaque PiP layout (overlay tracks). Carried through persistence. */
	pipLayout?: unknown;
	/** Opaque AI overlay render spec. Carried through persistence. */
	overlaySpec?: unknown;
}

export interface MakeTimelineSegmentArgs {
	id: string;
	sourceVideoID: string;
	range: TimeRange;
	text: string;
	subtitles: SubtitleEntry[];
	volumeLevel?: number;
	isVideoHidden?: boolean;
	speedRate?: number;
	effects?: SegmentEffects;
	placementOffset?: number;
	alternatives?: AlternativeTake[];
	linkedSegmentID?: string;
	pipLayout?: unknown;
	overlaySpec?: unknown;
}

/** Mirrors the Swift `TimelineSegment.init` defaults. */
export function makeTimelineSegment(args: MakeTimelineSegmentArgs): TimelineSegment {
	return {
		id: args.id,
		sourceVideoID: args.sourceVideoID,
		range: { ...args.range },
		text: args.text,
		subtitles: args.subtitles,
		volumeLevel: args.volumeLevel ?? 1.0,
		isVideoHidden: args.isVideoHidden ?? false,
		speedRate: args.speedRate ?? 1.0,
		effects: args.effects ?? defaultSegmentEffects(),
		placementOffset: args.placementOffset,
		alternatives: args.alternatives ?? [],
		linkedSegmentID: args.linkedSegmentID,
		pipLayout: args.pipLayout,
		overlaySpec: args.overlaySpec,
	};
}

/** Mirrors `TimelineSegment.normalizedSpeedRate`. */
export function normalizedSpeedRate(seg: TimelineSegment): number {
	return Math.max(MINIMUM_SPEED_RATE, Math.min(seg.speedRate, MAXIMUM_SPEED_RATE));
}

/** Mirrors `TimelineSegment.sourceDurationSeconds`. */
export function sourceDurationSeconds(seg: TimelineSegment): number {
	return seg.range.endSeconds - seg.range.startSeconds;
}

/** Mirrors `TimelineSegment.durationSeconds` (composed/post-speed). */
export function durationSeconds(seg: TimelineSegment): number {
	return sourceDurationSeconds(seg) / normalizedSpeedRate(seg);
}

/** Deep copy used by the executor before in-place mutation (value semantics). */
export function cloneTimelineSegment(seg: TimelineSegment): TimelineSegment {
	return {
		id: seg.id,
		sourceVideoID: seg.sourceVideoID,
		range: { ...seg.range },
		text: seg.text,
		subtitles: seg.subtitles.map(cloneSubtitleEntry),
		volumeLevel: seg.volumeLevel,
		isVideoHidden: seg.isVideoHidden,
		speedRate: seg.speedRate,
		effects: cloneSegmentEffects(seg.effects),
		placementOffset: seg.placementOffset,
		alternatives: seg.alternatives.map(cloneAlternativeTake),
		linkedSegmentID: seg.linkedSegmentID,
		pipLayout: seg.pipLayout,
		overlaySpec: seg.overlaySpec,
	};
}
