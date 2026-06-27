/**
 * Crossfade transitions over clip overlaps — the standard-NLE transition model.
 *
 * Clips on a track may overlap (the timeline already allows dragging one clip so
 * it overlaps its neighbour). A {@link Transition} *marks* such an overlap as a
 * crossfade for export: the earlier-starting (outgoing) clip fades out while the
 * later-starting (incoming) clip fades in across their overlap window.
 *
 * MVP semantics (intentionally unambiguous + headlessly unit-testable):
 *  - A transition only references the two overlapping clips by id — the crossfade
 *    window is *derived* from the clips' current positions, so it stays correct as
 *    the clips are dragged/trimmed.
 *  - Adding/removing a transition never moves a clip.
 *  - If the user drags the clips apart so they no longer overlap (or deletes one),
 *    the transition becomes inert and is auto-dropped by {@link activeTransitions}.
 *  - Live Pixi preview is out of scope; transitions affect EXPORT + the timeline
 *    overlay only.
 *
 * Pure + render-agnostic so the selftest vitest can exercise every branch.
 */
import { clipEndSec, type TimelineClip } from "./clipModel";

/** Marks an overlap between two same-track clips as a crossfade. */
export interface Transition {
	id: string;
	/** Outgoing clip (the earlier-starting one — fades out 1→0). */
	fromClipId: string;
	/** Incoming clip (the later-starting one — fades in 0→1). */
	toClipId: string;
}

/** The derived crossfade window `[startSec, endSec]` of a transition (timeline seconds). */
export interface TransitionWindow {
	startSec: number;
	endSec: number;
}

let transitionCounter = 0;

/** Stable-ish unique id for a new transition. */
export function genTransitionId(): string {
	transitionCounter += 1;
	return `xfade-${Date.now().toString(36)}-${transitionCounter}`;
}

/**
 * Whether two clips genuinely overlap: same track AND their timeline spans
 * intersect with positive width. Touching edges (`a.end === b.start`) do NOT
 * count — there is nothing to blend. Pure.
 */
export function clipsOverlap(a: TimelineClip, b: TimelineClip): boolean {
	if (a.trackIndex !== b.trackIndex) return false;
	return a.startSec < clipEndSec(b) && b.startSec < clipEndSec(a);
}

/**
 * The crossfade window `[max(start), min(end)]` shared by two clips, or `null`
 * when they don't overlap (different track, disjoint, or zero-width touch). Pure.
 */
export function overlapWindow(a: TimelineClip, b: TimelineClip): TransitionWindow | null {
	if (a.trackIndex !== b.trackIndex) return null;
	const startSec = Math.max(a.startSec, b.startSec);
	const endSec = Math.min(clipEndSec(a), clipEndSec(b));
	if (endSec - startSec <= 0) return null;
	return { startSec, endSec };
}

/**
 * Every same-track overlapping pair among `clips`, each ordered so `from` is the
 * earlier-starting (outgoing) clip and `to` the later-starting (incoming) one.
 * Ties on `startSec` are broken by id so ordering is stable. Each unordered pair
 * appears at most once. Pure — the engine behind the timeline's "click to add
 * crossfade" affordances.
 */
export function findOverlappingPairs(
	clips: TimelineClip[],
): Array<{ from: TimelineClip; to: TimelineClip }> {
	const out: Array<{ from: TimelineClip; to: TimelineClip }> = [];
	for (let i = 0; i < clips.length; i++) {
		for (let j = i + 1; j < clips.length; j++) {
			const a = clips[i];
			const b = clips[j];
			if (!clipsOverlap(a, b)) continue;
			const aFirst = a.startSec < b.startSec || (a.startSec === b.startSec && a.id < b.id);
			out.push(aFirst ? { from: a, to: b } : { from: b, to: a });
		}
	}
	return out;
}

/** A transition resolved against the current clips: both clips + the live window. */
export interface ActiveTransition {
	transition: Transition;
	/** Outgoing clip (earlier start). */
	from: TimelineClip;
	/** Incoming clip (later start). */
	to: TimelineClip;
	window: TransitionWindow;
}

/**
 * Resolve the transitions that are still live: both referenced clips exist and
 * still overlap. Each returned entry carries the two clips ordered `from`
 * (earlier start) / `to` (later start) plus the freshly derived window, so the
 * blend stays correct no matter how the clips were moved since the transition was
 * added. Transitions whose clips are gone or no longer overlap are dropped. Pure.
 */
export function activeTransitions(
	transitions: Transition[],
	clips: TimelineClip[],
): ActiveTransition[] {
	const byId = new Map(clips.map((c) => [c.id, c]));
	const out: ActiveTransition[] = [];
	for (const transition of transitions) {
		const a = byId.get(transition.fromClipId);
		const b = byId.get(transition.toClipId);
		if (!a || !b) continue;
		const window = overlapWindow(a, b);
		if (!window) continue;
		// Re-derive from/to by start time so the fade direction follows the clips
		// even if they were dragged past each other.
		const aFirst = a.startSec < b.startSec || (a.startSec === b.startSec && a.id <= b.id);
		out.push({
			transition,
			from: aFirst ? a : b,
			to: aFirst ? b : a,
			window,
		});
	}
	return out;
}

/**
 * Linear crossfade alphas at an absolute timeline time within a window:
 * `outgoing = 1 - (t - start) / (end - start)` clamped to `[0, 1]`, and
 * `incoming = 1 - outgoing`. At the window start the outgoing clip is fully
 * opaque (1) and the incoming fully transparent (0); at the end they swap; the
 * midpoint is 0.5/0.5. A zero-width window yields a hard cut (outgoing 0). Pure.
 */
export function crossfadeAlpha(
	window: TransitionWindow,
	t: number,
): { outgoing: number; incoming: number } {
	const span = window.endSec - window.startSec;
	if (span <= 0) return { outgoing: 0, incoming: 1 };
	const progress = Math.max(0, Math.min(1, (t - window.startSec) / span));
	const outgoing = 1 - progress;
	return { outgoing, incoming: 1 - outgoing };
}

/**
 * The active transition on `trackIndex` whose window contains `sec`
 * (`start <= sec < end`), or `null`. Pure — used by playback/export to decide
 * "are we inside a crossfade right now?".
 */
export function transitionAt(
	transitions: Transition[],
	clips: TimelineClip[],
	trackIndex: number,
	sec: number,
): ActiveTransition | null {
	for (const active of activeTransitions(transitions, clips)) {
		if (active.from.trackIndex !== trackIndex) continue;
		if (sec >= active.window.startSec && sec < active.window.endSec) return active;
	}
	return null;
}
