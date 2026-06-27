import { describe, expect, it } from "vitest";
import type { TimelineClip } from "./clipModel";
import {
	activeTransitions,
	clipsOverlap,
	crossfadeAlpha,
	findOverlappingPairs,
	genTransitionId,
	overlapWindow,
	type Transition,
	transitionAt,
} from "./transitionModel";

function clip(over: Partial<TimelineClip> = {}): TimelineClip {
	return {
		id: "c1",
		assetId: "a1",
		name: "x.mp4",
		sourcePath: "/x.mp4",
		trackIndex: 0,
		startSec: 0,
		inSec: 0,
		outSec: 5,
		...over,
	};
}

describe("genTransitionId", () => {
	it("mints unique ids", () => {
		expect(genTransitionId()).not.toBe(genTransitionId());
	});
});

describe("clipsOverlap", () => {
	it("true for a genuine same-track overlap", () => {
		const a = clip({ id: "a", startSec: 0, inSec: 0, outSec: 5 }); // [0,5]
		const b = clip({ id: "b", startSec: 3, inSec: 0, outSec: 5 }); // [3,8]
		expect(clipsOverlap(a, b)).toBe(true);
		expect(clipsOverlap(b, a)).toBe(true);
	});
	it("false when edges only touch (a.end === b.start)", () => {
		const a = clip({ id: "a", startSec: 0, inSec: 0, outSec: 5 }); // [0,5]
		const b = clip({ id: "b", startSec: 5, inSec: 0, outSec: 5 }); // [5,10]
		expect(clipsOverlap(a, b)).toBe(false);
	});
	it("false when on different tracks even if spans coincide", () => {
		const a = clip({ id: "a", startSec: 0, outSec: 5, trackIndex: 0 });
		const b = clip({ id: "b", startSec: 1, outSec: 5, trackIndex: 1 });
		expect(clipsOverlap(a, b)).toBe(false);
	});
	it("false when fully disjoint", () => {
		const a = clip({ id: "a", startSec: 0, outSec: 2 }); // [0,2]
		const b = clip({ id: "b", startSec: 5, outSec: 7 }); // [5,12]
		expect(clipsOverlap(a, b)).toBe(false);
	});
});

describe("overlapWindow", () => {
	it("is [max(start), min(end)]", () => {
		const a = clip({ id: "a", startSec: 0, inSec: 0, outSec: 5 }); // [0,5]
		const b = clip({ id: "b", startSec: 3, inSec: 0, outSec: 5 }); // [3,8]
		expect(overlapWindow(a, b)).toEqual({ startSec: 3, endSec: 5 });
		expect(overlapWindow(b, a)).toEqual({ startSec: 3, endSec: 5 });
	});
	it("null for a zero-width touch", () => {
		const a = clip({ id: "a", startSec: 0, outSec: 5 });
		const b = clip({ id: "b", startSec: 5, outSec: 5 });
		expect(overlapWindow(a, b)).toBeNull();
	});
	it("null across tracks", () => {
		const a = clip({ id: "a", startSec: 0, outSec: 5, trackIndex: 0 });
		const b = clip({ id: "b", startSec: 1, outSec: 5, trackIndex: 2 });
		expect(overlapWindow(a, b)).toBeNull();
	});
	it("handles full containment (smaller clip inside the larger)", () => {
		const a = clip({ id: "a", startSec: 0, inSec: 0, outSec: 10 }); // [0,10]
		const b = clip({ id: "b", startSec: 2, inSec: 0, outSec: 3 }); // [2,5]
		expect(overlapWindow(a, b)).toEqual({ startSec: 2, endSec: 5 });
	});
});

describe("findOverlappingPairs", () => {
	it("orders from = earlier start, to = later start", () => {
		const a = clip({ id: "a", startSec: 0, outSec: 5 }); // [0,5]
		const b = clip({ id: "b", startSec: 3, outSec: 5 }); // [3,8]
		const pairs = findOverlappingPairs([b, a]); // input order shouldn't matter
		expect(pairs).toHaveLength(1);
		expect(pairs[0].from.id).toBe("a");
		expect(pairs[0].to.id).toBe("b");
	});
	it("ignores clips on different tracks", () => {
		const a = clip({ id: "a", startSec: 0, outSec: 5, trackIndex: 0 });
		const b = clip({ id: "b", startSec: 1, outSec: 5, trackIndex: 1 });
		expect(findOverlappingPairs([a, b])).toHaveLength(0);
	});
	it("ignores merely touching clips", () => {
		const a = clip({ id: "a", startSec: 0, outSec: 5 });
		const b = clip({ id: "b", startSec: 5, outSec: 5 });
		expect(findOverlappingPairs([a, b])).toHaveLength(0);
	});
	it("finds multiple overlaps independently", () => {
		const a = clip({ id: "a", startSec: 0, outSec: 4 }); // [0,4]
		const b = clip({ id: "b", startSec: 3, outSec: 4 }); // [3,7]
		const c = clip({ id: "c", startSec: 6, outSec: 4 }); // [6,10]
		const pairs = findOverlappingPairs([a, b, c]);
		// a∩b and b∩c overlap; a∩c do not.
		expect(pairs).toHaveLength(2);
		const keys = pairs.map((p) => `${p.from.id}->${p.to.id}`).sort();
		expect(keys).toEqual(["a->b", "b->c"]);
	});
	it("breaks a start-time tie by id for stable ordering", () => {
		const a = clip({ id: "a", startSec: 2, outSec: 5 });
		const b = clip({ id: "b", startSec: 2, outSec: 5 });
		const pairs = findOverlappingPairs([b, a]);
		expect(pairs).toHaveLength(1);
		expect(pairs[0].from.id).toBe("a");
		expect(pairs[0].to.id).toBe("b");
	});
});

