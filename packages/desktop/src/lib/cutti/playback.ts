/**
 * trim enforcement for preview (step 3 of full cutti), the low-risk way.
 *
 * openscreen plays the full source continuously and does NOT enforce trim. cutti
 * TrimRegions are the KEPT source spans. Instead of rewriting openscreen's 2167-
 * line playback clock, we let it keep playing and just SKIP the cut gaps: when the
 * playhead lands in a removed region, seek to the next kept span; past the last
 * kept span, stop. When there are no trim regions this is a strict no-op, so
 * openscreen's default behaviour is untouched.
 */

import type { TrimRegion } from "@/components/video-editor/types";

export interface KeptSpan {
	startSec: number;
	endSec: number;
}

/** TrimRegions (kept spans, ms) → sorted, de-degenerated kept spans in seconds. */
export function keptSpansFromTrim(trimRegions: TrimRegion[]): KeptSpan[] {
	return trimRegions
		.map((r) => ({ startSec: r.startMs / 1000, endSec: r.endMs / 1000 }))
		.filter((s) => s.endSec > s.startSec)
		.sort((a, b) => a.startSec - b.startSec);
}

export type PlaybackDecision = { kind: "play" } | { kind: "seek"; toSec: number } | { kind: "end" };

/**
 * Given the current source-time playhead and the kept spans, decide whether to
 * keep playing, skip forward to the next kept span (a cut), or stop (past the
 * end). `eps` gives a little slack at span starts so a post-seek landing counts
 * as "inside".
 */
export function decidePlayback(
	currentSec: number,
	spans: KeptSpan[],
	eps = 0.02,
): PlaybackDecision {
	if (spans.length === 0) return { kind: "play" };
	for (const s of spans) {
		if (currentSec >= s.startSec - eps && currentSec < s.endSec) return { kind: "play" };
	}
	for (const s of spans) {
		if (s.startSec > currentSec) return { kind: "seek", toSec: s.startSec };
	}
	return { kind: "end" };
}
