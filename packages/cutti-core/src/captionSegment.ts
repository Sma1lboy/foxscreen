/**
 * A single transcribed phrase (or word) with its time span — the input unit the
 * cutti keep/cut pipeline reasons over. Matches the shape openscreen's Whisper
 * captioning produces (`CaptionSegment` in the renderer); cutti-core owns the
 * canonical definition so the engine, the CLI harness, and the desktop renderer
 * all agree on one type.
 */
export interface CaptionSegment {
	startSec: number;
	endSec: number;
	text: string;
}