describe("activeTransitions", () => {
	const a = clip({ id: "a", startSec: 0, outSec: 5 }); // [0,5]
	const b = clip({ id: "b", startSec: 3, outSec: 5 }); // [3,8]
	const transition: Transition = { id: "t1", fromClipId: "a", toClipId: "b" };

	it("resolves a live transition with derived window + ordered clips", () => {
		const active = activeTransitions([transition], [a, b]);
		expect(active).toHaveLength(1);
		expect(active[0].from.id).toBe("a");
		expect(active[0].to.id).toBe("b");
		expect(active[0].window).toEqual({ startSec: 3, endSec: 5 });
	});
	it("re-derives the window after the clips move (still correct)", () => {
		const movedB = { ...b, startSec: 4 }; // [4,9] → window now [4,5]
		const active = activeTransitions([transition], [a, movedB]);
		expect(active[0].window).toEqual({ startSec: 4, endSec: 5 });
	});
	it("drops a transition whose clips were pulled apart (inert)", () => {
		const farB = { ...b, startSec: 20 }; // [20,25] — no overlap
		expect(activeTransitions([transition], [a, farB])).toHaveLength(0);
	});
	it("drops a transition whose clip was deleted", () => {
		expect(activeTransitions([transition], [a])).toHaveLength(0);
	});
	it("keeps fade direction following start order if clips swap", () => {
		// b dragged before a: now b is the earlier (outgoing) clip.
		const earlyB = { ...b, startSec: 0, outSec: 5 }; // [0,5]
		const lateA = { ...a, startSec: 2, outSec: 5 }; // [2,7]
		const active = activeTransitions([transition], [lateA, earlyB]);
		expect(active[0].from.id).toBe("b");
		expect(active[0].to.id).toBe("a");
	});
});

describe("crossfadeAlpha", () => {
	const window = { startSec: 3, endSec: 5 };
	it("is fully outgoing at the window start", () => {
		expect(crossfadeAlpha(window, 3)).toEqual({ outgoing: 1, incoming: 0 });
	});
	it("is fully incoming at the window end", () => {
		expect(crossfadeAlpha(window, 5)).toEqual({ outgoing: 0, incoming: 1 });
	});
	it("is 0.5/0.5 at the midpoint", () => {
		expect(crossfadeAlpha(window, 4)).toEqual({ outgoing: 0.5, incoming: 0.5 });
	});
	it("clamps before the window", () => {
		expect(crossfadeAlpha(window, 0)).toEqual({ outgoing: 1, incoming: 0 });
	});
	it("clamps after the window", () => {
		expect(crossfadeAlpha(window, 99)).toEqual({ outgoing: 0, incoming: 1 });
	});
	it("a zero-width window is a hard cut", () => {
		expect(crossfadeAlpha({ startSec: 5, endSec: 5 }, 5)).toEqual({ outgoing: 0, incoming: 1 });
	});
});

describe("transitionAt", () => {
	const a = clip({ id: "a", startSec: 0, outSec: 5 }); // [0,5]
	const b = clip({ id: "b", startSec: 3, outSec: 5 }); // [3,8] → window [3,5]
	const transition: Transition = { id: "t1", fromClipId: "a", toClipId: "b" };

	it("returns the transition when sec is inside its window", () => {
		expect(transitionAt([transition], [a, b], 0, 4)?.transition.id).toBe("t1");
	});
	it("is half-open: window end excluded", () => {
		expect(transitionAt([transition], [a, b], 0, 5)).toBeNull();
	});
	it("null outside the window", () => {
		expect(transitionAt([transition], [a, b], 0, 1)).toBeNull();
	});
	it("null on a different track", () => {
		expect(transitionAt([transition], [a, b], 1, 4)).toBeNull();
	});
});
