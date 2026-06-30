import {
	Blend,
	Eraser,
	Headphones,
	Lock,
	LockOpen,
	Magnet,
	Plus,
	Scissors,
	Trash2,
	Volume2,
	VolumeX,
	X,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import {
	forwardRef,
	type DragEvent as ReactDragEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { ASSET_DRAG_MIME, type MediaAsset } from "../MediaBin";
import {
	clipDuration,
	clipEndSec,
	clipsInMarquee,
	clipsTotalDuration,
	genClipId,
	MIN_CLIP_LENGTH,
	rippleDeleteClip,
	splitClipAt,
	type TimelineClip,
} from "./clipModel";
import { getThumbnail, getWaveformPeaks } from "./mediaPreview";
import { defaultTracksForClips, isTrackLocked, type TimelineTrack } from "./trackModel";
import {
	activeTransitions,
	findOverlappingPairs,
	overlapWindow,
	type Transition,
} from "./transitionModel";

const RULER_HEIGHT = 22;
const TRACK_HEIGHT = 42;
const TRACK_GAP = 4;
const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 400;
const DEFAULT_PX_PER_SEC = 60;
const SNAP_PX = 8;
const TRAIL_SECONDS = 6; // empty runway after the last clip
const TRACK_HEADER_WIDTH = 124; // sticky left lane-header column (label + controls)

interface ClipTimelineProps {
	clips: TimelineClip[];
	/**
	 * Commit a discrete clip edit (toolbar split / ripple / delete) as ONE undo
	 * step. Drag gestures use {@link onClipsDragPreview}/{@link onClipsDragCommit}
	 * instead so a whole move/trim collapses into a single history entry.
	 */
	onClipsChange: (clips: TimelineClip[]) => void;
	/** Live, per-frame drag update — checkpoints once then mutates the present in place. */
	onClipsDragPreview: (clips: TimelineClip[]) => void;
	/** Seal a drag gesture so the next edit starts a fresh undo step. */
	onClipsDragCommit: () => void;
	/** Explicit per-track lane state (mute/solo/lock). Falls back to deriving from clips. */
	tracks?: TimelineTrack[];
	onToggleTrackMuted?: (index: number) => void;
	onToggleTrackSolo?: (index: number) => void;
	onToggleTrackLocked?: (index: number) => void;
	onAddTrack?: () => void;
	onRemoveTrack?: (index: number) => void;
	currentTime: number;
	videoDuration: number;
	onSeek: (sec: number) => void;
	/** Every selected clip id — all are highlighted; bulk ops act on the set. */
	selectedClipIds: string[];
	/** Replace the selection with just this clip (plain click / null = clear). */
	onSelectClip: (clip: TimelineClip | null) => void;
	/** Toggle one clip's membership (Cmd/Ctrl-click or Shift-click). */
	onToggleClip: (clip: TimelineClip) => void;
	/** Replace the selection with the marquee result (drag-select on empty lane). */
	onMarqueeSelect: (ids: string[]) => void;
	/** Drop a library asset onto a track at a timeline position (drag from the bin). */
	onAddClip?: (asset: MediaAsset, trackIndex: number, startSec: number) => void;
	/** Crossfade transitions marking same-track clip overlaps. */
	transitions?: Transition[];
	/** Mark a same-track overlap (from = earlier clip, to = later) as a crossfade. */
	onAddTransition?: (fromClipId: string, toClipId: string) => void;
	/** Drop a crossfade transition by id. */
	onRemoveTransition?: (id: string) => void;
	/**
	 * Edge/playhead snapping, lifted to the owner so the View menu's "Toggle
	 * Snapping" item and the timeline magnet button share one source of truth.
	 */
	snapEnabled: boolean;
	/** Flip snapping (magnet button + View → Toggle Snapping). */
	onToggleSnap: () => void;
}

/**
 * Imperative timeline controls the host menu bar drives (View → Zoom In / Out /
 * Fit). Horizontal zoom + fit-to-window own viewport-relative math that only the
 * timeline can compute, so they're exposed here rather than lifted as state.
 */
export interface ClipTimelineHandle {
	zoomIn: () => void;
	zoomOut: () => void;
	zoomFit: () => void;
}

/** Where a bin-asset drop would land — drives the insertion indicator. */
interface DropHint {
	trackIndex: number;
	startSec: number;
}

type DragKind = "move" | "trim-left" | "trim-right";

interface DragState {
	kind: DragKind;
	clipId: string;
	pointerId: number;
	startX: number;
	startY: number;
	/** The primary dragged clip's original state (drives snapping). */
	orig: TimelineClip;
	/**
	 * Original state of every clip the gesture transforms together, keyed by id.
	 * A move drags all selected unlocked clips by the same delta; a trim only ever
	 * carries the primary clip.
	 */
	origs: Map<string, TimelineClip>;
	lanesTop: number;
}

/** A live marquee drag (rubber-band select) on empty lane space. */
interface MarqueeState {
	pointerId: number;
	startX: number;
	startY: number;
	lanesLeft: number;
	lanesTop: number;
	moved: boolean;
}

/** Pixels a marquee must travel before it counts as a drag (vs. a click-seek). */
const MARQUEE_THRESHOLD_PX = 4;

/** Pick a "nice" ruler tick interval so labels land ~every 80px. */
function pickTickInterval(pxPerSec: number): number {
	const targetPx = 80;
	const rawSec = targetPx / pxPerSec;
	const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
	for (const s of steps) if (s >= rawSec) return s;
	return 900;
}

function formatTick(sec: number): string {
	const total = Math.max(0, Math.round(sec));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Build the set of timeline positions a dragged edge should snap to. */
function buildSnapPoints(clips: TimelineClip[], excludeId: string, playhead: number): number[] {
	const points = [0, playhead];
	for (const c of clips) {
		if (c.id === excludeId) continue;
		points.push(c.startSec, clipEndSec(c));
	}
	return points;
}

function snap(value: number, points: number[], pxPerSec: number): number {
	const thresholdSec = SNAP_PX / pxPerSec;
	let best = value;
	let bestDist = thresholdSec;
	for (const p of points) {
		const d = Math.abs(p - value);
		if (d < bestDist) {
			bestDist = d;
			best = p;
		}
	}
	return best;
}

/**
 * Build a mirrored waveform polygon (`points` for an SVG `<polygon>`) from peaks
 * in [0,1], in a `0 0 N 100` viewBox: a top contour across the buckets, then the
 * bottom contour back, both flared from the 50 midline.
 */
function waveformPoints(peaks: number[]): string {
	const mid = 50;
	const amp = 46;
	const top: string[] = [];
	const bottom: string[] = [];
	for (let i = 0; i < peaks.length; i++) {
		const h = Math.max(0.02, peaks[i]) * amp;
		top.push(`${i},${mid - h}`);
		bottom.push(`${i},${mid + h}`);
	}
	return [...top, ...bottom.reverse()].join(" ");
}

/**
 * Clip-based multi-track timeline — the standard-NLE foundation. Renders a time
 * ruler, a playhead at `currentTime`, stacked track lanes, and clips as
 * draggable blocks. Direct manipulation: click a clip to select, drag its body
 * to move (across tracks, with edge snapping), drag its left/right handles to
 * trim. The toolbar adds blade/split, ripple-delete and plain delete acting on
 * the selected clip, plus horizontal zoom.
 */
export const ClipTimeline = forwardRef<ClipTimelineHandle, ClipTimelineProps>(function ClipTimeline(
	{
		clips,
		onClipsChange,
		onClipsDragPreview,
		onClipsDragCommit,
		tracks: tracksProp,
		onToggleTrackMuted,
		onToggleTrackSolo,
		onToggleTrackLocked,
		onAddTrack,
		onRemoveTrack,
		currentTime,
		videoDuration,
		onSeek,
		selectedClipIds,
		onSelectClip,
		onToggleClip,
		onMarqueeSelect,
		onAddClip,
		transitions,
		onAddTransition,
		onRemoveTransition,
		snapEnabled,
		onToggleSnap,
	},
	ref,
) {
	const t = useScopedT("editor");
	const [pxPerSec, setPxPerSecState] = useState(DEFAULT_PX_PER_SEC);
	// Snapping is owned by the host (VideoEditor) so the View menu and the magnet
	// button stay in lockstep; mirror it into a ref for the document-level pointer
	// handlers (bound once per drag) to read the latest value without re-binding.
	const snapEnabledRef = useRef(snapEnabled);
	snapEnabledRef.current = snapEnabled;
	// Mirror props/state into refs so the document-level pointer handlers
	// (attached once per drag) always read the latest values without re-binding.
	const pxPerSecRef = useRef(pxPerSec);
	pxPerSecRef.current = pxPerSec;
	const clipsRef = useRef(clips);
	clipsRef.current = clips;
	const currentTimeRef = useRef(currentTime);
	currentTimeRef.current = currentTime;
	// The selection as a fast lookup set — drives the highlight and lets a move
	// drag pick up every selected clip without rebuilding from the array.
	const selectedSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);
	const onMarqueeSelectRef = useRef(onMarqueeSelect);
	onMarqueeSelectRef.current = onMarqueeSelect;
	const onSelectClipRef = useRef(onSelectClip);
	onSelectClipRef.current = onSelectClip;
	// Live drag updates route to the preview channel (a silent-checkpoint present
	// mutation) so a whole move/trim collapses into ONE undo step on commit.
	const onClipsDragPreviewRef = useRef(onClipsDragPreview);
	onClipsDragPreviewRef.current = onClipsDragPreview;
	const onClipsDragCommitRef = useRef(onClipsDragCommit);
	onClipsDragCommitRef.current = onClipsDragCommit;
	// True once a drag actually moved the clip — gates the commit so a click that
	// never moved pushes nothing onto the undo stack.
	const dragMovedRef = useRef(false);

	const setPxPerSec = useCallback((next: number) => {
		setPxPerSecState(Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, next)));
	}, []);
	// The horizontal scroll viewport — fit-to-window measures its width to pick a
	// px/sec that lands the whole sequence on screen.
	const scrollRef = useRef<HTMLDivElement | null>(null);

	// Lanes come from the owner (VideoEditor) so mute/solo/lock are shared state;
	// fall back to deriving from the clips when no tracks prop is supplied, and
	// always extend to cover any clip whose index sits beyond the given lanes.
	const tracks = useMemo<TimelineTrack[]>(() => {
		const base = tracksProp && tracksProp.length > 0 ? tracksProp : defaultTracksForClips(clips);
		const maxClipIndex = clips.reduce((m, c) => Math.max(m, c.trackIndex), -1);
		const maxKnown = base.reduce((m, t) => Math.max(m, t.index), -1);
		if (maxClipIndex <= maxKnown) return base;
		const extended = [...base];
		for (let i = maxKnown + 1; i <= maxClipIndex; i++) {
			extended.push({
				index: i,
				name: `Track ${i + 1}`,
				kind: i === 2 ? "audio" : "video",
				muted: false,
				locked: false,
				solo: false,
			});
		}
		return extended;
	}, [tracksProp, clips]);

	const contentSeconds = useMemo(() => {
		const end = Math.max(clipsTotalDuration(clips), videoDuration, currentTime);
		return end + TRAIL_SECONDS;
	}, [clips, videoDuration, currentTime]);
	// The lane-header gutter is pinned at the left; everything time-positioned is
	// shifted right by its width so clips/ticks/playhead never sit under the header.
	const contentWidth = TRACK_HEADER_WIDTH + contentSeconds * pxPerSec;
	const contentSecondsRef = useRef(contentSeconds);
	contentSecondsRef.current = contentSeconds;

	// View-menu zoom controls (host-driven). Zoom in/out mirror the toolbar steps;
	// fit picks a px/sec that lands the whole sequence inside the scroll viewport.
	useImperativeHandle(
		ref,
		() => ({
			zoomIn: () => setPxPerSec(pxPerSecRef.current * 1.5),
			zoomOut: () => setPxPerSec(pxPerSecRef.current / 1.5),
			zoomFit: () => {
				const avail = (scrollRef.current?.clientWidth ?? 0) - TRACK_HEADER_WIDTH;
				const secs = contentSecondsRef.current;
				if (avail <= 0 || secs <= 0) return;
				setPxPerSec(avail / secs);
			},
		}),
		[setPxPerSec],
	);

	// Lazy, cached media previews keyed by source path: a poster frame for video
	// clips, downsampled peaks for audio clips. Decoding is best-effort and may
	// resolve null (headless/Tauri); render falls back to the solid block.
	const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
	const [waveforms, setWaveforms] = useState<Record<string, number[] | null>>({});
	const thumbReqRef = useRef<Set<string>>(new Set());
	const waveReqRef = useRef<Set<string>>(new Set());

	const trackKind = useCallback(
		(trackIndex: number) => tracks.find((tk) => tk.index === trackIndex)?.kind ?? "video",
		[tracks],
	);

	useEffect(() => {
		for (const clip of clips) {
			if (trackKind(clip.trackIndex) === "audio") {
				if (waveReqRef.current.has(clip.sourcePath)) continue;
				waveReqRef.current.add(clip.sourcePath);
				getWaveformPeaks(clip.sourcePath).then((peaks) => {
					setWaveforms((prev) => ({ ...prev, [clip.sourcePath]: peaks }));
				});
			} else {
				if (thumbReqRef.current.has(clip.sourcePath)) continue;
				thumbReqRef.current.add(clip.sourcePath);
				getThumbnail(clip.sourcePath).then((data) => {
					setThumbs((prev) => ({ ...prev, [clip.sourcePath]: data }));
				});
			}
		}
	}, [clips, trackKind]);

	const lanesRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<DragState | null>(null);
	// Insertion indicator while dragging a bin asset over the lanes.
	const [dropHint, setDropHint] = useState<DropHint | null>(null);
	// Marquee (rubber-band) drag-select on empty lane space.
	const marqueeRef = useRef<MarqueeState | null>(null);
	// Rectangle in lanes-relative px while a marquee is being dragged (for drawing).
	const [marqueeRect, setMarqueeRect] = useState<{
		left: number;
		top: number;
		width: number;
		height: number;
	} | null>(null);

	const laneIndexFromY = useCallback(
		(clientY: number, lanesTop: number): number => {
			const rel = clientY - lanesTop;
			const idx = Math.floor(rel / (TRACK_HEIGHT + TRACK_GAP));
			return Math.min(tracks.length - 1, Math.max(0, idx));
		},
		[tracks.length],
	);

	const handlePointerMove = useCallback(
		(e: PointerEvent) => {
			const drag = dragRef.current;
			if (!drag || e.pointerId !== drag.pointerId) return;
			const pps = pxPerSecRef.current;
			const dxSec = (e.clientX - drag.startX) / pps;
			const list = clipsRef.current;
			const playhead = currentTimeRef.current;
			const snapPoints = buildSnapPoints(list, drag.clipId, playhead);
			const orig = drag.orig;
			// When snapping is off the magnet is disabled — land exactly on the pointer.
			const snapV = snapEnabledRef.current
				? (v: number) => snap(v, snapPoints, pps)
				: (v: number) => v;

			let next: TimelineClip[];
			if (drag.kind === "move") {
				// Snapping + clamping are computed from the PRIMARY dragged clip, then
				// the same delta is applied to every selected clip moving together.
				let start = Math.max(0, orig.startSec + dxSec);
				const dur = clipDuration(orig);
				// Snap whichever edge (left/right) lands closest to a target.
				const snappedStart = snapV(start);
				const snappedEnd = snapV(start + dur) - dur;
				start =
					Math.abs(snappedStart - start) <= Math.abs(snappedEnd - start)
						? snappedStart
						: snappedEnd;
				start = Math.max(0, start);
				let deltaStart = start - orig.startSec;
				// Clamp the group shift so the earliest moved clip never crosses 0.
				let minStart = Number.POSITIVE_INFINITY;
				for (const o of drag.origs.values()) minStart = Math.min(minStart, o.startSec);
				if (Number.isFinite(minStart)) deltaStart = Math.max(deltaStart, -minStart);
				const targetTrack = laneIndexFromY(e.clientY, drag.lanesTop);
				const deltaTrack = targetTrack - orig.trackIndex;
				next = list.map((c) => {
					const o = drag.origs.get(c.id);
					if (!o) return c;
					const trackIndex = Math.min(tracks.length - 1, Math.max(0, o.trackIndex + deltaTrack));
					return { ...c, startSec: Math.max(0, o.startSec + deltaStart), trackIndex };
				});
			} else {
				next = list.map((c) => {
					if (c.id !== drag.clipId) return c;
					if (drag.kind === "trim-left") {
						let newStart = snapV(Math.max(0, orig.startSec + dxSec));
						const maxStart = clipEndSec(orig) - MIN_CLIP_LENGTH;
						newStart = Math.min(maxStart, Math.max(0, newStart));
						const delta = newStart - orig.startSec;
						const newIn = Math.max(0, orig.inSec + delta);
						return { ...c, startSec: orig.startSec + (newIn - orig.inSec), inSec: newIn };
					}
					// trim-right
					const newEnd = snapV(orig.startSec + dxSec + clipDuration(orig));
					const newOut = Math.max(
						orig.inSec + MIN_CLIP_LENGTH,
						orig.outSec + (newEnd - clipEndSec(orig)),
					);
					return { ...c, outSec: newOut };
				});
			}
			// Only emit a preview when the dragged clip actually moved/trimmed, so a
			// click without movement never opens (and later commits) an undo step.
			const moved = next.find((c) => c.id === drag.clipId);
			if (
				moved &&
				(moved.startSec !== orig.startSec ||
					moved.trackIndex !== orig.trackIndex ||
					moved.inSec !== orig.inSec ||
					moved.outSec !== orig.outSec)
			) {
				dragMovedRef.current = true;
				onClipsDragPreviewRef.current(next);
			}
		},
		[laneIndexFromY, tracks.length],
	);

	const endDrag = useCallback(() => {
		dragRef.current = null;
		// Seal the gesture into a single undo entry — but only if it actually moved.
		if (dragMovedRef.current) {
			dragMovedRef.current = false;
			onClipsDragCommitRef.current();
		}
		window.removeEventListener("pointermove", handlePointerMove);
		window.removeEventListener("pointerup", endDrag);
		window.removeEventListener("pointercancel", endDrag);
	}, [handlePointerMove]);

	useEffect(() => endDrag, [endDrag]);

	const beginDrag = useCallback(
		(e: ReactPointerEvent, clip: TimelineClip, kind: DragKind) => {
			e.stopPropagation();
			// Clips on a locked lane can be selected but not moved or trimmed.
			if (isTrackLocked(tracks, clip.trackIndex)) {
				onSelectClip(clip);
				return;
			}
			const lanesTop = lanesRef.current?.getBoundingClientRect().top ?? 0;
			// Dragging a clip that's already part of a multi-selection moves the whole
			// set; dragging an unselected clip selects only it first. A trim always
			// acts on just the primary clip.
			const inSelection = selectedSet.has(clip.id);
			if (!inSelection) onSelectClip(clip);
			const origs = new Map<string, TimelineClip>();
			if (kind === "move" && inSelection) {
				// Carry every selected clip on an unlocked lane (locked clips stay put).
				for (const c of clips) {
					if (selectedSet.has(c.id) && !isTrackLocked(tracks, c.trackIndex)) origs.set(c.id, c);
				}
			}
			// Always include the primary (covers a fresh single-clip drag + trims).
			if (!origs.has(clip.id)) origs.set(clip.id, clip);
			dragRef.current = {
				kind,
				clipId: clip.id,
				pointerId: e.pointerId,
				startX: e.clientX,
				startY: e.clientY,
				orig: clip,
				origs,
				lanesTop,
			};
			window.addEventListener("pointermove", handlePointerMove);
			window.addEventListener("pointerup", endDrag);
			window.addEventListener("pointercancel", endDrag);
		},
		[handlePointerMove, endDrag, onSelectClip, tracks, clips, selectedSet],
	);

	// Every selected clip on an UNLOCKED lane — the set every toolbar/keyboard edit
	// acts on. Locked-lane clips can be selected (highlighted) but ops skip them.
	const editableSelected = useMemo(
		() => clips.filter((c) => selectedSet.has(c.id) && !isTrackLocked(tracks, c.trackIndex)),
		[clips, selectedSet, tracks],
	);
	// Toolbar edit buttons are live whenever at least one selected clip is editable.
	const hasEditable = editableSelected.length > 0;

	const handleSplit = useCallback(() => {
		if (editableSelected.length === 0) return;
		const editableIds = new Set(editableSelected.map((c) => c.id));
		const newSel: string[] = [];
		let changed = false;
		const next = clips.flatMap((c) => {
			if (!editableIds.has(c.id)) return [c];
			const halves = splitClipAt(c, currentTime, genClipId);
			if (!halves) {
				newSel.push(c.id);
				return [c];
			}
			changed = true;
			newSel.push(halves[0].id, halves[1].id);
			return halves;
		});
		if (!changed) return;
		onClipsChange(next);
		onMarqueeSelect(newSel);
	}, [editableSelected, currentTime, clips, onClipsChange, onMarqueeSelect]);

	const handleRippleDelete = useCallback(() => {
		if (editableSelected.length === 0) return;
		let next = clips;
		for (const c of editableSelected) next = rippleDeleteClip(next, c.id);
		onClipsChange(next);
		onSelectClip(null);
	}, [editableSelected, clips, onClipsChange, onSelectClip]);

	const handleDelete = useCallback(() => {
		if (editableSelected.length === 0) return;
		const ids = new Set(editableSelected.map((c) => c.id));
		onClipsChange(clips.filter((c) => !ids.has(c.id)));
		onSelectClip(null);
	}, [editableSelected, clips, onClipsChange, onSelectClip]);

	// Seek when clicking the ruler or empty lane space.
	const seekFromClientX = useCallback(
		(clientX: number) => {
			const rect = lanesRef.current?.getBoundingClientRect();
			if (!rect) return;
			const sec = Math.max(
				0,
				(clientX - rect.left + (lanesRef.current?.scrollLeft ?? 0) - TRACK_HEADER_WIDTH) / pxPerSec,
			);
			onSeek(sec);
		},
		[onSeek, pxPerSec],
	);
	const seekFromClientXRef = useRef(seekFromClientX);
	seekFromClientXRef.current = seekFromClientX;

	// --- Marquee (rubber-band) drag-select on empty lane space ---------------
	// A pointer-down on bare lane area starts a *potential* marquee. Below the
	// threshold it falls back to the existing click (seek + clear selection);
	// past it, it draws a rectangle and selects every clip it intersects.
	const handleMarqueeMove = useCallback((e: PointerEvent) => {
		const m = marqueeRef.current;
		if (!m || e.pointerId !== m.pointerId) return;
		if (
			!m.moved &&
			Math.abs(e.clientX - m.startX) < MARQUEE_THRESHOLD_PX &&
			Math.abs(e.clientY - m.startY) < MARQUEE_THRESHOLD_PX
		) {
			return; // still within the click slop — don't open a marquee yet
		}
		m.moved = true;
		const x0 = m.startX - m.lanesLeft;
		const y0 = m.startY - m.lanesTop;
		const x1 = e.clientX - m.lanesLeft;
		const y1 = e.clientY - m.lanesTop;
		setMarqueeRect({
			left: Math.min(x0, x1),
			top: Math.min(y0, y1),
			width: Math.abs(x1 - x0),
			height: Math.abs(y1 - y0),
		});
	}, []);

	const endMarquee = useCallback(
		(e: PointerEvent) => {
			const m = marqueeRef.current;
			window.removeEventListener("pointermove", handleMarqueeMove);
			window.removeEventListener("pointerup", endMarquee);
			window.removeEventListener("pointercancel", endMarquee);
			marqueeRef.current = null;
			setMarqueeRect(null);
			if (!m || e.pointerId !== m.pointerId) return;
			if (!m.moved) {
				// A plain click on empty lane: clear selection + seek (legacy behaviour).
				onSelectClipRef.current(null);
				seekFromClientXRef.current(m.startX);
				return;
			}
			const pps = pxPerSecRef.current;
			const secAt = (clientX: number) =>
				Math.max(0, (clientX - m.lanesLeft - TRACK_HEADER_WIDTH) / pps);
			const trackAt = (clientY: number) => {
				const rel = clientY - m.lanesTop;
				const idx = Math.floor(rel / (TRACK_HEIGHT + TRACK_GAP));
				return Math.max(0, idx);
			};
			const ids = clipsInMarquee(
				clipsRef.current,
				secAt(m.startX),
				secAt(e.clientX),
				trackAt(m.startY),
				trackAt(e.clientY),
			);
			onMarqueeSelectRef.current(ids);
		},
		[handleMarqueeMove],
	);

	const beginMarquee = useCallback(
		(e: ReactPointerEvent) => {
			const rect = lanesRef.current?.getBoundingClientRect();
			if (!rect) return;
			marqueeRef.current = {
				pointerId: e.pointerId,
				startX: e.clientX,
				startY: e.clientY,
				lanesLeft: rect.left,
				lanesTop: rect.top,
				moved: false,
			};
			window.addEventListener("pointermove", handleMarqueeMove);
			window.addEventListener("pointerup", endMarquee);
			window.addEventListener("pointercancel", endMarquee);
		},
		[handleMarqueeMove, endMarquee],
	);

	// Tear down marquee listeners if the component unmounts mid-drag.
	useEffect(
		() => () => {
			window.removeEventListener("pointermove", handleMarqueeMove);
			window.removeEventListener("pointerup", endMarquee);
			window.removeEventListener("pointercancel", endMarquee);
		},
		[handleMarqueeMove, endMarquee],
	);

	// Map a drag pointer over the lanes to a {track, startSec} drop target, with
	// the same edge/playhead/0 snapping a move-drag uses.
	const dropTargetFromEvent = useCallback(
		(clientX: number, clientY: number): DropHint | null => {
			const rect = lanesRef.current?.getBoundingClientRect();
			if (!rect) return null;
			const trackIndex = laneIndexFromY(clientY, rect.top);
			const raw = Math.max(0, (clientX - rect.left - TRACK_HEADER_WIDTH) / pxPerSec);
			const snapPoints = buildSnapPoints(clips, "", currentTime);
			const startSec = snapEnabled
				? Math.max(0, snap(raw, snapPoints, pxPerSec))
				: Math.max(0, raw);
			return { trackIndex, startSec };
		},
		[clips, currentTime, laneIndexFromY, pxPerSec, snapEnabled],
	);

	const handleLanesDragOver = useCallback(
		(e: ReactDragEvent) => {
			if (!onAddClip || !e.dataTransfer.types.includes(ASSET_DRAG_MIME)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			setDropHint(dropTargetFromEvent(e.clientX, e.clientY));
		},
		[onAddClip, dropTargetFromEvent],
	);

	const handleLanesDragLeave = useCallback((e: ReactDragEvent) => {
		if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHint(null);
	}, []);

	const handleLanesDrop = useCallback(
		(e: ReactDragEvent) => {
			setDropHint(null);
			if (!onAddClip) return;
			const raw = e.dataTransfer.getData(ASSET_DRAG_MIME);
			if (!raw) return;
			e.preventDefault();
			let asset: MediaAsset;
			try {
				asset = JSON.parse(raw) as MediaAsset;
			} catch {
				return;
			}
			if (!asset?.id || !asset.path) return;
			const target = dropTargetFromEvent(e.clientX, e.clientY);
			if (!target) return;
			onAddClip(asset, target.trackIndex, target.startSec);
		},
		[onAddClip, dropTargetFromEvent],
	);

	const ticks = useMemo(() => {
		const interval = pickTickInterval(pxPerSec);
		const out: { sec: number; label: string }[] = [];
		for (let s = 0; s <= contentSeconds; s += interval) {
			out.push({ sec: s, label: formatTick(s) });
		}
		return out;
	}, [pxPerSec, contentSeconds]);

	const hasClips = clips.length > 0;

	// Same-track overlap regions, each tagged with the crossfade transition that
	// marks it (if any). The window is derived live from the clips' positions, so it
	// stays correct as they move and disappears once they no longer overlap.
	const overlapRegions = useMemo(() => {
		const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
		const txByPair = new Map<string, Transition>();
		for (const active of activeTransitions(transitions ?? [], clips)) {
			txByPair.set(pairKey(active.from.id, active.to.id), active.transition);
		}
		const regions: Array<{
			key: string;
			trackIndex: number;
			startSec: number;
			endSec: number;
			fromId: string;
			toId: string;
			transition: Transition | null;
		}> = [];
		for (const pair of findOverlappingPairs(clips)) {
			const window = overlapWindow(pair.from, pair.to);
			if (!window) continue;
			const key = pairKey(pair.from.id, pair.to.id);
			regions.push({
				key,
				trackIndex: pair.from.trackIndex,
				startSec: window.startSec,
				endSec: window.endSec,
				fromId: pair.from.id,
				toId: pair.to.id,
				transition: txByPair.get(key) ?? null,
			});
		}
		return regions;
	}, [clips, transitions]);

	return (
		<div className="flex h-full w-full flex-col bg-card text-foreground">
			{/* Toolbar */}
			<div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
				<ToolButton
					icon={<Scissors className="h-4 w-4" />}
					label={t("clipTimeline.split")}
					onClick={handleSplit}
					disabled={!hasEditable}
				/>
				<ToolButton
					icon={<Trash2 className="h-4 w-4" />}
					label={t("clipTimeline.rippleDelete")}
					onClick={handleRippleDelete}
					disabled={!hasEditable}
				/>
				<ToolButton
					icon={<Eraser className="h-4 w-4" />}
					label={t("clipTimeline.delete")}
					onClick={handleDelete}
					disabled={!hasEditable}
				/>
				<div className="mx-1 h-5 w-px bg-border" />
				{onAddTrack && (
					<ToolButton
						icon={<Plus className="h-4 w-4" />}
						label={t("clipTimeline.addTrack")}
						onClick={onAddTrack}
					/>
				)}
				<div className="mx-1 h-5 w-px bg-border" />
				<ToolButton
					icon={<ZoomOut className="h-4 w-4" />}
					label={t("clipTimeline.zoomOut")}
					onClick={() => setPxPerSec(pxPerSec / 1.5)}
				/>
				<ToolButton
					icon={<ZoomIn className="h-4 w-4" />}
					label={t("clipTimeline.zoomIn")}
					onClick={() => setPxPerSec(pxPerSec * 1.5)}
				/>
				<div className="mx-1 h-5 w-px bg-border" />
				<ToolButton
					icon={<Magnet className="h-4 w-4" />}
					label={t("clipTimeline.snapping")}
					onClick={onToggleSnap}
					active={snapEnabled}
				/>
			</div>

			{/* Scroll viewport: ruler + lanes share one horizontal scroll. */}
			<div ref={scrollRef} className="relative flex min-h-0 flex-1 overflow-auto custom-scrollbar">
				<div className="relative" style={{ width: contentWidth, minWidth: "100%" }}>
					{/* Ruler */}
					<div
						className="sticky top-0 z-10 cursor-text border-b border-border bg-muted"
						style={{ height: RULER_HEIGHT }}
						onPointerDown={(e) => {
							onSelectClip(null);
							seekFromClientX(e.clientX);
						}}
					>
						{ticks.map((tick) => (
							<div
								key={tick.sec}
								className="absolute top-0 h-full border-l border-border"
								style={{ left: TRACK_HEADER_WIDTH + tick.sec * pxPerSec }}
							>
								<span className="ml-1 select-none font-mono text-[10px] leading-[24px] text-muted-foreground">
									{tick.label}
								</span>
							</div>
						))}
					</div>

					{/* Lanes */}
					<div
						ref={lanesRef}
						className="relative"
						onPointerDown={(e) => {
							if (e.target === e.currentTarget) {
								onSelectClip(null);
								seekFromClientX(e.clientX);
							}
						}}
						onDragOver={handleLanesDragOver}
						onDragLeave={handleLanesDragLeave}
						onDrop={handleLanesDrop}
					>
						{tracks.map((track) => (
							<div
								key={track.index}
								className="relative border-b border-border"
								style={{ height: TRACK_HEIGHT, marginBottom: TRACK_GAP }}
								onPointerDown={(e) => {
									// Empty lane area only (clips/headers stopPropagation): start a
									// potential marquee that falls back to seek+clear on a plain click.
									if (e.target === e.currentTarget) beginMarquee(e);
								}}
							>
								<TrackHeader
									track={track}
									canRemove={tracks.length > 1}
									onToggleMuted={onToggleTrackMuted}
									onToggleSolo={onToggleTrackSolo}
									onToggleLocked={onToggleTrackLocked}
									onRemove={onRemoveTrack}
									t={t}
								/>
								{clips
									.filter((c) => c.trackIndex === track.index)
									.map((clip) => {
										const isSelected = selectedSet.has(clip.id);
										const left = TRACK_HEADER_WIDTH + clip.startSec * pxPerSec;
										const width = Math.max(2, clipDuration(clip) * pxPerSec);
										const isAudio = track.kind === "audio";
										const locked = track.locked;
										const thumb = isAudio ? null : thumbs[clip.sourcePath];
										const peaks = isAudio ? waveforms[clip.sourcePath] : null;
										return (
											<div
												key={clip.id}
												className={`absolute top-1 bottom-1 flex items-center overflow-hidden rounded-md border text-[11px] ${
													locked
														? "cursor-not-allowed opacity-55"
														: "cursor-grab active:cursor-grabbing"
												} ${
													isSelected
														? "border-primary bg-primary/30 ring-1 ring-primary"
														: isAudio
															? "border-emerald-500/40 bg-emerald-500/20 hover:bg-emerald-500/30"
															: "border-primary/40 bg-primary/15 hover:bg-primary/25"
												}`}
												style={{ left, width }}
												onPointerDown={(e) => beginDrag(e, clip, "move")}
												onClick={(e) => {
													e.stopPropagation();
													// Cmd/Ctrl-click or Shift-click toggles membership; a plain
													// click selects only this clip.
													if (e.metaKey || e.ctrlKey || e.shiftKey) onToggleClip(clip);
													else onSelectClip(clip);
												}}
											>
												{/* Video poster frame as a cover background. */}
												{thumb && (
													<img
														src={thumb}
														alt=""
														draggable={false}
														className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-80"
													/>
												)}
												{/* Audio waveform from downsampled peaks. */}
												{peaks && peaks.length > 0 && (
													<svg
														className="pointer-events-none absolute inset-0 h-full w-full text-emerald-400"
														viewBox={`0 0 ${peaks.length} 100`}
														preserveAspectRatio="none"
														aria-hidden="true"
													>
														<polygon
															fill="currentColor"
															fillOpacity={0.55}
															points={waveformPoints(peaks)}
														/>
													</svg>
												)}
												{/* Left trim handle (hidden on locked lanes) */}
												{!locked && (
													<div
														className="absolute left-0 top-0 z-[1] h-full w-1.5 cursor-ew-resize bg-foreground/25 hover:bg-primary"
														onPointerDown={(e) => beginDrag(e, clip, "trim-left")}
													/>
												)}
												<span
													className={`pointer-events-none z-[1] mx-2 truncate text-foreground ${
														thumb ? "rounded bg-background/55 px-1 py-0.5 backdrop-blur-[1px]" : ""
													}`}
												>
													{clip.name}
												</span>
												{/* Right trim handle (hidden on locked lanes) */}
												{!locked && (
													<div
														className="absolute right-0 top-0 z-[1] h-full w-1.5 cursor-ew-resize bg-foreground/25 hover:bg-primary"
														onPointerDown={(e) => beginDrag(e, clip, "trim-right")}
													/>
												)}
											</div>
										);
									})}
								{/* Crossfade overlays over same-track clip overlaps: an active
								    transition (click to remove) or a "click to add" affordance. */}
								{overlapRegions
									.filter((r) => r.trackIndex === track.index)
									.map((r) => {
										const left = TRACK_HEADER_WIDTH + r.startSec * pxPerSec;
										const width = Math.max(8, (r.endSec - r.startSec) * pxPerSec);
										const isActive = r.transition !== null;
										return (
											<div
												key={r.key}
												className={`pointer-events-none absolute top-1 bottom-1 z-[4] flex items-center justify-center overflow-hidden rounded-sm border ${
													isActive
														? "border-primary bg-primary/20"
														: "border-dashed border-foreground/30 bg-foreground/5"
												}`}
												style={{
													left,
													width,
													// Diagonal hatch fill so a crossfade reads as a blend region.
													backgroundImage: isActive
														? "repeating-linear-gradient(45deg, hsl(var(--primary) / 0.18) 0 4px, transparent 4px 8px)"
														: undefined,
												}}
											>
												<button
													type="button"
													className={`pointer-events-auto flex h-5 w-5 items-center justify-center rounded transition-colors ${
														isActive
															? "bg-primary/30 text-primary hover:bg-primary/50"
															: "bg-background/70 text-muted-foreground opacity-60 hover:opacity-100 hover:text-foreground"
													}`}
													title={
														isActive
															? t("clipTimeline.removeCrossfade")
															: t("clipTimeline.addCrossfade")
													}
													aria-label={
														isActive
															? t("clipTimeline.removeCrossfade")
															: t("clipTimeline.addCrossfade")
													}
													onPointerDown={(e) => e.stopPropagation()}
													onClick={(e) => {
														e.stopPropagation();
														if (isActive) onRemoveTransition?.(r.transition!.id);
														else onAddTransition?.(r.fromId, r.toId);
													}}
												>
													{isActive ? <Blend className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
												</button>
											</div>
										);
									})}
								{/* Insertion indicator for a bin-asset drop on this lane. */}
								{dropHint?.trackIndex === track.index && (
									<div
										className="pointer-events-none absolute top-0 bottom-0 z-[2] w-0.5 bg-primary"
										style={{ left: TRACK_HEADER_WIDTH + dropHint.startSec * pxPerSec }}
									>
										<div className="absolute -left-[3px] top-0 h-1.5 w-1.5 rounded-full bg-primary" />
									</div>
								)}
							</div>
						))}
						{!hasClips && (
							<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
								<span className="select-none text-xs text-muted-foreground">
									{t("clipTimeline.empty")}
								</span>
							</div>
						)}
						{/* Marquee (rubber-band) selection rectangle. */}
						{marqueeRect && (
							<div
								className="pointer-events-none absolute z-[3] rounded-sm border border-primary bg-primary/10"
								style={{
									left: marqueeRect.left,
									top: marqueeRect.top,
									width: marqueeRect.width,
									height: marqueeRect.height,
								}}
							/>
						)}
					</div>

					{/* Playhead spanning ruler + lanes */}
					<div
						className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-primary"
						style={{ left: TRACK_HEADER_WIDTH + currentTime * pxPerSec }}
					>
						<div className="absolute -left-1 top-0 h-2 w-2 rounded-sm bg-primary" />
					</div>
				</div>
			</div>
		</div>
	);
});

interface ToolButtonProps {
	icon: ReactNode;
	label: string;
	onClick: () => void;
	disabled?: boolean;
	/** Render as a pressed/active toggle (primary tint). */
	active?: boolean;
}

function ToolButton({ icon, label, onClick, disabled, active }: ToolButtonProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={label}
			aria-label={label}
			aria-pressed={active}
			className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 ${
				active ? "bg-primary/15 text-primary hover:text-primary" : "text-muted-foreground"
			}`}
		>
			{icon}
		</button>
	);
}

interface TrackHeaderProps {
	track: TimelineTrack;
	canRemove: boolean;
	onToggleMuted?: (index: number) => void;
	onToggleSolo?: (index: number) => void;
	onToggleLocked?: (index: number) => void;
	onRemove?: (index: number) => void;
	t: (key: string) => string;
}

/**
 * Sticky left-pinned lane header: the V/A label plus mute / solo / lock toggles
 * and a remove control. Stays put while the timeline scrolls horizontally so the
 * lane controls are always reachable. Icon-only, `title`/`aria-pressed` for a11y.
 */
function TrackHeader({
	track,
	canRemove,
	onToggleMuted,
	onToggleSolo,
	onToggleLocked,
	onRemove,
	t,
}: TrackHeaderProps) {
	return (
		<div
			className="sticky left-0 z-[5] flex h-full flex-col justify-center gap-1 border-r border-border bg-card/95 px-1.5 backdrop-blur-sm"
			style={{ width: TRACK_HEADER_WIDTH }}
			onPointerDown={(e) => e.stopPropagation()}
		>
			<div className="flex items-center justify-between">
				<span
					className="select-none text-[10px] font-semibold uppercase text-muted-foreground"
					aria-label={
						track.kind === "audio" ? t("clipTimeline.audioTrack") : t("clipTimeline.videoTrack")
					}
				>
					{track.kind === "audio" ? "A" : "V"}
					{track.index + 1}
				</span>
				{onRemove && canRemove && (
					<HeaderButton
						icon={<X className="h-3 w-3" />}
						label={t("clipTimeline.removeTrack")}
						onClick={() => onRemove(track.index)}
					/>
				)}
			</div>
			<div className="flex items-center gap-0.5">
				<HeaderButton
					icon={track.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
					label={track.muted ? t("clipTimeline.unmuteTrack") : t("clipTimeline.muteTrack")}
					active={track.muted}
					onClick={() => onToggleMuted?.(track.index)}
				/>
				<HeaderButton
					icon={<Headphones className="h-3 w-3" />}
					label={track.solo ? t("clipTimeline.unsoloTrack") : t("clipTimeline.soloTrack")}
					active={track.solo}
					onClick={() => onToggleSolo?.(track.index)}
				/>
				<HeaderButton
					icon={track.locked ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
					label={track.locked ? t("clipTimeline.unlockTrack") : t("clipTimeline.lockTrack")}
					active={track.locked}
					onClick={() => onToggleLocked?.(track.index)}
				/>
			</div>
		</div>
	);
}

interface HeaderButtonProps {
	icon: ReactNode;
	label: string;
	onClick: () => void;
	active?: boolean;
}

/** Compact icon toggle used inside a {@link TrackHeader}. */
function HeaderButton({ icon, label, onClick, active }: HeaderButtonProps) {
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			title={label}
			aria-label={label}
			aria-pressed={active}
			className={`flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground ${
				active ? "bg-primary/15 text-primary hover:text-primary" : "text-muted-foreground"
			}`}
		>
			{icon}
		</button>
	);
}

export default ClipTimeline;
