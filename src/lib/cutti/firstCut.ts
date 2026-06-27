/**
 * Desktop bridge: transcript → real keep/cut → openscreen regions.
 *
 * The keep/cut logic lives in `@foxscreen/cutti-core` (`runFirstCut` /
 * `runFirstCutAI`, the heuristic + LLM deciders, the real `applyActionBatch`
 * executor). This thin layer maps the edited flat project the core returns into
 * openscreen `CuttiRegions` (via the renderer-coupled `adapter`), so the
 * timeline shows the output of cutti's real engine. The pure helpers are
 * re-exported so existing call sites + tests keep importing them from here.
 */

import {
	type CaptionSegment,
	type CuttiLlmConfig,
	captionsToSegments,
	cutIndicesToBatch,
	heuristicCutBatch,
	runFirstCut,
	runFirstCutAI,
} from "@foxscreen/cutti-core";
import { type CuttiRegions, cuttiToRegions } from "./adapter";

export { captionsToSegments, cutIndicesToBatch, heuristicCutBatch };

export interface FirstCutResult {
	regions: CuttiRegions;
	/** Phrases transcribed. */
	total: number;
	/** Phrases the executor actually dropped. */
	applied: number;
	skipped: number;
}

/**
 * Transcript → first cut → openscreen regions, via the real cutti executor.
 * `decide` lets callers swap the heuristic for an LLM-produced batch.
 */
export function transcriptToFirstCut(
	captions: CaptionSegment[],
	sourceVideoID: string,
	decide?: Parameters<typeof runFirstCut>[2],
): FirstCutResult {
	const core = runFirstCut(captions, sourceVideoID, decide);
	return {
		regions: cuttiToRegions(core.flat),
		total: core.total,
		applied: core.applied,
		skipped: core.skipped,
	};
}

/** Transcript → bring-your-own-key LLM keep/cut → openscreen regions, via the real executor. */
export async function transcriptToFirstCutAI(
	captions: CaptionSegment[],
	sourceVideoID: string,
	config: CuttiLlmConfig,
	fetchImpl?: typeof fetch,
): Promise<FirstCutResult> {
	const core = await runFirstCutAI(captions, sourceVideoID, config, fetchImpl);
	return {
		regions: cuttiToRegions(core.flat),
		total: core.total,
		applied: core.applied,
		skipped: core.skipped,
	};
}
