/**
 * Per-segment visual and audio effects.
 *
 * Ported from `CuttiKit.SegmentEffects` (AICopilotMetadata.swift). The Swift
 * struct exposes default-valued stored properties; we model the same defaults
 * via `defaultSegmentEffects()`. Only `audioFadeInDuration` /
 * `audioFadeOutDuration` are touched by the in-scope action set
 * (`insertSourceClip` sets them; the mid-segment splice clears interior-edge
 * fades), but every field is carried so derived/round-tripped segments stay
 * faithful.
 */
export interface SegmentEffects {
  /** Rotation in degrees (0, 90, 180, 270). */
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  /** Color adjustments — CIColorControls parameters. */
  brightness: number; // -1 to 1
  contrast: number; // 0 to 2
  saturation: number; // 0 to 2
  /** Audio fade durations in seconds. */
  audioFadeInDuration: number;
  audioFadeOutDuration: number;
}

/** Equivalent of `SegmentEffects.default` in Swift. */
export function defaultSegmentEffects(): SegmentEffects {
  return {
    rotation: 0,
    flipHorizontal: false,
    flipVertical: false,
    brightness: 0,
    contrast: 1,
    saturation: 1,
    audioFadeInDuration: 0,
    audioFadeOutDuration: 0,
  };
}

export function cloneSegmentEffects(e: SegmentEffects): SegmentEffects {
  return { ...e };
}

/** Mirrors `SegmentEffects.isDefault`. */
export function isDefaultSegmentEffects(e: SegmentEffects): boolean {
  const d = defaultSegmentEffects();
  return (
    e.rotation === d.rotation &&
    e.flipHorizontal === d.flipHorizontal &&
    e.flipVertical === d.flipVertical &&
    e.brightness === d.brightness &&
    e.contrast === d.contrast &&
    e.saturation === d.saturation &&
    e.audioFadeInDuration === d.audioFadeInDuration &&
    e.audioFadeOutDuration === d.audioFadeOutDuration
  );
}
