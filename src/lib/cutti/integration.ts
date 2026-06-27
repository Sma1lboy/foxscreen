/**
 * Desktop bridge: run the real cutti engine on the bundled demo, map the edited
 * result to openscreen regions.
 *
 * The edit itself (apply a real `AIActionBatch` through the ported
 * `applyActionBatch` executor) lives in `@foxscreen/cutti-core`
 * (`runDemoEditFlat`); here we only convert its edited flat project into
 * openscreen regions via the renderer-coupled `adapter`. The "cutti 字幕" button
 * calls this, so what lands on the timeline is cutti's real engine output.
 */

import { runDemoEditFlat } from "@foxscreen/cutti-core";
import { type CuttiRegions, cuttiToRegions } from "./adapter";

export interface CuttiEditResult {
	regions: CuttiRegions;
	applied: number;
	skipped: number;
}

/** Run a real cutti edit on the demo through the ported executor → openscreen regions. */
export function runCuttiDemoEdit(): CuttiEditResult {
	const core = runDemoEditFlat();
	return {
		regions: cuttiToRegions(core.flat),
		applied: core.applied,
		skipped: core.skipped,
	};
}
