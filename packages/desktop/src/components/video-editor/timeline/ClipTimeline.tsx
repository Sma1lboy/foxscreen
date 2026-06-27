import { Eraser, Scissors, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import {
	type DragEvent as ReactDragEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { ASSET_DRAG_MIME, type MediaAsset } from "../MediaBin";
import {
	clipDuration,
	clipEndSec,
	clipsTotalDuration,
	DEFAULT_TRACKS,
	genClipId,
	MIN_CLIP_LENGTH,
	splitClipAt,
	type TimelineClip,
	type TimelineTrack,
} from "./clipModel";
import { getThumbnail, getWaveformPeaks } from "./mediaPreview";

const RULER_HEIGHT = 22;
const TRACK_HEIGHT = 42;
const TRACK_GAP = 4;
const MIN_PX_PER_SEC = 10;
const MAX_PX_PER_SEC = 400;
const DEFAULT_PX_PER_SEC = 60;
const SNAP_PX = 8;
const TRAIL_SECONDS = 6; // empty runway after the last clip

interface ClipTimelineProps {
	clips: TimelineClip[];
	onClipsChange: (clips: TimelineClip[]) => void;
	currentTime: number;
	videoDuration: number;
	onSeek: (sec: number) => void;
	selectedClipId: string | null;
	onSelectClip: (clip: TimelineClip | null) => void;
	/** Drop a library asset onto a track at a timeline position (drag from the bin). */
	onAddClip?: (asset: MediaAsset, trackIndex: number, startSec: number) => void;
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
	orig: TimelineClip;
	lanesTop: number;
}

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
export function ClipTimeline({
	clips,
	onClipsChange,
	currentTime,
	videoDuration,
	onSeek,
	selectedClipId,
	onSelectClip,
	onAddClip,
}: ClipTimelineProps) {
	const t = useScopedT("editor");
	const [pxPerSec, setPxPerSecState] = useState(DEFAULT_PX_PER_SEC);
	// Mirror props/state into refs so the document-level pointer handlers
	// (attached once per drag) always read the latest values without re-binding.
	const pxPerSecRef = useRef(pxPerSec);
	pxPerSecRef.current = pxPerSec;
	const clipsRef = useRef(clips);
	clipsRef.current = clips;
	const currentTimeRef = useRef(currentTime);
	currentTimeRef.current = currentTime;
	const onClipsChangeRef = useRef(onClipsChange);
	onClipsChangeRef.current = onClipsChange;

	const setPxPerSec = useCallback((next: number) => {
		setPxPerSecState(Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, next)));
	}, []);

	const tracks = useMemo<TimelineTrack[]>(() => {
		const maxIndex = clips.reduce((m, c) => Math.max(m, c.trackIndex), DEFAULT_TRACKS.length - 1);
		const list = [...DEFAULT_TRACKS];
		for (let i = DEFAULT_TRACKS.length; i <= maxIndex; i++) {
			list.push({ index: i, kind: "video" });
		}
		return list;
	}, [clips]);

	const contentSeconds = useMemo(() => {
		const end = Math.max(clipsTotalDuration(clips), videoDuration, currentTime);
		return end + TRAIL_SECONDS;
	}, [clips, videoDuration, currentTime]);
	const contentWidth = contentSeconds * pxPerSec;

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

			const next = list.map((c) => {
				if (c.id !== drag.clipId) return c;
				if (drag.kind === "move") {
					let start = Math.max(0, orig.startSec + dxSec);
					const dur = clipDuration(orig);
					// Snap whichever edge (left/right) lands closest to a target.
					const snappedStart = snap(start, snapPoints, pps);
					const snappedEnd = snap(start + dur, snapPoints, pps) - dur;
					start =
						Math.abs(snappedStart - start) <= Math.abs(snappedEnd - start)
							? snappedStart
							: snappedEnd;
					start = Math.max(0, start);
					const trackIndex = laneIndexFromY(e.clientY, drag.lanesTop);
					return { ...c, startSec: start, trackIndex };
				}
				if (drag.kind === "trim-left") {
					let newStart = snap(Math.max(0, orig.startSec + dxSec), snapPoints, pps);
					const maxStart = clipEndSec(orig) - MIN_CLIP_LENGTH;
					newStart = Math.min(maxStart, Math.max(0, newStart));
					const delta = newStart - orig.startSec;
					const newIn = Math.max(0, orig.inSec + delta);
					return { ...c, startSec: orig.startSec + (newIn - orig.inSec), inSec: newIn };
				}
				// trim-right
				const newEnd = snap(orig.startSec + dxSec + clipDuration(orig), snapPoints, pps);
				const newOut = Math.max(
					orig.inSec + MIN_CLIP_LENGTH,
					orig.outSec + (newEnd - clipEndSec(orig)),
				);
				return { ...c, outSec: newOut };
			});
			onClipsChangeRef.current(next);
		},
		[laneIndexFromY],
	);

	const endDrag = useCallback(() => {
		dragRef.current = null;
		window.removeEventListener("pointermove", handlePointerMove);
		window.removeEventListener("pointerup", endDrag);
		window.removeEventListener("pointercancel", endDrag);
	}, [handlePointerMove]);

	useEffect(() => endDrag, [endDrag]);

	const beginDrag = useCallback(
		(e: ReactPointerEvent, clip: TimelineClip, kind: DragKind) => {
			e.stopPropagation();
			const lanesTop = lanesRef.current?.getBoundingClientRect().top ?? 0;
			dragRef.current = {
				kind,
				clipId: clip.id,
				pointerId: e.pointerId,
				startX: e.clientX,
				startY: e.clientY,
				orig: clip,
				lanesTop,
			};
			onSelectClip(clip);
			window.addEventListener("pointermove", handlePointerMove);
			window.addEventListener("pointerup", endDrag);
			window.addEventListener("pointercancel", endDrag);
		},
		[handlePointerMove, endDrag, onSelectClip],
	);

	const selectedClip = useMemo(
		() => clips.find((c) => c.id === selectedClipId) ?? null,
		[clips, selectedClipId],
	);

	const handleSplit = useCallback(() => {
		if (!selectedClip) return;
		const halves = splitClipAt(selectedClip, currentTime, genClipId);
		if (!halves) return;
		const next = clips.flatMap((c) => (c.id === selectedClip.id ? halves : [c]));
		onClipsChange(next);
		onSelectClip(halves[0]);
	}, [selectedClip, currentTime, clips, onClipsChange, onSelectClip]);

	const handleRippleDelete = useCallback(() => {
		if (!selectedClip) return;
		const gap = clipDuration(selectedClip);
		const next = clips
			.filter((c) => c.id !== selectedClip.id)
			.map((c) =>
				c.trackIndex === selectedClip.trackIndex && c.startSec >= clipEndSec(selectedClip)
					? { ...c, startSec: Math.max(0, c.startSec - gap) }
					: c,
			);
		onClipsChange(next);
		onSelectClip(null);
	}, [selectedClip, clips, onClipsChange, onSelectClip]);

	const handleDelete = useCallback(() => {
		if (!selectedClip) return;
		onClipsChange(clips.filter((c) => c.id !== selectedClip.id));
		onSelectClip(null);
	}, [selectedClip, clips, onClipsChange, onSelectClip]);

	// Seek when clicking the ruler or empty lane space.
	const seekFromClientX = useCallback(
		(clientX: number) => {
			const rect = lanesRef.current?.getBoundingClientRect();
			if (!rect) return;
			const sec = Math.max(
				0,
				(clientX - rect.left + (lanesRef.current?.scrollLeft ?? 0)) / pxPerSec,
			);
			onSeek(sec);
		},
		[onSeek, pxPerSec],
	);

	// Map a drag pointer over the lanes to a {track, startSec} drop target, with
	// the same edge/playhead/0 snapping a move-drag uses.
	const dropTargetFromEvent = useCallback(
		(clientX: number, clientY: number): DropHint | null => {
			const rect = lanesRef.current?.getBoundingClientRect();
			if (!rect) return null;
			const trackIndex = laneIndexFromY(clientY, rect.top);
			const raw = Math.max(0, (clientX - rect.left) / pxPerSec);
			const snapPoints = buildSnapPoints(clips, "", currentTime);
			const startSec = Math.max(0, snap(raw, snapPoints, pxPerSec));
			return { trackIndex, startSec };
		},
		[clips, currentTime, laneIndexFromY, pxPerSec],
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

	return (
		<div className="flex h-full w-full flex-col bg-card text-foreground">
			{/* Toolbar */}
			<div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
				<ToolButton
					icon={<Scissors className="h-4 w-4" />}
					label={t("clipTimeline.split")}
					onClick={handleSplit}
					disabled={!selectedClip}
				/>
				<ToolButton
					icon={<Trash2 className="h-4 w-4" />}
					label={t("clipTimeline.rippleDelete")}
					onClick={handleRippleDelete}
					disabled={!selectedClip}
				/>
				<ToolButton
					icon={<Eraser className="h-4 w-4" />}
					label={t("clipTimeline.delete")}
					onClick={handleDelete}
					disabled={!selectedClip}
				/>
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
			</div>

			{/* Scroll viewport: ruler + lanes share one horizontal scroll. */}
			<div className="relative flex min-h-0 flex-1 overflow-auto custom-scrollbar">
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
								style={{ left: tick.sec * pxPerSec }}
							>
								<span className="ml-1 select-none text-[10px] leading-[24px] text-muted-foreground">
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
							>
								<span
									className="pointer-events-none absolute left-1 top-1 z-[1] select-none rounded bg-background/70 px-1 text-[9px] font-semibold uppercase text-muted-foreground"
									aria-label={
										track.kind === "audio"
											? t("clipTimeline.audioTrack")
											: t("clipTimeline.videoTrack")
									}
								>
									{track.kind === "audio" ? "A" : "V"}
									{track.index + 1}
								</span>
								{clips
									.filter((c) => c.trackIndex === track.index)
									.map((clip) => {
										const isSelected = clip.id === selectedClipId;
										const left = clip.startSec * pxPerSec;
										const width = Math.max(2, clipDuration(clip) * pxPerSec);
										const isAudio = track.kind === "audio";
										const thumb = isAudio ? null : thumbs[clip.sourcePath];
										const peaks = isAudio ? waveforms[clip.sourcePath] : null;
										return (
											<div
												key={clip.id}
												className={`absolute top-1 bottom-1 flex cursor-grab items-center overflow-hidden rounded-md border text-[11px] active:cursor-grabbing ${
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
													onSelectClip(clip);
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
												{/* Left trim handle */}
												<div
													className="absolute left-0 top-0 z-[1] h-full w-1.5 cursor-ew-resize bg-foreground/25 hover:bg-primary"
													onPointerDown={(e) => beginDrag(e, clip, "trim-left")}
												/>
												<span
													className={`pointer-events-none z-[1] mx-2 truncate text-foreground ${
														thumb ? "rounded bg-background/55 px-1 py-0.5 backdrop-blur-[1px]" : ""
													}`}
												>
													{clip.name}
												</span>
												{/* Right trim handle */}
												<div
													className="absolute right-0 top-0 z-[1] h-full w-1.5 cursor-ew-resize bg-foreground/25 hover:bg-primary"
													onPointerDown={(e) => beginDrag(e, clip, "trim-right")}
												/>
											</div>
										);
									})}
								{/* Insertion indicator for a bin-asset drop on this lane. */}
								{dropHint?.trackIndex === track.index && (
									<div
										className="pointer-events-none absolute top-0 bottom-0 z-[2] w-0.5 bg-primary"
										style={{ left: dropHint.startSec * pxPerSec }}
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
					</div>

					{/* Playhead spanning ruler + lanes */}
					<div
						className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-primary"
						style={{ left: currentTime * pxPerSec }}
					>
						<div className="absolute -left-1 top-0 h-2 w-2 rounded-sm bg-primary" />
					</div>
				</div>
			</div>
		</div>
	);
}

interface ToolButtonProps {
	icon: ReactNode;
	label: string;
	onClick: () => void;
	disabled?: boolean;
}

function ToolButton({ icon, label, onClick, disabled }: ToolButtonProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={label}
			aria-label={label}
			className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
		>
			{icon}
		</button>
	);
}

export default ClipTimeline;
