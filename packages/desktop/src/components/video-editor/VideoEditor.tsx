import { loadLlmConfig } from "@foxscreen/cutti-core";
import type { Span } from "dnd-timeline";
import {
	Captions,
	Download,
	FolderOpen,
	Languages,
	Redo2,
	Save,
	Scissors,
	Sparkles,
	Undo2,
	Video,
} from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { toast } from "sonner";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { useShortcuts } from "@/contexts/ShortcutsContext";
import { INITIAL_EDITOR_STATE, useEditorHistory } from "@/hooks/useEditorHistory";
import { type Locale } from "@/i18n/config";
import { getAvailableLocales, getLocaleName } from "@/i18n/loader";
import {
	captionSegmentsToAnnotationRegions,
	extractMono16kFromVideoUrl,
	MAX_CAPTION_AUDIO_SEC,
	reconcileAutoCaptionTimelineGaps,
	shiftTrimRegionsMsForCaptionBuffer,
	transcribeMono16kToSegments,
	trimLeadingSilenceMono16k,
} from "@/lib/captioning";
import { hasNativeCursorRecordingData } from "@/lib/cursor/nativeCursor";
import { transcriptToFirstCut, transcriptToFirstCutAI } from "@/lib/cutti/firstCut";
import { runCuttiDemoEdit } from "@/lib/cutti/integration";
import {
	calculateEffectiveSourceDimensions,
	calculateMp4ExportSettings,
	calculateOutputDimensions,
	type ExportFormat,
	type ExportProgress,
	type ExportQuality,
	type ExportSettings,
	GIF_SIZE_PRESETS,
	GifExporter,
	type GifFrameRate,
	type GifSizePreset,
	SequenceVideoExporter,
	VideoExporter,
} from "@/lib/exporter";
import { computeFrameStepTime } from "@/lib/frameStep";
import type { CursorCaptureMode, ProjectMedia } from "@/lib/recordingSession";
import { matchesShortcut } from "@/lib/shortcuts";
import {
	getExportFolder,
	getProjectFolder,
	loadUserPreferences,
	parentDirectoryOf,
	saveUserPreferences,
} from "@/lib/userPreferences";
import { BackgroundLoadError } from "@/lib/wallpaper";
import { nativeBridgeClient, useCursorRecordingData, useCursorTelemetry } from "@/native";
import type { NativePlatform } from "@/native/contracts";
import { getAspectRatioValue, getNativeAspectRatioValue } from "@/utils/aspectRatioUtils";
import { EditorEmptyState } from "./EditorEmptyState";
import { ExportDialog } from "./ExportDialog";
import {
	DEFAULT_CURSOR_SETTINGS,
	DEFAULT_EXPORT_SETTINGS,
	DEFAULT_GIF_SETTINGS,
	DEFAULT_SOURCE_DIMENSIONS,
} from "./editorDefaults";
import type { MediaAsset } from "./MediaBin";
import PlaybackControls from "./PlaybackControls";
import {
	createProjectData,
	createProjectSnapshot,
	deriveNextId,
	fromFileUrl,
	hasProjectUnsavedChanges,
	normalizeProjectEditor,
	resolveProjectMedia,
	toFileUrl,
	validateProjectData,
} from "./projectPersistence";
import { SettingsPanel } from "./SettingsPanel";
import { TutorialHelp } from "./TutorialHelp";
import ClipTimeline, { type ClipTimelineHandle } from "./timeline/ClipTimeline";
import {
	clipAtTime,
	clipEndSec,
	clipsTotalDuration,
	duplicateClip,
	genClipId,
	nextClipStart,
	nudgeClip,
	pasteClipsAt,
	rippleDeleteClip,
	splitClipAt,
	type TimelineClip,
	trackEndSec,
} from "./timeline/clipModel";
import {
	addTrack,
	DEFAULT_TRACKS,
	defaultTracksForClips,
	effectiveClipGain,
	isTrackLocked,
	reindexClipsForRemovedTrack,
	removeTrack,
	type TimelineTrack,
	toggleLocked,
	toggleMuted,
	toggleSolo,
	trackAtIndex,
} from "./timeline/trackModel";
import { genTransitionId, type Transition } from "./timeline/transitionModel";
import { buildAutoZoomSuggestions } from "./timeline/zoomSuggestionUtils";
import {
	type AnnotationRegion,
	type BlurData,
	clampFocusToDepth,
	DEFAULT_ANNOTATION_POSITION,
	DEFAULT_ANNOTATION_SIZE,
	DEFAULT_ANNOTATION_STYLE,
	DEFAULT_BLUR_DATA,
	DEFAULT_FIGURE_DATA,
	DEFAULT_PLAYBACK_SPEED,
	DEFAULT_ZOOM_DEPTH,
	type FigureData,
	type PlaybackSpeed,
	type Rotation3DPreset,
	type SpeedRegion,
	type TrimRegion,
	ZOOM_DEPTH_SCALES,
	type ZoomDepth,
	type ZoomFocus,
	type ZoomFocusMode,
	type ZoomRegion,
} from "./types";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";
import VideoPlayback, { VideoPlaybackRef } from "./VideoPlayback";

/** m:ss timecode for the status bar's total-duration readout. */
function formatTimecode(totalSec: number): string {
	const total = Math.max(0, Math.round(totalSec));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * A single top-bar dropdown (File / Edit / View / Help). Items map 1:1 to real
 * editor handlers; the menu is purely a surfacing layer over existing behaviour.
 */
type MenuEntry =
	| { kind: "item"; label: string; onSelect: () => void; disabled?: boolean; shortcut?: string }
	| { kind: "separator" }
	| { kind: "checkbox"; label: string; checked: boolean; onSelect: () => void };

function TopMenu({ label, items }: { label: string; items: MenuEntry[] }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="rounded-md px-2 py-1 text-[12.5px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
				>
					{label}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" sideOffset={4} className="min-w-[208px]">
				{items.map((entry, i) => {
					if (entry.kind === "separator") {
						return <DropdownMenuSeparator key={`sep-${i}`} />;
					}
					if (entry.kind === "checkbox") {
						return (
							<DropdownMenuCheckboxItem
								key={entry.label}
								checked={entry.checked}
								onCheckedChange={entry.onSelect}
							>
								{entry.label}
							</DropdownMenuCheckboxItem>
						);
					}
					return (
						<DropdownMenuItem key={entry.label} disabled={entry.disabled} onSelect={entry.onSelect}>
							{entry.label}
							{entry.shortcut && <DropdownMenuShortcut>{entry.shortcut}</DropdownMenuShortcut>}
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Single Sonner slot so auto-caption phases update in place instead of stacking. */
const AUTO_CAPTION_PROGRESS_TOAST_ID = "auto-caption-progress";

/** Placeholder clip length used when a seeded asset's real duration isn't known yet. */
const FALLBACK_CLIP_SECONDS = 5;

/** Keyboard nudge: one ~frame (30fps) for a plain Arrow, one second with Shift. */
const CLIP_NUDGE_STEP_SEC = 1 / 30;
const CLIP_NUDGE_STEP_LARGE_SEC = 1;

function isClickInteractionType(interactionType: string | null | undefined) {
	return (
		interactionType === "click" ||
		interactionType === "double-click" ||
		interactionType === "right-click" ||
		interactionType === "middle-click"
	);
}

interface ExportDiagnostics {
	formatLabel: "GIF" | "Video";
	reason?: string;
	sourcePath?: string | null;
	width?: number;
	height?: number;
	frameRate?: number;
	codec?: string;
	bitrate?: number;
}

function getFileNameForDiagnostics(filePath?: string | null) {
	if (!filePath) return "unknown";

	try {
		const url = new URL(filePath);
		if (url.protocol === "file:") {
			return decodeURIComponent(url.pathname).split(/[\\/]/).pop() || filePath;
		}
	} catch {
		// Treat non-URL values as filesystem paths.
	}

	return filePath.split(/[\\/]/).pop() || filePath;
}

function buildExportDiagnosticMessage(diagnostics: ExportDiagnostics) {
	const details = [
		diagnostics.reason ? `Reason: ${diagnostics.reason}` : null,
		`Source: ${getFileNameForDiagnostics(diagnostics.sourcePath)}`,
		diagnostics.width && diagnostics.height
			? `Output: ${diagnostics.width}x${diagnostics.height}${
					diagnostics.frameRate ? ` @ ${diagnostics.frameRate} fps` : ""
				}`
			: null,
		diagnostics.codec ? `Codec: ${diagnostics.codec}` : null,
		diagnostics.bitrate ? `Bitrate: ${Math.round(diagnostics.bitrate / 1_000_000)} Mbps` : null,
		`VideoEncoder: ${"VideoEncoder" in window ? "available" : "unavailable"}`,
	].filter(Boolean);

	return `${diagnostics.formatLabel} export failed\n${details.join("\n")}`;
}

function buildSaveDiagnosticMessage(formatLabel: "GIF" | "Video", reason?: string) {
	return `${formatLabel} export save failed${reason ? `\nReason: ${reason}` : ""}`;
}

const CAPTION_WORD_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

// The cutti actions (字幕 / 初剪 / AI 剪) are tucked from the topbar for now — they
// belong at a more contextual moment (e.g. once a source is loaded / transcribed).
// The handlers stay wired; flip this to surface the toolbar buttons again.
const SHOW_CUTTI_TOOLBAR = false;

export default function VideoEditor() {
	const {
		state: editorState,
		pushState,
		updateState,
		commitState,
		replacePresent,
		undo,
		redo,
		resetState,
	} = useEditorHistory(INITIAL_EDITOR_STATE);

	const {
		zoomRegions,
		autoZoomEnabled,
		autoFocusAll,
		trimRegions,
		speedRegions,
		annotationRegions,
		cropRegion,
		wallpaper,
		shadowIntensity,
		showBlur,
		showTrimWaveform,
		motionBlurAmount,
		borderRadius,
		padding,
		aspectRatio,
		webcamLayoutPreset,
		webcamMaskShape,
		webcamMirrored,
		webcamReactiveZoom,
		webcamSizePreset,
		webcamPosition,
		// Standard-NLE timeline clips/tracks now live in the unified undo stack so
		// every clip + track edit participates in Cmd+Z / Cmd+Y.
		timelineClips: clips,
		tracks,
		transitions,
	} = editorState;

	// Non-undoable state
	const [videoPath, setVideoPath] = useState<string | null>(null);
	// A project is the document; the video is a source you add into it. `projectOpen`
	// lets you enter the editor with a project but no video yet (new empty project, or
	// a saved project whose source isn't attached) — project ≠ video.
	const [projectOpen, setProjectOpen] = useState(false);
	// The project's media library (every imported source). Standard-NLE foundation:
	// sources picked here become the preview source today, timeline clips next.
	const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
	const addMediaAsset = useCallback((path: string) => {
		setMediaAssets((prev) =>
			prev.some((a) => a.path === path)
				? prev
				: [
						...prev,
						{ id: globalThis.crypto.randomUUID(), path, name: path.split(/[\\/]/).pop() ?? path },
					],
		);
	}, []);
	// `clips` (timelineClips) and `tracks` are read from the undo-stack present
	// above; every mutation routes through pushState/updateState/replacePresent so
	// clip + track edits are undoable. Clips are seeded from library assets and
	// edited in <ClipTimeline/>; the active clip drives the single-source preview.
	// Multi-selection: every selected timeline clip id. Bulk ops (move / delete /
	// duplicate / nudge / split, and the inspector's bulk affordances) act on the
	// whole set; the single-clip inspector keys off the derived `selectedClipId`
	// below (exactly one selected).
	const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
	const selectedClipId = selectedClipIds.length === 1 ? selectedClipIds[0] : null;
	// Copy/paste buffer for the standard-NLE clip shortcuts (Cmd/Ctrl+C / +V).
	const [clipboard, setClipboard] = useState<TimelineClip[]>([]);
	const [videoSourcePath, setVideoSourcePath] = useState<string | null>(null);
	const [webcamVideoPath, setWebcamVideoPath] = useState<string | null>(null);
	const [webcamVideoSourcePath, setWebcamVideoSourcePath] = useState<string | null>(null);
	const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState(0);
	const currentTimeRef = useRef(currentTime);
	currentTimeRef.current = currentTime;
	const durationRef = useRef(duration);
	durationRef.current = duration;
	const isPlayingRef = useRef(isPlaying);
	isPlayingRef.current = isPlaying;
	const clipsRef = useRef(clips);
	clipsRef.current = clips;
	const tracksRef = useRef(tracks);
	tracksRef.current = tracks;
	const selectedClipIdsRef = useRef(selectedClipIds);
	selectedClipIdsRef.current = selectedClipIds;
	const clipboardRef = useRef(clipboard);
	clipboardRef.current = clipboard;
	const videoSourcePathRef = useRef(videoSourcePath);
	videoSourcePathRef.current = videoSourcePath;
	// The clip currently driving the single-source preview during sequence playback
	// (multi-clip v1). Source-relative video time is mapped back to timeline time
	// against this clip; advancing past its source out-point hops to the next clip.
	const activeClipRef = useRef<TimelineClip | null>(null);
	// A source switch remounts <VideoPlayback>, so the seek (and optional resume)
	// can't happen synchronously — stash it and apply once the new <video> is ready.
	const pendingSourceSeekRef = useRef<{ offsetSec: number; play: boolean } | null>(null);
	// Timeline length = the whole clip sequence when clips exist; otherwise the
	// single source's duration (legacy single-source preview, unchanged).
	const timelineDuration = useMemo(
		() => (clips.length > 0 ? clipsTotalDuration(clips) : duration),
		[clips, duration],
	);
	// The video clip under the playhead — the single source of truth for which
	// source the preview should be showing. Recomputed each tick (cheap); the sync
	// effect below only acts when the clip *identity* changes.
	const activeClip = useMemo(
		() => (clips.length > 0 ? clipAtTime(clips, currentTime) : null),
		[clips, currentTime],
	);
	const activeClipId = activeClip?.id ?? null;
	// The clip whose properties the left inspector edits (timeline selection).
	const selectedClip = useMemo(
		() => clips.find((c) => c.id === selectedClipId) ?? null,
		[clips, selectedClipId],
	);
	const handleClipChange = useCallback(
		(patch: Partial<TimelineClip>) => {
			pushState((prev) => ({
				timelineClips: prev.timelineClips.map((c) =>
					c.id === selectedClipId ? { ...c, ...patch } : c,
				),
			}));
		},
		[selectedClipId, pushState],
	);
	// Live inspector edit (slider/number drag): stream through the preview channel
	// (checkpoint-once-then-mutate) so the whole gesture seals into one undo step
	// on commit — same pattern as a timeline move/trim drag.
	const handleClipChangePreview = useCallback(
		(patch: Partial<TimelineClip>) => {
			updateState((prev) => ({
				timelineClips: prev.timelineClips.map((c) =>
					c.id === selectedClipId ? { ...c, ...patch } : c,
				),
			}));
		},
		[selectedClipId, updateState],
	);
	// Bulk inspector edit (>1 selected): apply a patch to every selected clip on
	// an UNLOCKED lane — one undo step. Locked-lane clips stay part of the visual
	// selection but skip the edit (mirrors the keyboard/drag lock guards).
	const handleSelectedClipsChange = useCallback(
		(patch: Partial<TimelineClip>) => {
			pushState((prev) => {
				const sel = new Set(selectedClipIdsRef.current);
				return {
					timelineClips: prev.timelineClips.map((c) =>
						sel.has(c.id) && !isTrackLocked(prev.tracks, c.trackIndex) ? { ...c, ...patch } : c,
					),
				};
			});
		},
		[pushState],
	);
	// Bulk delete (inspector >1 path): drop every selected unlocked clip as one
	// undo step, then clear the selection.
	const handleDeleteSelectedClips = useCallback(() => {
		pushState((prev) => {
			const sel = new Set(selectedClipIdsRef.current);
			return {
				timelineClips: prev.timelineClips.filter(
					(c) => !(sel.has(c.id) && !isTrackLocked(prev.tracks, c.trackIndex)),
				),
			};
		});
		setSelectedClipIds([]);
	}, [pushState]);

	// ClipTimeline edit channels. Toolbar split/ripple/delete are discrete edits →
	// one undo step each. A move/trim drag streams through the preview channel
	// (checkpoint-once-then-mutate) and seals into a single step on commit.
	const handleClipsChange = useCallback(
		(next: TimelineClip[]) => {
			pushState({ timelineClips: next });
		},
		[pushState],
	);
	const handleClipsDragPreview = useCallback(
		(next: TimelineClip[]) => {
			updateState({ timelineClips: next });
		},
		[updateState],
	);
	const handleClipsDragCommit = useCallback(() => {
		commitState();
	}, [commitState]);

	// Per-track lane controls (mute / solo / lock + add / remove). Pure helpers in
	// ./timeline/trackModel; removing a lane also drops its clips and re-indexes
	// the lanes/clips above it so the two arrays stay in lockstep.
	const handleToggleTrackMuted = useCallback(
		(index: number) => {
			pushState((prev) => ({ tracks: toggleMuted(prev.tracks, index) }));
		},
		[pushState],
	);
	const handleToggleTrackSolo = useCallback(
		(index: number) => {
			pushState((prev) => ({ tracks: toggleSolo(prev.tracks, index) }));
		},
		[pushState],
	);
	const handleToggleTrackLocked = useCallback(
		(index: number) => {
			pushState((prev) => ({ tracks: toggleLocked(prev.tracks, index) }));
		},
		[pushState],
	);
	const handleAddTrack = useCallback(() => {
		pushState((prev) => ({ tracks: addTrack(prev.tracks) }));
	}, [pushState]);
	const handleRemoveTrack = useCallback(
		(index: number) => {
			// Removing a lane drops its clips and re-indexes the lanes/clips above it
			// — one atomic undo entry covering BOTH arrays.
			pushState((prev) => ({
				tracks: removeTrack(prev.tracks, index),
				timelineClips: reindexClipsForRemovedTrack(prev.timelineClips, index),
			}));
			// Drop any selected clip that lived on the removed lane (non-undoable).
			setSelectedClipIds((prev) =>
				prev.filter((id) => {
					const sel = clipsRef.current.find((c) => c.id === id);
					return !(sel && sel.trackIndex === index);
				}),
			);
		},
		[pushState],
	);

	// Crossfade transitions. Adding marks an existing same-track overlap as a
	// crossfade; removing drops it. Each is one undo step. Transitions never move a
	// clip — the blend window is derived from the clips' live positions, so a
	// transition auto-drops (via activeTransitions) once its clips stop overlapping.
	const handleAddTransition = useCallback(
		(fromClipId: string, toClipId: string) => {
			pushState((prev) => {
				// Don't double-mark the same overlap pair.
				const exists = prev.transitions.some(
					(t) =>
						(t.fromClipId === fromClipId && t.toClipId === toClipId) ||
						(t.fromClipId === toClipId && t.toClipId === fromClipId),
				);
				if (exists) return {};
				return {
					transitions: [...prev.transitions, { id: genTransitionId(), fromClipId, toClipId }],
				};
			});
		},
		[pushState],
	);
	const handleRemoveTransition = useCallback(
		(id: string) => {
			pushState((prev) => ({ transitions: prev.transitions.filter((t) => t.id !== id) }));
		},
		[pushState],
	);

	const [selectedZoomId, setSelectedZoomId] = useState<string | null>(null);
	const [isPreviewingZoom, setIsPreviewingZoom] = useState(false);
	const [selectedTrimId, setSelectedTrimId] = useState<string | null>(null);
	const [selectedSpeedId, setSelectedSpeedId] = useState<string | null>(null);
	const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
	const [selectedBlurId, setSelectedBlurId] = useState<string | null>(null);
	const [isExporting, setIsExporting] = useState(false);
	const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
	const [exportError, setExportError] = useState<string | null>(null);
	const [showExportDialog, setShowExportDialog] = useState(false);
	const [showNewRecordingDialog, setShowNewRecordingDialog] = useState(false);
	// Help → Tutorial opens the existing <TutorialHelp> dialog (now controllable).
	const [showTutorial, setShowTutorial] = useState(false);
	// Edge/playhead snapping lives here so the View → Toggle Snapping menu item and
	// the timeline magnet button share one source of truth.
	const [snapEnabled, setSnapEnabled] = useState(true);
	const toggleSnapEnabled = useCallback(() => setSnapEnabled((s) => !s), []);
	// Imperative timeline controls for the View menu (zoom in / out / fit).
	const clipTimelineRef = useRef<ClipTimelineHandle>(null);
	const [exportQuality, setExportQuality] = useState<ExportQuality>(
		DEFAULT_EXPORT_SETTINGS.quality,
	);
	const [exportFormat, setExportFormat] = useState<ExportFormat>(DEFAULT_EXPORT_SETTINGS.format);
	const [gifFrameRate, setGifFrameRate] = useState<GifFrameRate>(DEFAULT_GIF_SETTINGS.frameRate);
	const [gifLoop, setGifLoop] = useState(DEFAULT_GIF_SETTINGS.loop);
	const [gifSizePreset, setGifSizePreset] = useState<GifSizePreset>(
		DEFAULT_GIF_SETTINGS.sizePreset,
	);
	const [exportedFilePath, setExportedFilePath] = useState<string | null>(null);
	const [lastSavedSnapshot, setLastSavedSnapshot] = useState<string | null>(null);
	const [unsavedExport, setUnsavedExport] = useState<{
		arrayBuffer: ArrayBuffer;
		fileName: string;
		format: string;
	} | null>(null);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [showCloseConfirmDialog, setShowCloseConfirmDialog] = useState(false);
	// Unsaved-changes confirmation for New Project / Load Project.
	// The window-close flow uses showCloseConfirmDialog above.
	const [confirmDialogVariant, setConfirmDialogVariant] = useState<
		"newProject" | "loadProject" | null
	>(null);
	const playerContainerRef = useRef<HTMLDivElement | null>(null);
	const cursorTelemetrySourcePath = videoSourcePath ?? (videoPath ? fromFileUrl(videoPath) : null);
	const { samples: cursorTelemetry, error: cursorTelemetryError } =
		useCursorTelemetry(cursorTelemetrySourcePath);
	const { data: cursorRecordingData, error: cursorRecordingDataError } =
		useCursorRecordingData(cursorTelemetrySourcePath);
	const cursorClickTimestamps = useMemo<number[]>(() => {
		const recordingSamples = Array.isArray(cursorRecordingData?.samples)
			? cursorRecordingData.samples
			: [];
		const recordingClicks = recordingSamples
			.filter((sample) => isClickInteractionType(sample.interactionType))
			.map((sample) => sample.timeMs);
		if (recordingClicks.length > 0) {
			return recordingClicks;
		}

		return (Array.isArray(cursorTelemetry) ? cursorTelemetry : [])
			.filter((sample) => isClickInteractionType(sample.interactionType))
			.map((sample) => sample.timeMs);
	}, [cursorRecordingData, cursorTelemetry]);

	// Cursor & motion blur visual settings (non-undoable preferences)
	const [showCursor, setShowCursor] = useState(DEFAULT_CURSOR_SETTINGS.show);
	const [cursorSize, setCursorSize] = useState(DEFAULT_CURSOR_SETTINGS.size);
	const [cursorSmoothing, setCursorSmoothing] = useState(DEFAULT_CURSOR_SETTINGS.smoothing);
	const [cursorMotionBlur, setCursorMotionBlur] = useState(DEFAULT_CURSOR_SETTINGS.motionBlur);
	const [cursorClickBounce, setCursorClickBounce] = useState(DEFAULT_CURSOR_SETTINGS.clickBounce);
	const [cursorClipToBounds, setCursorClipToBounds] = useState(
		DEFAULT_CURSOR_SETTINGS.clipToBounds,
	);
	const [cursorTheme, setCursorTheme] = useState(DEFAULT_CURSOR_SETTINGS.theme);
	const [nativePlatform, setNativePlatform] = useState<NativePlatform | null>(null);
	const [recordingCursorCaptureMode, setRecordingCursorCaptureMode] =
		useState<CursorCaptureMode | null>(null);

	const videoPlaybackRef = useRef<VideoPlaybackRef>(null);

	const nextZoomIdRef = useRef(1);
	const nextTrimIdRef = useRef(1);
	const nextSpeedIdRef = useRef(1);

	const { shortcuts, isMac, openConfig } = useShortcuts();
	// Windows recordings include captured cursor assets. macOS hides the system
	// cursor in ScreenCaptureKit and renders telemetry samples with OpenScreen's
	// default arrow asset for the editable overlay.
	const hasEditableCursorRecording =
		recordingCursorCaptureMode === "editable-overlay" &&
		(nativePlatform === "win32" || nativePlatform === "darwin") &&
		hasNativeCursorRecordingData(cursorRecordingData);
	const effectiveShowCursor = showCursor && hasEditableCursorRecording;
	const showCursorSettings = hasEditableCursorRecording;
	const { locale, setLocale, t: rawT } = useI18n();
	const t = useScopedT("editor");
	const ts = useScopedT("settings");
	const availableLocales = getAvailableLocales();

	const nextAnnotationIdRef = useRef(1);
	const nextAnnotationZIndexRef = useRef(1);
	const isAutoCaptioningRef = useRef(false);
	const [isAutoCaptioning, setIsAutoCaptioning] = useState(false);
	const [showAutoCaptionsDialog, setShowAutoCaptionsDialog] = useState(false);
	const [captionWordsMin, setCaptionWordsMin] = useState(2);
	const [captionWordsMax, setCaptionWordsMax] = useState(7);
	const exporterRef = useRef<VideoExporter | null>(null);

	const annotationOnlyRegions = useMemo(
		() => annotationRegions.filter((region) => region.type !== "blur"),
		[annotationRegions],
	);
	const blurRegions = useMemo(
		() => annotationRegions.filter((region) => region.type === "blur"),
		[annotationRegions],
	);

	const currentProjectMedia = useMemo<ProjectMedia | null>(() => {
		const screenVideoPath = videoSourcePath ?? (videoPath ? fromFileUrl(videoPath) : null);
		if (!screenVideoPath) {
			return null;
		}

		const webcamSourcePath =
			webcamVideoSourcePath ?? (webcamVideoPath ? fromFileUrl(webcamVideoPath) : null);
		return {
			screenVideoPath,
			...(webcamSourcePath ? { webcamVideoPath: webcamSourcePath } : {}),
			...(recordingCursorCaptureMode ? { cursorCaptureMode: recordingCursorCaptureMode } : {}),
		};
	}, [
		videoPath,
		videoSourcePath,
		webcamVideoPath,
		webcamVideoSourcePath,
		recordingCursorCaptureMode,
	]);

	const applyLoadedProject = useCallback(
		async (candidate: unknown, path?: string | null) => {
			if (!validateProjectData(candidate)) {
				return false;
			}

			const project = candidate;
			// A project is video-decoupled: it may have no media yet (a saved empty
			// project, or one whose source isn't attached). Open it either way.
			const projectMedia = resolveProjectMedia(project);
			const sourcePath = projectMedia?.screenVideoPath ?? null;
			const webcamSourcePath = projectMedia?.webcamVideoPath ?? null;
			const projectCursorCaptureMode = projectMedia?.cursorCaptureMode ?? null;
			const normalizedEditor = normalizeProjectEditor(project.editor);
			const inferredDurationMs = Math.max(
				0,
				...normalizedEditor.zoomRegions.map((region) => region.endMs),
				...normalizedEditor.trimRegions.map((region) => region.endMs),
				...normalizedEditor.speedRegions.map((region) => region.endMs),
				...normalizedEditor.annotationRegions.map((region) => region.endMs),
			);

			try {
				videoPlaybackRef.current?.pause();
			} catch {
				// no-op
			}
			setIsPlaying(false);
			setCurrentTime(0);
			setDuration(inferredDurationMs > 0 ? inferredDurationMs / 1000 : 0);

			setError(null);
			setVideoSourcePath(sourcePath);
			setVideoPath(sourcePath ? toFileUrl(sourcePath) : null);
			setWebcamVideoSourcePath(webcamSourcePath);
			setWebcamVideoPath(webcamSourcePath ? toFileUrl(webcamSourcePath) : null);
			setRecordingCursorCaptureMode(projectCursorCaptureMode);
			setCurrentProjectPath(path ?? null);
			setProjectOpen(true);
			if (sourcePath) addMediaAsset(sourcePath);

			// A loaded project keeps its zooms exactly as saved, so never auto-suggest
			// over it (even if it has zero zooms because the user deleted them all).
			autoProcessedSourceRef.current = sourcePath;

			// Restore the clip timeline + lanes into the SAME history checkpoint as the
			// regions, so loading a project resets the undo stack to one clean baseline
			// (you can't Cmd+Z back into the prior project's clips). Falls back to an
			// empty timeline / default lanes when the project carries none.
			const restoredClips: TimelineClip[] = Array.isArray(project.timelineClips)
				? project.timelineClips
				: [];
			const restoredTracks: TimelineTrack[] =
				Array.isArray(project.tracks) && project.tracks.length > 0
					? project.tracks
					: Array.isArray(project.timelineClips)
						? defaultTracksForClips(project.timelineClips)
						: DEFAULT_TRACKS;
			const restoredTransitions: Transition[] = Array.isArray(project.transitions)
				? project.transitions
				: [];

			pushState({
				wallpaper: normalizedEditor.wallpaper,
				shadowIntensity: normalizedEditor.shadowIntensity,
				showBlur: normalizedEditor.showBlur,
				showTrimWaveform: normalizedEditor.showTrimWaveform,
				motionBlurAmount: normalizedEditor.motionBlurAmount,
				borderRadius: normalizedEditor.borderRadius,
				padding: normalizedEditor.padding,
				cropRegion: normalizedEditor.cropRegion,
				zoomRegions: normalizedEditor.zoomRegions,
				autoZoomEnabled: normalizedEditor.autoZoomEnabled,
				autoFocusAll: normalizedEditor.autoFocusAll,
				trimRegions: normalizedEditor.trimRegions,
				speedRegions: normalizedEditor.speedRegions,
				annotationRegions: normalizedEditor.annotationRegions,
				aspectRatio: normalizedEditor.aspectRatio,
				webcamLayoutPreset: normalizedEditor.webcamLayoutPreset,
				webcamMaskShape: normalizedEditor.webcamMaskShape,
				webcamMirrored: normalizedEditor.webcamMirrored,
				webcamReactiveZoom: normalizedEditor.webcamReactiveZoom,
				webcamSizePreset: normalizedEditor.webcamSizePreset,
				webcamPosition: normalizedEditor.webcamPosition,
				timelineClips: restoredClips,
				tracks: restoredTracks,
				transitions: restoredTransitions,
			});
			setExportQuality(normalizedEditor.exportQuality);
			setExportFormat(normalizedEditor.exportFormat);
			setGifFrameRate(normalizedEditor.gifFrameRate);
			setGifLoop(normalizedEditor.gifLoop);
			setGifSizePreset(normalizedEditor.gifSizePreset);
			setCursorTheme(normalizedEditor.cursorTheme);

			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);

			nextZoomIdRef.current = deriveNextId(
				"zoom",
				normalizedEditor.zoomRegions.map((region) => region.id),
			);
			nextTrimIdRef.current = deriveNextId(
				"trim",
				normalizedEditor.trimRegions.map((region) => region.id),
			);
			nextSpeedIdRef.current = deriveNextId(
				"speed",
				normalizedEditor.speedRegions.map((region) => region.id),
			);
			nextAnnotationIdRef.current = deriveNextId(
				"annotation",
				normalizedEditor.annotationRegions.map((region) => region.id),
			);
			nextAnnotationZIndexRef.current =
				normalizedEditor.annotationRegions.reduce(
					(max, region) => Math.max(max, region.zIndex),
					0,
				) + 1;

			setLastSavedSnapshot(
				sourcePath
					? createProjectSnapshot(
							{
								screenVideoPath: sourcePath,
								...(webcamSourcePath ? { webcamVideoPath: webcamSourcePath } : {}),
								...(projectCursorCaptureMode
									? { cursorCaptureMode: projectCursorCaptureMode }
									: {}),
							},
							normalizedEditor,
						)
					: null,
			);

			// Restore an explicit media library if the project carries one (newer
			// projects / hand-authored debug projects). Falls back to the auto-seed
			// (one clip per source) when absent. The clip timeline + lanes were already
			// restored above inside the same pushState checkpoint.
			if (Array.isArray(project.mediaLibrary) && project.mediaLibrary.length > 0) {
				setMediaAssets(project.mediaLibrary);
			}
			return true;
		},
		[addMediaAsset, pushState],
	);

	// Attach a video source into the currently-open project (from the no-source view).
	const handleImportVideoSource = useCallback(async () => {
		const result = await window.electronAPI.openVideoFilePicker();
		if (result.canceled || !result.success || !result.path) return;
		const setResult = await nativeBridgeClient.project.setCurrentVideoPath(result.path);
		if (!setResult.success) return;
		setError(null);
		setVideoSourcePath(result.path);
		setVideoPath(toFileUrl(result.path));
		setWebcamVideoPath(null);
		setWebcamVideoSourcePath(null);
		setProjectOpen(true);
		addMediaAsset(result.path);
	}, [addMediaAsset]);

	// Load an existing library asset into the preview (switch the active source).
	const selectMediaAsset = useCallback(async (asset: MediaAsset) => {
		const setResult = await nativeBridgeClient.project.setCurrentVideoPath(asset.path);
		if (!setResult.success) return;
		setError(null);
		setVideoSourcePath(asset.path);
		setVideoPath(toFileUrl(asset.path));
		setWebcamVideoPath(null);
		setWebcamVideoSourcePath(null);
		setProjectOpen(true);
	}, []);

	// Load a timeline clip's source into the preview (single active-clip preview;
	// reuses the selectMediaAsset flow). Multi-clip compositing is a later phase.
	const handleSelectClip = useCallback(
		async (clip: TimelineClip | null) => {
			// Plain select / clear: the selection becomes exactly this clip (or empty).
			setSelectedClipIds(clip ? [clip.id] : []);
			if (!clip || clip.sourcePath === videoSourcePath) return;
			const setResult = await nativeBridgeClient.project.setCurrentVideoPath(clip.sourcePath);
			if (!setResult.success) return;
			setError(null);
			setVideoSourcePath(clip.sourcePath);
			setVideoPath(toFileUrl(clip.sourcePath));
			setWebcamVideoPath(null);
			setWebcamVideoSourcePath(null);
			setProjectOpen(true);
		},
		[videoSourcePath],
	);
	const handleSelectClipRef = useRef(handleSelectClip);
	handleSelectClipRef.current = handleSelectClip;

	// Cmd/Ctrl-click or Shift-click: toggle one clip's membership in the selection.
	const handleToggleClipSelection = useCallback((clip: TimelineClip) => {
		setSelectedClipIds((prev) =>
			prev.includes(clip.id) ? prev.filter((id) => id !== clip.id) : [...prev, clip.id],
		);
	}, []);
	// Marquee drag-select result: replace the selection with the intersected ids.
	const handleSelectClipIds = useCallback((ids: string[]) => {
		setSelectedClipIds(ids);
	}, []);
	// Select a set of clips after a bulk op. One clip → reuse handleSelectClip so
	// the preview source follows it (single-select parity); many → just set ids.
	const selectClips = useCallback((sel: TimelineClip[]) => {
		if (sel.length === 1) {
			void handleSelectClipRef.current(sel[0]);
		} else {
			setSelectedClipIds(sel.map((c) => c.id));
		}
	}, []);
	const selectClipsRef = useRef(selectClips);
	selectClipsRef.current = selectClips;

	// Edit-menu clip ops. These mirror the keyboard handlers (split S/B, Cmd+D
	// duplicate, Delete) but are reachable from the top menu bar. Each acts on the
	// editable subset of the current selection (locked-lane clips are skipped) and
	// commits exactly one undo step — identical semantics to the shortcuts.
	const editableSelectedClips = useMemo(
		() =>
			clips.filter((c) => selectedClipIds.includes(c.id) && !isTrackLocked(tracks, c.trackIndex)),
		[clips, selectedClipIds, tracks],
	);
	const hasEditableSelection = editableSelectedClips.length > 0;
	const menuSplitClips = useCallback(() => {
		if (editableSelectedClips.length === 0) return;
		const at = currentTimeRef.current;
		const editableIds = new Set(editableSelectedClips.map((c) => c.id));
		const newSel: string[] = [];
		let changed = false;
		const next = clipsRef.current.flatMap((c) => {
			if (!editableIds.has(c.id)) return [c];
			const halves = splitClipAt(c, at, genClipId);
			if (!halves) {
				newSel.push(c.id);
				return [c];
			}
			changed = true;
			newSel.push(halves[0].id, halves[1].id);
			return halves;
		});
		if (changed) {
			pushState({ timelineClips: next });
			setSelectedClipIds(newSel);
		}
	}, [editableSelectedClips, pushState]);
	const menuDuplicateClips = useCallback(() => {
		if (editableSelectedClips.length === 0) return;
		const dups = editableSelectedClips.map((c) => duplicateClip(c, genClipId));
		pushState((prev) => ({ timelineClips: [...prev.timelineClips, ...dups] }));
		selectClipsRef.current(dups);
	}, [editableSelectedClips, pushState]);
	const menuDeleteClips = useCallback(() => {
		if (editableSelectedClips.length === 0) return;
		const ids = new Set(editableSelectedClips.map((c) => c.id));
		pushState((prev) => ({
			timelineClips: prev.timelineClips.filter((c) => !ids.has(c.id)),
		}));
		setSelectedClipIds([]);
	}, [editableSelectedClips, pushState]);

	// Point the single <video> at a different source. Switching `videoPath` remounts
	// <VideoPlayback> (its `key` includes the path), so any follow-up seek/resume is
	// deferred via pendingSourceSeekRef and applied once the new element is ready.
	const switchSource = useCallback(async (sourcePath: string) => {
		const setResult = await nativeBridgeClient.project.setCurrentVideoPath(sourcePath);
		if (!setResult.success) return;
		setError(null);
		setVideoSourcePath(sourcePath);
		setVideoPath(toFileUrl(sourcePath));
		setWebcamVideoPath(null);
		setWebcamVideoSourcePath(null);
	}, []);

	// Timeline → source sync (multi-clip v1). Keyed on the *active clip identity* so
	// it only fires when the playhead crosses into a different clip (or a gap), not
	// on every playback tick. Manual seeks within the loaded clip are handled
	// directly in handleSeek; this effect covers playback-driven clip advances and
	// any out-of-band clip/selection change.
	useEffect(() => {
		if (clipsRef.current.length === 0) {
			activeClipRef.current = null;
			return;
		}
		const clip = activeClipId
			? (clipsRef.current.find((c) => c.id === activeClipId) ?? null)
			: null;
		if (!clip) {
			// Gap or empty span under the playhead: nothing to show, stop playing.
			activeClipRef.current = null;
			if (isPlayingRef.current) {
				try {
					videoPlaybackRef.current?.pause();
				} catch {
					// no-op
				}
			}
			return;
		}
		activeClipRef.current = clip;
		const offsetSec = clip.inSec + Math.max(0, currentTimeRef.current - clip.startSec);
		if (clip.sourcePath !== videoSourcePathRef.current) {
			// Different source → remount + deferred seek (resume if we were playing).
			pendingSourceSeekRef.current = { offsetSec, play: isPlayingRef.current };
			void switchSource(clip.sourcePath);
		} else {
			// Same source already loaded (e.g. two clips cut from one file): seek in place.
			const video = videoPlaybackRef.current?.video;
			if (video && Math.abs(video.currentTime - offsetSec) > 0.08) {
				try {
					video.currentTime = offsetSec;
				} catch {
					// no-op
				}
			}
		}
	}, [activeClipId, switchSource]);

	// Apply a deferred seek (and optional resume) after a source switch remounts the
	// <video>. The element loads async, so retry until metadata is available. Pure
	// defensive polling — never throws, gives up after ~2s.
	// biome-ignore lint/correctness/useExhaustiveDependencies: videoSourcePath is the trigger — re-run when the source switches so the pending seek lands on the new element
	useEffect(() => {
		const pending = pendingSourceSeekRef.current;
		if (!pending) return;
		let raf = 0;
		let tries = 0;
		const apply = () => {
			const video = videoPlaybackRef.current?.video;
			if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
				try {
					video.currentTime = pending.offsetSec;
				} catch {
					// no-op
				}
				if (pending.play) {
					videoPlaybackRef.current?.play().catch(() => {
						// Resume is best-effort; the user can press play.
					});
				}
				pendingSourceSeekRef.current = null;
				return;
			}
			if (tries++ < 120) {
				raf = requestAnimationFrame(apply);
			} else {
				pendingSourceSeekRef.current = null;
			}
		};
		raf = requestAnimationFrame(apply);
		return () => cancelAnimationFrame(raf);
	}, [videoSourcePath]);

	// Playback clock: the playing <video> reports source-relative time; map it back
	// to *timeline* time against the active clip, and advance to the next clip when
	// we reach the clip's source out-point (or the element ends). With 0 clips this
	// is the legacy identity mapping (currentTime = video.currentTime), unchanged.
	const handleVideoTime = useCallback((videoTime: number) => {
		const list = clipsRef.current;
		if (list.length === 0) {
			setCurrentTime(videoTime);
			return;
		}
		const active = activeClipRef.current;
		if (!active) return; // gap / mid-switch — the sync effect owns the source
		const ended = videoPlaybackRef.current?.video?.ended ?? false;
		// Reaching the clip's source out-point (small lead so timeupdate granularity
		// doesn't overshoot into the next source's frames) → hop to the next clip.
		if (ended || videoTime >= active.outSec - 0.04) {
			const ns = nextClipStart(list, active.startSec);
			if (ns != null) {
				// Clearing the ref makes onTimeUpdate idle until the sync effect (driven
				// by the new currentTime) loads + seeks the next clip and resumes.
				activeClipRef.current = null;
				setCurrentTime(ns);
			} else {
				// End of the sequence: stop and clamp to the very end.
				try {
					videoPlaybackRef.current?.pause();
				} catch {
					// no-op
				}
				setIsPlaying(false);
				setCurrentTime(clipEndSec(active));
			}
			return;
		}
		const timelineSec = active.startSec + (videoTime - active.inSec);
		const clamped = Math.min(Math.max(timelineSec, active.startSec), clipEndSec(active));
		// Per-clip audio: apply the clip's gain envelope + mute to the <video> element.
		const video = videoPlaybackRef.current?.video;
		if (video) {
			// Per-clip envelope gated by the clip's lane (mute / solo / fade).
			const list = tracksRef.current;
			const track = trackAtIndex(list, active.trackIndex);
			video.volume = Math.max(0, Math.min(1, effectiveClipGain(active, track, list, clamped)));
			video.muted = Boolean(active.muted);
		}
		setCurrentTime(clamped);
	}, []);

	// Drop a bin asset onto the timeline: build a new clip at the dropped lane +
	// position. Length is the asset's real duration when it's the active source
	// (already loaded), else the placeholder — refined later by the duration effect.
	const handleAddClipFromBin = useCallback(
		(asset: MediaAsset, trackIndex: number, startSec: number) => {
			const out = asset.path === videoSourcePath && duration > 0 ? duration : FALLBACK_CLIP_SECONDS;
			const clip: TimelineClip = {
				id: genClipId(),
				assetId: asset.id,
				name: asset.name,
				sourcePath: asset.path,
				trackIndex,
				startSec: Math.max(0, startSec),
				inSec: 0,
				outSec: out,
			};
			pushState((prev) => ({ timelineClips: [...prev.timelineClips, clip] }));
		},
		[videoSourcePath, duration, pushState],
	);

	// Seed: every library asset gets at least one clip, appended to the end of
	// video track 0. Real duration may not be known yet (loads async) — fall back
	// to a placeholder and refine it once the active source reports its duration.
	// This is DERIVED state (reactive seeding), not a user gesture, so it goes
	// through replacePresent — a silent present mutation that creates no undo step.
	useEffect(() => {
		const prev = clipsRef.current;
		const seen = new Set(prev.map((c) => c.assetId));
		let working = prev;
		let added = false;
		for (const asset of mediaAssets) {
			if (seen.has(asset.id)) continue;
			const out = asset.path === videoSourcePath && duration > 0 ? duration : FALLBACK_CLIP_SECONDS;
			working = [
				...working,
				{
					id: genClipId(),
					assetId: asset.id,
					name: asset.name,
					sourcePath: asset.path,
					trackIndex: 0,
					startSec: trackEndSec(working, 0),
					inSec: 0,
					outSec: out,
				},
			];
			added = true;
		}
		if (added) replacePresent({ timelineClips: working });
	}, [mediaAssets, videoSourcePath, duration, replacePresent]);

	// Refine a placeholder-length seeded clip once its source's real duration loads.
	// Also derived (non-undoable) — routed through replacePresent.
	useEffect(() => {
		if (duration <= 0 || !videoSourcePath) return;
		const prev = clipsRef.current;
		let changed = false;
		const next = prev.map((c) => {
			if (c.sourcePath === videoSourcePath && c.inSec === 0 && c.outSec === FALLBACK_CLIP_SECONDS) {
				changed = true;
				return { ...c, outSec: duration };
			}
			return c;
		});
		if (changed) replacePresent({ timelineClips: next });
	}, [duration, videoSourcePath, replacePresent]);

	// Remove an asset from the library; drop its clips and, if it was the active
	// source, clear the preview.
	const removeMediaAsset = useCallback(
		(asset: MediaAsset) => {
			setMediaAssets((prev) => prev.filter((a) => a.id !== asset.id));
			pushState((prev) => ({
				timelineClips: prev.timelineClips.filter((c) => c.assetId !== asset.id),
			}));
			if (videoSourcePath === asset.path) {
				setVideoSourcePath(null);
				setVideoPath(null);
				setError(null);
			}
		},
		[videoSourcePath, pushState],
	);

	// Import video files dropped onto the bin: add all, load the first into the preview.
	const importMediaPaths = useCallback(
		async (paths: string[]) => {
			for (const p of paths) addMediaAsset(p);
			const first = paths[0];
			if (!first) return;
			const setResult = await nativeBridgeClient.project.setCurrentVideoPath(first);
			if (!setResult.success) return;
			setError(null);
			setVideoSourcePath(first);
			setVideoPath(toFileUrl(first));
			setWebcamVideoPath(null);
			setWebcamVideoSourcePath(null);
			setProjectOpen(true);
		},
		[addMediaAsset],
	);

	const currentProjectSnapshot = useMemo(() => {
		if (!currentProjectMedia) {
			return null;
		}
		return createProjectSnapshot(currentProjectMedia, {
			wallpaper,
			shadowIntensity,
			showBlur,
			showTrimWaveform,
			motionBlurAmount,
			borderRadius,
			padding,
			cropRegion,
			zoomRegions,
			autoZoomEnabled,
			autoFocusAll,
			trimRegions,
			speedRegions,
			annotationRegions,
			aspectRatio,
			webcamLayoutPreset,
			webcamMaskShape,
			webcamMirrored,
			webcamReactiveZoom,
			webcamSizePreset,
			webcamPosition,
			exportQuality,
			exportFormat,
			gifFrameRate,
			gifLoop,
			gifSizePreset,
			cursorTheme,
		});
	}, [
		currentProjectMedia,
		cursorTheme,
		wallpaper,
		shadowIntensity,
		showBlur,
		showTrimWaveform,
		motionBlurAmount,
		borderRadius,
		padding,
		cropRegion,
		zoomRegions,
		autoZoomEnabled,
		autoFocusAll,
		trimRegions,
		speedRegions,
		annotationRegions,
		aspectRatio,
		webcamLayoutPreset,
		webcamMaskShape,
		webcamMirrored,
		webcamReactiveZoom,
		webcamSizePreset,
		webcamPosition,
		exportQuality,
		exportFormat,
		gifFrameRate,
		gifLoop,
		gifSizePreset,
	]);

	const hasUnsavedChanges = hasProjectUnsavedChanges(currentProjectSnapshot, lastSavedSnapshot);

	useEffect(() => {
		async function loadInitialData() {
			try {
				const currentProjectResult = await nativeBridgeClient.project.loadCurrentProjectFile();
				if (currentProjectResult.success && currentProjectResult.project) {
					const restored = await applyLoadedProject(
						currentProjectResult.project,
						currentProjectResult.path ?? null,
					);
					if (restored) {
						return;
					}
				}

				const currentSessionResult = await window.electronAPI.getCurrentRecordingSession();
				if (currentSessionResult.success && currentSessionResult.session) {
					const session = currentSessionResult.session;
					const sourcePath = fromFileUrl(session.screenVideoPath);
					const webcamSourcePath = session.webcamVideoPath
						? fromFileUrl(session.webcamVideoPath)
						: null;
					setVideoSourcePath(sourcePath);
					setVideoPath(toFileUrl(sourcePath));
					setWebcamVideoSourcePath(webcamSourcePath);
					setWebcamVideoPath(webcamSourcePath ? toFileUrl(webcamSourcePath) : null);
					setRecordingCursorCaptureMode(session.cursorCaptureMode ?? null);
					setCurrentProjectPath(null);
					addMediaAsset(sourcePath);
					setLastSavedSnapshot(
						createProjectSnapshot(
							{
								screenVideoPath: sourcePath,
								...(webcamSourcePath ? { webcamVideoPath: webcamSourcePath } : {}),
								...(session.cursorCaptureMode
									? { cursorCaptureMode: session.cursorCaptureMode }
									: {}),
							},
							INITIAL_EDITOR_STATE,
						),
					);
					return;
				}

				const result = await nativeBridgeClient.project.getCurrentVideoPath();
				if (result.success && result.path) {
					setVideoSourcePath(result.path);
					setVideoPath(toFileUrl(result.path));
					setRecordingCursorCaptureMode(null);
					setCurrentProjectPath(null);
					setLastSavedSnapshot(
						createProjectSnapshot({ screenVideoPath: result.path }, INITIAL_EDITOR_STATE),
					);
					addMediaAsset(result.path);
				}
				// No video/project/session, so leave videoPath null and let the
				// EditorEmptyState dashboard render instead of an error screen.
			} catch (err) {
				setError("Error loading video: " + String(err));
			} finally {
				setLoading(false);
			}
		}

		loadInitialData();
	}, [addMediaAsset, applyLoadedProject]);

	// Avoid overwriting saved prefs with defaults before they've loaded.
	const [prefsHydrated, setPrefsHydrated] = useState(false);

	// Load persisted user preferences on mount (intentionally runs once)
	useEffect(() => {
		const prefs = loadUserPreferences();
		updateState({
			padding: prefs.padding,
			aspectRatio: prefs.aspectRatio,
		});
		setExportQuality(prefs.exportQuality);
		setExportFormat(prefs.exportFormat);
		setPrefsHydrated(true);
	}, [updateState]);

	// Auto-save user preferences when settings change
	useEffect(() => {
		if (!prefsHydrated) return;
		saveUserPreferences({ padding, aspectRatio, exportQuality, exportFormat });
	}, [prefsHydrated, padding, aspectRatio, exportQuality, exportFormat]);

	const saveProject = useCallback(
		async (forceSaveAs: boolean) => {
			if (!videoPath) {
				toast.error(t("errors.noVideoLoaded"));
				return false;
			}

			if (!currentProjectMedia) {
				toast.error(t("errors.unableToDetermineSourcePath"));
				return false;
			}

			const editorState = {
				wallpaper,
				shadowIntensity,
				showBlur,
				showTrimWaveform,
				motionBlurAmount,
				borderRadius,
				padding,
				cropRegion,
				zoomRegions,
				autoZoomEnabled,
				autoFocusAll,
				trimRegions,
				speedRegions,
				annotationRegions,
				aspectRatio,
				webcamLayoutPreset,
				webcamMaskShape,
				webcamMirrored,
				webcamReactiveZoom,
				webcamSizePreset,
				webcamPosition,
				exportQuality,
				exportFormat,
				gifFrameRate,
				gifLoop,
				gifSizePreset,
				cursorTheme,
			};
			const projectData = createProjectData(currentProjectMedia, editorState);

			const fileNameBase =
				currentProjectMedia.screenVideoPath
					.split(/[\\/]/)
					.pop()
					?.replace(/\.[^.]+$/, "") || `project-${Date.now()}`;
			// Normalize the same way as currentProjectSnapshot so the post-save
			// baseline compares equal and hasUnsavedChanges clears.
			const projectSnapshot = createProjectSnapshot(currentProjectMedia, editorState);
			const result = await nativeBridgeClient.project.saveProjectFile(
				projectData,
				fileNameBase,
				forceSaveAs ? undefined : (currentProjectPath ?? undefined),
			);

			if (result.canceled) {
				toast.info(t("project.saveCanceled"));
				return false;
			}

			if (!result.success) {
				toast.error(result.message || t("project.failedToSave"));
				return false;
			}

			if (result.path) {
				setCurrentProjectPath(result.path);
			}
			setLastSavedSnapshot(projectSnapshot);

			toast.success(t("project.savedTo", { path: result.path ?? "" }));
			return true;
		},
		[
			currentProjectMedia,
			currentProjectPath,
			wallpaper,
			shadowIntensity,
			showBlur,
			showTrimWaveform,
			motionBlurAmount,
			borderRadius,
			padding,
			cropRegion,
			zoomRegions,
			autoZoomEnabled,
			autoFocusAll,
			trimRegions,
			speedRegions,
			annotationRegions,
			aspectRatio,
			webcamLayoutPreset,
			webcamMaskShape,
			webcamMirrored,
			webcamReactiveZoom,
			webcamSizePreset,
			webcamPosition,
			exportQuality,
			exportFormat,
			gifFrameRate,
			gifLoop,
			gifSizePreset,
			cursorTheme,
			videoPath,
			t,
		],
	);

	useEffect(() => {
		window.electronAPI.setHasUnsavedChanges(hasUnsavedChanges);
	}, [hasUnsavedChanges]);

	useEffect(() => {
		const cleanup = window.electronAPI.onRequestSaveBeforeClose(async () => {
			return saveProject(false);
		});
		return () => cleanup();
	}, [saveProject]);

	useEffect(() => {
		const cleanup = window.electronAPI.onRequestCloseConfirm(() => {
			setShowCloseConfirmDialog(true);
		});
		return () => cleanup();
	}, []);

	const handleCloseConfirmSave = useCallback(() => {
		setShowCloseConfirmDialog(false);
		window.electronAPI.sendCloseConfirmResponse("save");
	}, []);

	const handleCloseConfirmDiscard = useCallback(() => {
		setShowCloseConfirmDialog(false);
		window.electronAPI.sendCloseConfirmResponse("discard");
	}, []);

	const handleCloseConfirmCancel = useCallback(() => {
		setShowCloseConfirmDialog(false);
		window.electronAPI.sendCloseConfirmResponse("cancel");
	}, []);

	const handleSaveProject = useCallback(async () => {
		await saveProject(false);
	}, [saveProject]);

	const handleSaveProjectAs = useCallback(async () => {
		await saveProject(true);
	}, [saveProject]);

	// cutti integration (dev affordance): runs the REAL ported cutti executor
	// (src/lib/cutti/engine) on the demo project — deleteSegment(filler) +
	// setSpeed(2x) — then maps the edited result to openscreen regions. Captions
	// + speed ride the existing preview machinery; trim shows on the timeline but
	// is not yet enforced in playback (that needs the composed→source clock change).
	const handleLoadCuttiDemo = useCallback(() => {
		const { regions, applied, skipped } = runCuttiDemoEdit();
		pushState(regions);
		toast.success(
			`cutti 引擎: applied ${applied} / skipped ${skipped} —— 字幕+变速已上(trim 暂不剪)`,
		);
	}, [pushState]);

	// Shared: openscreen's own Whisper transcribes the loaded video into absolute
	// source-time phrases. Used by both cutti first-cut paths (heuristic + LLM).
	const cuttiTranscribe = useCallback(async () => {
		const { samples, durationSec } = await extractMono16kFromVideoUrl(videoPath ?? "");
		if (!Number.isFinite(durationSec) || durationSec <= 0 || samples.length < 800) return [];
		const onStatus = (phase: "model" | "transcribe") => {
			toast.loading(phase === "model" ? t("autoCaptions.loadingModel") : "cutti:转写中…", {
				id: AUTO_CAPTION_PROGRESS_TOAST_ID,
			});
		};
		const { samples: speechSamples, trimSec } = trimLeadingSilenceMono16k(samples);
		const usedTrimmed = speechSamples.length >= 800;
		let { segments: raw } = await transcribeMono16kToSegments(
			usedTrimmed ? speechSamples : samples,
			{ onStatus },
		);
		let shift = usedTrimmed ? trimSec : 0;
		if (raw.length === 0 && usedTrimmed && trimSec > 0) {
			({ segments: raw } = await transcribeMono16kToSegments(samples, { onStatus }));
			shift = 0;
		}
		return shift > 0
			? raw.map((s) => ({ ...s, startSec: s.startSec + shift, endSec: s.endSec + shift }))
			: raw;
	}, [videoPath, t]);

	// cutti 初剪 (step 1 of full cutti): transcribe → REAL ported executor drops
	// filler/short phrases (local heuristic). Result lands as captions + trim regions.
	const handleCuttiFirstCut = useCallback(async () => {
		if (!videoPath) {
			toast.error(t("errors.noVideoLoaded"));
			return;
		}
		if (isAutoCaptioningRef.current) {
			toast.error(t("autoCaptions.busy"));
			return;
		}
		isAutoCaptioningRef.current = true;
		setIsAutoCaptioning(true);
		toast.loading("cutti 初剪:转写中…", { id: AUTO_CAPTION_PROGRESS_TOAST_ID });
		try {
			const captions = await cuttiTranscribe();
			toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
			if (captions.length === 0) {
				toast.info(t("autoCaptions.noneHeard"));
				return;
			}
			const { regions, total, applied } = transcriptToFirstCut(
				captions,
				videoSourcePath ?? videoPath,
			);
			pushState(regions);
			toast.success(
				`cutti 初剪:转写 ${total} 句,删 ${applied} 句口头禅 —— 字幕+trim 标记已上(trim 暂不剪)`,
			);
		} catch (e) {
			toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
			toast.error(`cutti 初剪失败: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			isAutoCaptioningRef.current = false;
			setIsAutoCaptioning(false);
		}
	}, [videoPath, videoSourcePath, pushState, t, cuttiTranscribe]);

	// cutti AI 剪 (step 2): transcribe → bring-your-own-key LLM keep/cut → REAL
	// executor. Config from localStorage (cutti.llm.apiKey / baseUrl / model).
	const handleCuttiAiCut = useCallback(async () => {
		if (!videoPath) {
			toast.error(t("errors.noVideoLoaded"));
			return;
		}
		const config = loadLlmConfig();
		if (!config) {
			toast.error(
				"请先设置 LLM:localStorage cutti.llm.apiKey(可选 cutti.llm.baseUrl / cutti.llm.model)",
			);
			return;
		}
		if (isAutoCaptioningRef.current) {
			toast.error(t("autoCaptions.busy"));
			return;
		}
		isAutoCaptioningRef.current = true;
		setIsAutoCaptioning(true);
		toast.loading("cutti AI 剪:转写中…", { id: AUTO_CAPTION_PROGRESS_TOAST_ID });
		try {
			const captions = await cuttiTranscribe();
			if (captions.length === 0) {
				toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
				toast.info(t("autoCaptions.noneHeard"));
				return;
			}
			toast.loading(`cutti AI 剪:LLM 判断中(${config.model})…`, {
				id: AUTO_CAPTION_PROGRESS_TOAST_ID,
			});
			const { regions, total, applied } = await transcriptToFirstCutAI(
				captions,
				videoSourcePath ?? videoPath,
				config,
			);
			toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
			pushState(regions);
			toast.success(
				`cutti AI 剪:转写 ${total} 句,LLM 删 ${applied} 句 —— 字幕+trim 标记已上(trim 暂不剪)`,
			);
		} catch (e) {
			toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
			toast.error(`cutti AI 剪失败: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			isAutoCaptioningRef.current = false;
			setIsAutoCaptioning(false);
		}
	}, [videoPath, videoSourcePath, pushState, t, cuttiTranscribe]);

	const handleNewRecordingConfirm = useCallback(async () => {
		const result = await window.electronAPI.startNewRecording();
		if (result.success) {
			setShowNewRecordingDialog(false);
		} else {
			console.error("Failed to start new recording:", result.error);
			setError("Failed to start new recording: " + (result.error || "Unknown error"));
		}
	}, []);

	const doLoadProject = useCallback(async () => {
		const result = await nativeBridgeClient.project.loadProjectFile(getProjectFolder());

		if (result.canceled) {
			return;
		}

		if (!result.success) {
			toast.error(result.message || t("project.failedToLoad"));
			return;
		}

		const restored = await applyLoadedProject(result.project, result.path ?? null);
		if (!restored) {
			toast.error(t("project.invalidFormat"));
			return;
		}

		if (result.path) {
			const folder = parentDirectoryOf(result.path);
			if (folder) {
				saveUserPreferences({ projectFolder: folder });
			}
		}

		toast.success(t("project.loadedFrom", { path: result.path ?? "" }));
	}, [applyLoadedProject, t]);

	const handleLoadProject = useCallback(async () => {
		if (hasUnsavedChanges) {
			setConfirmDialogVariant("loadProject");
			return;
		}
		await doLoadProject();
	}, [hasUnsavedChanges, doLoadProject]);

	const handleLoadProjectConfirmSave = useCallback(async () => {
		setConfirmDialogVariant(null);
		const saved = await saveProject(false);
		if (saved) {
			await doLoadProject();
		}
	}, [saveProject, doLoadProject]);

	const handleLoadProjectConfirmDiscard = useCallback(async () => {
		setConfirmDialogVariant(null);
		await doLoadProject();
	}, [doLoadProject]);

	// New Project: clear all media/project/editor state back to the empty
	// Studio dashboard. Prompts to save first when there are unsaved changes.
	const doNewProject = useCallback(async () => {
		await nativeBridgeClient.project.clearCurrentVideoPath();
		setVideoPath(null);
		setVideoSourcePath(null);
		setWebcamVideoPath(null);
		setWebcamVideoSourcePath(null);
		setCurrentProjectPath(null);
		setLastSavedSnapshot(null);
		// Reset undoable editor state + undo/redo history to a clean slate.
		resetState();
		// Reset non-undoable selection state.
		setSelectedZoomId(null);
		setSelectedTrimId(null);
		setSelectedSpeedId(null);
		setSelectedAnnotationId(null);
		setSelectedBlurId(null);
		// Reset playback.
		setCurrentTime(0);
		setIsPlaying(false);
		// Reset cursor preferences to defaults.
		setShowCursor(DEFAULT_CURSOR_SETTINGS.show);
		setCursorSize(DEFAULT_CURSOR_SETTINGS.size);
		setCursorSmoothing(DEFAULT_CURSOR_SETTINGS.smoothing);
		setCursorMotionBlur(DEFAULT_CURSOR_SETTINGS.motionBlur);
		setCursorClickBounce(DEFAULT_CURSOR_SETTINGS.clickBounce);
		setCursorClipToBounds(DEFAULT_CURSOR_SETTINGS.clipToBounds);
		setCursorTheme(DEFAULT_CURSOR_SETTINGS.theme);
		// Reset region ID counters.
		nextZoomIdRef.current = 1;
		nextTrimIdRef.current = 1;
		nextSpeedIdRef.current = 1;
		nextAnnotationIdRef.current = 1;
		nextAnnotationZIndexRef.current = 1;
		// A project is the document — entering "new project" opens an empty project
		// (no video source yet), not the import dashboard. project ≠ video.
		setProjectOpen(true);
	}, [resetState]);

	const handleNewProject = useCallback(async () => {
		if (hasUnsavedChanges) {
			setConfirmDialogVariant("newProject");
			return;
		}
		await doNewProject();
	}, [hasUnsavedChanges, doNewProject]);

	const handleNewProjectConfirmSave = useCallback(async () => {
		setConfirmDialogVariant(null);
		const saved = await saveProject(false);
		if (saved) {
			await doNewProject();
		}
	}, [saveProject, doNewProject]);

	const handleNewProjectConfirmDiscard = useCallback(async () => {
		setConfirmDialogVariant(null);
		await doNewProject();
	}, [doNewProject]);

	useEffect(() => {
		const removeNewProjectListener = window.electronAPI.onMenuNewProject(handleNewProject);
		const removeLoadListener = window.electronAPI.onMenuLoadProject(handleLoadProject);
		const removeSaveListener = window.electronAPI.onMenuSaveProject(handleSaveProject);
		const removeSaveAsListener = window.electronAPI.onMenuSaveProjectAs(handleSaveProjectAs);

		return () => {
			removeNewProjectListener?.();
			removeLoadListener?.();
			removeSaveListener?.();
			removeSaveAsListener?.();
		};
	}, [handleNewProject, handleLoadProject, handleSaveProject, handleSaveProjectAs]);

	useEffect(() => {
		let canceled = false;
		nativeBridgeClient.system
			.getPlatform()
			.then((platform) => {
				if (!canceled) {
					setNativePlatform(platform);
				}
			})
			.catch((error) => {
				console.warn("Unable to resolve native platform for cursor settings:", error);
				if (!canceled) {
					setNativePlatform(null);
				}
			});

		return () => {
			canceled = true;
		};
	}, []);

	useEffect(() => {
		if (cursorTelemetryError) {
			console.warn("Unable to load cursor telemetry:", cursorTelemetryError);
		}
	}, [cursorTelemetryError]);

	useEffect(() => {
		if (cursorRecordingDataError) {
			console.warn("Unable to load cursor recording data:", cursorRecordingDataError);
		}
	}, [cursorRecordingDataError]);

	function togglePlayPause() {
		const playback = videoPlaybackRef.current;
		const video = playback?.video;
		if (!playback || !video) return;

		if (isPlaying) {
			playback.pause();
			return;
		}

		const list = clipsRef.current;
		if (list.length === 0) {
			// Legacy single-source preview — play from wherever the <video> is.
			playback.play().catch((err) => console.error("Video play failed:", err));
			return;
		}

		// Multi-clip: restart from 0 if parked at/after the sequence end, then resolve
		// the clip (hopping over a gap if needed) before playing.
		const end = clipsTotalDuration(list);
		let from = currentTimeRef.current >= end - 0.05 ? 0 : currentTimeRef.current;
		let clip = clipAtTime(list, from);
		if (!clip) {
			const ns = nextClipStart(list, from);
			if (ns == null) return;
			from = ns;
			clip = clipAtTime(list, from);
			if (!clip) return;
		}
		setCurrentTime(from);
		activeClipRef.current = clip;
		const offsetSec = clip.inSec + (from - clip.startSec);
		if (clip.sourcePath === videoSourcePathRef.current) {
			try {
				video.currentTime = offsetSec;
			} catch {
				// no-op
			}
			playback.play().catch((err) => console.error("Video play failed:", err));
		} else {
			pendingSourceSeekRef.current = { offsetSec, play: true };
			void switchSource(clip.sourcePath);
		}
	}
	const togglePlayPauseRef = useRef(togglePlayPause);
	togglePlayPauseRef.current = togglePlayPause;

	const toggleFullscreen = useCallback(() => {
		setIsFullscreen((prev) => !prev);
	}, []);

	useEffect(() => {
		if (!isFullscreen) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setIsFullscreen(false);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isFullscreen]);

	function handleSeek(time: number) {
		const list = clipsRef.current;
		if (list.length === 0) {
			// Legacy: timeline time == source time, seek the <video> directly.
			const video = videoPlaybackRef.current?.video;
			if (!video) return;
			video.currentTime = time;
			return;
		}
		// Multi-clip: seeking is timeline-relative. Move the playhead, then switch /
		// seek the source to the clip + in-clip offset under the new time.
		const clamped = Math.min(Math.max(time, 0), clipsTotalDuration(list));
		setCurrentTime(clamped);
		const clip = clipAtTime(list, clamped);
		if (!clip) {
			// Seeked into a gap: show nothing playing.
			activeClipRef.current = null;
			try {
				videoPlaybackRef.current?.pause();
			} catch {
				// no-op
			}
			return;
		}
		activeClipRef.current = clip;
		const offsetSec = clip.inSec + (clamped - clip.startSec);
		if (clip.sourcePath === videoSourcePathRef.current) {
			const video = videoPlaybackRef.current?.video;
			if (video) {
				try {
					video.currentTime = offsetSec;
				} catch {
					// no-op
				}
			}
		} else {
			pendingSourceSeekRef.current = { offsetSec, play: isPlayingRef.current };
			void switchSource(clip.sourcePath);
		}
	}

	const handleSelectZoom = useCallback((id: string | null) => {
		setSelectedZoomId(id);
		if (id) {
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
		}
	}, []);

	const handleSelectTrim = useCallback((id: string | null) => {
		setSelectedTrimId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedSpeedId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
		}
	}, []);

	const handleSelectAnnotation = useCallback((id: string | null) => {
		setSelectedAnnotationId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedBlurId(null);
		}
	}, []);

	const handleSelectBlur = useCallback((id: string | null) => {
		setSelectedBlurId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedSpeedId(null);
		}
	}, []);

	const handleZoomAdded = useCallback(
		(span: Span) => {
			const id = `zoom-${nextZoomIdRef.current++}`;
			const newRegion: ZoomRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
				depth: DEFAULT_ZOOM_DEPTH,
				customScale: ZOOM_DEPTH_SCALES[DEFAULT_ZOOM_DEPTH],
				focus: { cx: 0.5, cy: 0.5 },
				// Auto-Focus on means new zooms follow the cursor too.
				focusMode: autoFocusAll ? "auto" : undefined,
				source: "manual",
			};
			pushState((prev) => ({ zoomRegions: [...prev.zoomRegions, newRegion] }));
			setSelectedZoomId(id);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
		},
		[pushState, autoFocusAll],
	);

	// Builds fresh "auto" zoom regions from cursor telemetry without overlapping
	// existing ones. Used by both the on-load auto-suggest pass and the wand toggle.
	const buildAutoZoomRegions = useCallback(
		(existingRegions: ZoomRegion[]): ZoomRegion[] => {
			const totalMs = Math.round(duration * 1000);
			const suggestions = buildAutoZoomSuggestions({
				cursorTelemetry,
				totalMs,
				existingRegions,
				defaultDurationMs: Math.max(1000, Math.round(totalMs * 0.05)),
			});
			return suggestions.map((suggestion) => ({
				id: `zoom-${nextZoomIdRef.current++}`,
				startMs: Math.round(suggestion.span.start),
				endMs: Math.round(suggestion.span.end),
				depth: DEFAULT_ZOOM_DEPTH,
				customScale: ZOOM_DEPTH_SCALES[DEFAULT_ZOOM_DEPTH],
				focus: clampFocusToDepth(suggestion.focus, DEFAULT_ZOOM_DEPTH),
				focusMode: autoFocusAll ? ("auto" as const) : undefined,
				source: "auto" as const,
			}));
		},
		[cursorTelemetry, duration, autoFocusAll],
	);

	// Auto-suggest zooms once per fresh recording (no existing zooms, telemetry
	// available, wand enabled). Loaded projects are marked processed elsewhere so
	// they're never touched. The ref guard runs this once per source and survives undo.
	const autoProcessedSourceRef = useRef<string | null>(null);
	useEffect(() => {
		if (!autoZoomEnabled || !cursorTelemetrySourcePath) return;
		if (autoProcessedSourceRef.current === cursorTelemetrySourcePath) return;
		if (cursorTelemetry.length < 2 || duration <= 0) return;
		// Only auto-suggest for a fresh recording; don't disturb existing zooms.
		if (zoomRegions.length > 0) {
			autoProcessedSourceRef.current = cursorTelemetrySourcePath;
			return;
		}
		const newRegions = buildAutoZoomRegions([]);
		autoProcessedSourceRef.current = cursorTelemetrySourcePath;
		if (newRegions.length === 0) return;
		pushState((prev) => ({ zoomRegions: [...prev.zoomRegions, ...newRegions] }));
	}, [
		autoZoomEnabled,
		cursorTelemetrySourcePath,
		cursorTelemetry,
		duration,
		zoomRegions,
		buildAutoZoomRegions,
		pushState,
	]);

	// Wand toggle: ON regenerates suggestions around existing zooms; OFF removes
	// only untouched auto zooms (manual and edited-to-manual survive).
	const handleToggleAutoZoom = useCallback(
		(enabled: boolean) => {
			if (enabled) {
				autoProcessedSourceRef.current = cursorTelemetrySourcePath;
				pushState((prev) => ({
					autoZoomEnabled: true,
					zoomRegions: [...prev.zoomRegions, ...buildAutoZoomRegions(prev.zoomRegions)],
				}));
			} else {
				pushState((prev) => ({
					autoZoomEnabled: false,
					zoomRegions: prev.zoomRegions.filter((region) => region.source !== "auto"),
				}));
			}
		},
		[pushState, buildAutoZoomRegions, cursorTelemetrySourcePath],
	);

	// Flip every zoom between auto (cursor-follow) and manual at once.
	const handleToggleAutoFocusAll = useCallback(
		(on: boolean) => {
			pushState((prev) => ({
				autoFocusAll: on,
				zoomRegions: prev.zoomRegions.map((region) => ({
					...region,
					focusMode: on ? "auto" : "manual",
				})),
			}));
		},
		[pushState],
	);

	const handleTrimAdded = useCallback(
		(span: Span) => {
			const id = `trim-${nextTrimIdRef.current++}`;
			const newRegion: TrimRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
			};
			pushState((prev) => ({ trimRegions: [...prev.trimRegions, newRegion] }));
			setSelectedTrimId(id);
			setSelectedZoomId(null);
			setSelectedSpeedId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
		},
		[pushState],
	);

	const handleZoomSpanChange = useCallback(
		(id: string, span: Span) => {
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === id
						? {
								...region,
								startMs: Math.round(span.start),
								endMs: Math.round(span.end),
								source: "manual",
							}
						: region,
				),
			}));
		},
		[pushState],
	);

	const handleTrimSpanChange = useCallback(
		(id: string, span: Span) => {
			pushState((prev) => ({
				trimRegions: prev.trimRegions.map((region) =>
					region.id === id
						? {
								...region,
								startMs: Math.round(span.start),
								endMs: Math.round(span.end),
							}
						: region,
				),
			}));
		},
		[pushState],
	);

	// Focus drag: updateState for live preview, commitState on pointer-up.
	const handleZoomFocusChange = useCallback(
		(id: string, focus: ZoomFocus) => {
			updateState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === id
						? { ...region, focus: clampFocusToDepth(focus, region.depth), source: "manual" }
						: region,
				),
			}));
		},
		[updateState],
	);

	const handleZoomDepthChange = useCallback(
		(depth: ZoomDepth) => {
			if (!selectedZoomId) return;
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === selectedZoomId
						? {
								...region,
								depth,
								customScale: ZOOM_DEPTH_SCALES[depth],
								focus: clampFocusToDepth(region.focus, depth),
								source: "manual",
							}
						: region,
				),
			}));
		},
		[selectedZoomId, pushState],
	);

	const handleZoomCustomScaleChange = useCallback(
		(scale: number) => {
			if (!selectedZoomId) return;
			const rounded = Math.round(scale * 100) / 100;
			if (!Number.isFinite(rounded)) return;
			updateState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === selectedZoomId
						? { ...region, customScale: rounded, source: "manual" }
						: region,
				),
			}));
		},
		[selectedZoomId, updateState],
	);

	const handleZoomCustomScaleCommit = useCallback(() => {
		commitState();
	}, [commitState]);

	const handleZoomFocusModeChange = useCallback(
		(focusMode: ZoomFocusMode) => {
			if (!selectedZoomId) return;
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) =>
					region.id === selectedZoomId ? { ...region, focusMode, source: "manual" } : region,
				),
			}));
		},
		[selectedZoomId, pushState],
	);

	const handleZoomDelete = useCallback(
		(id: string) => {
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.filter((r) => r.id !== id),
			}));
			if (selectedZoomId === id) {
				setSelectedZoomId(null);
			}
		},
		[selectedZoomId, pushState],
	);

	const handleZoomRotationPresetChange = useCallback(
		(preset: Rotation3DPreset | null) => {
			if (!selectedZoomId) return;
			pushState((prev) => ({
				zoomRegions: prev.zoomRegions.map((region) => {
					if (region.id !== selectedZoomId) return region;
					if (preset === null) {
						const { rotationPreset: _p, ...rest } = region;
						return { ...rest, source: "manual" };
					}
					return { ...region, rotationPreset: preset, source: "manual" };
				}),
			}));
		},
		[selectedZoomId, pushState],
	);

	const handleTrimDelete = useCallback(
		(id: string) => {
			pushState((prev) => ({
				trimRegions: prev.trimRegions.filter((r) => r.id !== id),
			}));
			if (selectedTrimId === id) {
				setSelectedTrimId(null);
			}
		},
		[selectedTrimId, pushState],
	);

	const handleSelectSpeed = useCallback((id: string | null) => {
		setSelectedSpeedId(id);
		if (id) {
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
		}
	}, []);

	const handleSpeedAdded = useCallback(
		(span: Span) => {
			const id = `speed-${nextSpeedIdRef.current++}`;
			const newRegion: SpeedRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
				speed: DEFAULT_PLAYBACK_SPEED,
			};
			pushState((prev) => ({
				speedRegions: [...prev.speedRegions, newRegion],
			}));
			setSelectedSpeedId(id);
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedAnnotationId(null);
			setSelectedBlurId(null);
		},
		[pushState],
	);

	const handleSpeedSpanChange = useCallback(
		(id: string, span: Span) => {
			pushState((prev) => ({
				speedRegions: prev.speedRegions.map((region) =>
					region.id === id
						? {
								...region,
								startMs: Math.round(span.start),
								endMs: Math.round(span.end),
							}
						: region,
				),
			}));
		},
		[pushState],
	);

	const handleSpeedDelete = useCallback(
		(id: string) => {
			pushState((prev) => ({
				speedRegions: prev.speedRegions.filter((region) => region.id !== id),
			}));
			if (selectedSpeedId === id) {
				setSelectedSpeedId(null);
			}
		},
		[selectedSpeedId, pushState],
	);

	const handleSpeedChange = useCallback(
		(speed: PlaybackSpeed) => {
			if (!selectedSpeedId) return;
			pushState((prev) => ({
				speedRegions: prev.speedRegions.map((region) =>
					region.id === selectedSpeedId ? { ...region, speed } : region,
				),
			}));
		},
		[selectedSpeedId, pushState],
	);

	const handleAnnotationAdded = useCallback(
		(span: Span) => {
			const id = `annotation-${nextAnnotationIdRef.current++}`;
			const zIndex = nextAnnotationZIndexRef.current++;
			const newRegion: AnnotationRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
				type: "text",
				content: "Enter text...",
				position: { ...DEFAULT_ANNOTATION_POSITION },
				size: { ...DEFAULT_ANNOTATION_SIZE },
				style: { ...DEFAULT_ANNOTATION_STYLE },
				zIndex,
			};
			pushState((prev) => ({
				annotationRegions: [...prev.annotationRegions, newRegion],
			}));
			setSelectedAnnotationId(id);
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedBlurId(null);
		},
		[pushState],
	);

	const handleBlurAdded = useCallback(
		(span: Span) => {
			const id = `annotation-${nextAnnotationIdRef.current++}`;
			const zIndex = nextAnnotationZIndexRef.current++;
			const newRegion: AnnotationRegion = {
				id,
				startMs: Math.round(span.start),
				endMs: Math.round(span.end),
				type: "blur",
				content: "",
				position: { ...DEFAULT_ANNOTATION_POSITION },
				size: { ...DEFAULT_ANNOTATION_SIZE },
				style: { ...DEFAULT_ANNOTATION_STYLE },
				zIndex,
				blurData: { ...DEFAULT_BLUR_DATA },
			};
			pushState((prev) => ({
				annotationRegions: [...prev.annotationRegions, newRegion],
			}));
			setSelectedBlurId(id);
			setSelectedAnnotationId(null);
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
		},
		[pushState],
	);

	const handleAnnotationSpanChange = useCallback(
		(id: string, span: Span) => {
			pushState((prev) => {
				const editedAutoCaption =
					prev.annotationRegions.find((region) => region.id === id)?.annotationSource ===
					"auto-caption";
				const next = prev.annotationRegions.map((region) =>
					region.id === id
						? {
								...region,
								startMs: Math.round(span.start),
								endMs: Math.round(span.end),
							}
						: region,
				);
				return {
					annotationRegions: editedAutoCaption ? reconcileAutoCaptionTimelineGaps(next) : next,
				};
			});
		},
		[pushState],
	);

	const handleAnnotationDuplicate = useCallback(
		(id: string) => {
			const duplicateId = `annotation-${nextAnnotationIdRef.current++}`;
			const duplicateZIndex = nextAnnotationZIndexRef.current++;
			pushState((prev) => {
				const source = prev.annotationRegions.find((region) => region.id === id);
				if (!source) return {};

				const { annotationSource: _stripCaptionLink, ...sourceWithoutCaptionLink } = source;

				const duplicate: AnnotationRegion = {
					...sourceWithoutCaptionLink,
					id: duplicateId,
					zIndex: duplicateZIndex,
					position: { x: source.position.x + 4, y: source.position.y + 4 },
					size: { ...source.size },
					style: { ...source.style },
					figureData: source.figureData ? { ...source.figureData } : undefined,
				};

				return { annotationRegions: [...prev.annotationRegions, duplicate] };
			});
			setSelectedAnnotationId(duplicateId);
			setSelectedZoomId(null);
			setSelectedTrimId(null);
			setSelectedSpeedId(null);
			setSelectedBlurId(null);
		},
		[pushState],
	);

	const handleAnnotationDelete = useCallback(
		(id: string) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.filter((r) => r.id !== id),
			}));
			if (selectedAnnotationId === id) {
				setSelectedAnnotationId(null);
			}
			if (selectedBlurId === id) {
				setSelectedBlurId(null);
			}
		},
		[selectedAnnotationId, selectedBlurId, pushState],
	);

	const handleAnnotationContentChange = useCallback(
		(id: string, content: string) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) => {
					if (region.id !== id) return region;
					if (region.type === "text") {
						return { ...region, content, textContent: content };
					} else if (region.type === "image") {
						return { ...region, content, imageContent: content };
					}
					return { ...region, content };
				}),
			}));
		},
		[pushState],
	);

	const handleAnnotationTypeChange = useCallback(
		(id: string, type: AnnotationRegion["type"]) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) => {
					if (region.id !== id) return region;
					const updatedRegion = { ...region, type };
					if (type === "text") {
						updatedRegion.content = region.textContent || "Enter text...";
					} else if (type === "image") {
						updatedRegion.content = region.imageContent || "";
					} else if (type === "figure") {
						updatedRegion.content = "";
						if (!region.figureData) {
							updatedRegion.figureData = { ...DEFAULT_FIGURE_DATA };
						}
					} else if (type === "blur") {
						updatedRegion.content = "";
						if (!region.blurData) {
							updatedRegion.blurData = { ...DEFAULT_BLUR_DATA };
						}
					}
					return updatedRegion;
				}),
			}));

			if (type === "blur" && selectedAnnotationId === id) {
				setSelectedAnnotationId(null);
				setSelectedBlurId(id);
				setSelectedSpeedId(null);
			} else if (type !== "blur" && selectedBlurId === id) {
				setSelectedBlurId(null);
				setSelectedAnnotationId(id);
			}
		},
		[pushState, selectedAnnotationId, selectedBlurId],
	);

	const handleAnnotationStyleChange = useCallback(
		(id: string, style: Partial<AnnotationRegion["style"]>) => {
			pushState((prev) => {
				const touched = prev.annotationRegions.find((r) => r.id === id);
				const syncAutoCaptions = touched?.annotationSource === "auto-caption";
				return {
					annotationRegions: prev.annotationRegions.map((region) => {
						if (syncAutoCaptions && region.annotationSource === "auto-caption") {
							return { ...region, style: { ...region.style, ...style } };
						}
						return region.id === id ? { ...region, style: { ...region.style, ...style } } : region;
					}),
				};
			});
		},
		[pushState],
	);

	const handleAnnotationFigureDataChange = useCallback(
		(id: string, figureData: FigureData) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) =>
					region.id === id ? { ...region, figureData } : region,
				),
			}));
		},
		[pushState],
	);

	const handleBlurDataPreviewChange = useCallback(
		(id: string, blurData: BlurData) => {
			updateState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) =>
					region.id === id
						? {
								...region,
								blurData,
								// Freehand drawing area is the full video surface.
								...(blurData.shape === "freehand"
									? {
											position: { x: 0, y: 0 },
											size: { width: 100, height: 100 },
										}
									: {}),
							}
						: region,
				),
			}));
		},
		[updateState],
	);

	const handleBlurDataPanelChange = useCallback(
		(id: string, blurData: BlurData) => {
			pushState((prev) => ({
				annotationRegions: prev.annotationRegions.map((region) =>
					region.id === id
						? {
								...region,
								blurData,
								...(blurData.shape === "freehand"
									? {
											position: { x: 0, y: 0 },
											size: { width: 100, height: 100 },
										}
									: {}),
							}
						: region,
				),
			}));
		},
		[pushState],
	);

	const handleAnnotationPositionChange = useCallback(
		(id: string, position: { x: number; y: number }) => {
			pushState((prev) => {
				const moved = prev.annotationRegions.find((r) => r.id === id);
				const syncAutoCaptions = moved?.annotationSource === "auto-caption";
				return {
					annotationRegions: prev.annotationRegions.map((region) => {
						if (syncAutoCaptions && region.annotationSource === "auto-caption") {
							return { ...region, position };
						}
						return region.id === id ? { ...region, position } : region;
					}),
				};
			});
		},
		[pushState],
	);

	const handleAnnotationSizeChange = useCallback(
		(id: string, size: { width: number; height: number }) => {
			pushState((prev) => {
				const resized = prev.annotationRegions.find((r) => r.id === id);
				const syncAutoCaptions = resized?.annotationSource === "auto-caption";
				return {
					annotationRegions: prev.annotationRegions.map((region) => {
						if (syncAutoCaptions && region.annotationSource === "auto-caption") {
							return { ...region, size };
						}
						return region.id === id ? { ...region, size } : region;
					}),
				};
			});
		},
		[pushState],
	);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const mod = e.ctrlKey || e.metaKey;
			const key = e.key.toLowerCase();

			if (mod && key === "z" && !e.shiftKey) {
				e.preventDefault();
				e.stopPropagation();
				undo();
				return;
			}
			if (mod && (key === "y" || (key === "z" && e.shiftKey))) {
				e.preventDefault();
				e.stopPropagation();
				redo();
				return;
			}

			// Standard-NLE clip shortcuts. Only when the timeline has clips and the
			// user isn't typing in a field — so they never fight the global Space/play,
			// undo/redo, or text entry. They run before the frame-step arrows below so a
			// selected clip's Arrow nudges the clip instead of stepping the playhead.
			const targetEl = e.target;
			const typing =
				targetEl instanceof HTMLInputElement ||
				targetEl instanceof HTMLTextAreaElement ||
				targetEl instanceof HTMLSelectElement ||
				(targetEl instanceof HTMLElement && targetEl.isContentEditable);
			if (!typing && clipsRef.current.length > 0) {
				const selSet = new Set(selectedClipIdsRef.current);
				const list = clipsRef.current;
				// Every selected clip, and the editable subset (unlocked lanes only).
				// Locked-lane clips can be selected but every bulk EDIT skips them.
				const selectedClips = list.filter((c) => selSet.has(c.id));
				const editable = selectedClips.filter(
					(c) => !isTrackLocked(tracksRef.current, c.trackIndex),
				);
				const editableSet = new Set(editable.map((c) => c.id));

				// Copy acts on the whole selection (locked clips included — copying is
				// non-destructive); paste drops the clipboard at the playhead.
				if (mod && key === "c") {
					if (selectedClips.length > 0) {
						e.preventDefault();
						e.stopPropagation();
						setClipboard(selectedClips);
					}
					return;
				}
				if (mod && key === "v") {
					const buffer = clipboardRef.current;
					if (buffer.length > 0) {
						e.preventDefault();
						e.stopPropagation();
						const pasted = pasteClipsAt(buffer, currentTimeRef.current, genClipId);
						pushState((prev) => ({ timelineClips: [...prev.timelineClips, ...pasted] }));
						selectClipsRef.current(pasted);
					}
					return;
				}
				if (mod && key === "d") {
					if (editable.length > 0) {
						e.preventDefault();
						e.stopPropagation();
						const dups = editable.map((c) => duplicateClip(c, genClipId));
						pushState((prev) => ({ timelineClips: [...prev.timelineClips, ...dups] }));
						selectClipsRef.current(dups);
					}
					return;
				}

				// The rest act on every editable selected clip and ignore Cmd/Ctrl combos.
				if (editable.length > 0 && !mod) {
					if (e.key === "Delete" || e.key === "Backspace") {
						e.preventDefault();
						e.stopPropagation();
						if (e.shiftKey) {
							// Ripple-delete each editable clip (per-track gap close).
							pushState((prev) => {
								let next = prev.timelineClips;
								for (const id of editableSet) next = rippleDeleteClip(next, id);
								return { timelineClips: next };
							});
						} else {
							pushState((prev) => ({
								timelineClips: prev.timelineClips.filter((c) => !editableSet.has(c.id)),
							}));
						}
						setSelectedClipIds([]);
						return;
					}
					if (key === "s" || key === "b") {
						e.preventDefault();
						e.stopPropagation();
						// Split each editable clip the playhead sits inside; ids computed up
						// front so the new selection stays in lockstep with the spawned halves.
						const at = currentTimeRef.current;
						const newSel: string[] = [];
						let changed = false;
						const next = list.flatMap((c) => {
							if (!editableSet.has(c.id)) return [c];
							const halves = splitClipAt(c, at, genClipId);
							if (!halves) {
								newSel.push(c.id);
								return [c];
							}
							changed = true;
							newSel.push(halves[0].id, halves[1].id);
							return halves;
						});
						if (changed) {
							pushState({ timelineClips: next });
							setSelectedClipIds(newSel);
						}
						return;
					}
					if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
						e.preventDefault();
						e.stopPropagation();
						const step = e.shiftKey ? CLIP_NUDGE_STEP_LARGE_SEC : CLIP_NUDGE_STEP_SEC;
						const delta = e.key === "ArrowLeft" ? -step : step;
						pushState((prev) => ({
							timelineClips: prev.timelineClips.map((c) =>
								editableSet.has(c.id) ? nudgeClip(c, delta) : c,
							),
						}));
						return;
					}
				}
			}

			// Frame-step navigation (arrow keys, no modifiers)
			if (
				(e.key === "ArrowLeft" || e.key === "ArrowRight") &&
				!e.ctrlKey &&
				!e.metaKey &&
				!e.shiftKey &&
				!e.altKey
			) {
				const target = e.target;
				if (
					target instanceof HTMLInputElement ||
					target instanceof HTMLTextAreaElement ||
					target instanceof HTMLSelectElement ||
					(target instanceof HTMLElement &&
						(target.isContentEditable ||
							target.closest('[role="separator"], [role="slider"], [role="spinbutton"]')))
				) {
					return;
				}
				e.preventDefault();
				const video = videoPlaybackRef.current?.video;
				if (!video) {
					return;
				}
				const direction = e.key === "ArrowLeft" ? "backward" : "forward";
				const newTime = computeFrameStepTime(
					video.currentTime,
					Number.isFinite(video.duration) ? video.duration : durationRef.current,
					direction,
				);
				video.currentTime = newTime;
				return;
			}

			const isInput =
				e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

			if (e.key === "Tab" && !isInput) {
				e.preventDefault();
			}

			if (matchesShortcut(e, shortcuts.playPause, isMac)) {
				// Let space pass through inside inputs/textareas.
				if (isInput) {
					return;
				}
				e.preventDefault();
				// Multi-clip sequence: route through togglePlayPause (handles end-restart,
				// gap-hop, source switch). Legacy single-source keeps the direct toggle.
				if (clipsRef.current.length > 0) {
					togglePlayPauseRef.current();
					return;
				}
				const playback = videoPlaybackRef.current;
				if (playback?.video) {
					playback.video.paused ? playback.play().catch(console.error) : playback.pause();
				}
			}
		};

		window.addEventListener("keydown", handleKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
	}, [undo, redo, shortcuts, isMac, pushState]);

	useEffect(() => {
		if (selectedZoomId && !zoomRegions.some((region) => region.id === selectedZoomId)) {
			setSelectedZoomId(null);
		}
	}, [selectedZoomId, zoomRegions]);

	useEffect(() => {
		if (selectedTrimId && !trimRegions.some((region) => region.id === selectedTrimId)) {
			setSelectedTrimId(null);
		}
	}, [selectedTrimId, trimRegions]);

	useEffect(() => {
		if (
			selectedAnnotationId &&
			!annotationOnlyRegions.some((region) => region.id === selectedAnnotationId)
		) {
			setSelectedAnnotationId(null);
		}
		if (selectedBlurId && !blurRegions.some((region) => region.id === selectedBlurId)) {
			setSelectedBlurId(null);
		}
	}, [selectedAnnotationId, selectedBlurId, annotationOnlyRegions, blurRegions]);

	useEffect(() => {
		if (selectedSpeedId && !speedRegions.some((region) => region.id === selectedSpeedId)) {
			setSelectedSpeedId(null);
		}
	}, [selectedSpeedId, speedRegions]);

	const handleShowExportedFile = useCallback(async (filePath: string) => {
		try {
			const result = await window.electronAPI.revealInFolder(filePath);
			if (!result.success) {
				const errorMessage = result.error || result.message || "Failed to reveal item in folder.";
				console.error("Failed to reveal in folder:", errorMessage);
				toast.error(errorMessage);
			}
		} catch (error) {
			const errorMessage = String(error);
			console.error("Error calling revealInFolder IPC:", errorMessage);
			toast.error(`Error revealing in folder: ${errorMessage}`);
		}
	}, []);

	const handleExportSaved = useCallback(
		(formatLabel: "GIF" | "Video", filePath: string) => {
			setExportedFilePath(filePath);
			const folder = parentDirectoryOf(filePath);
			if (folder) {
				saveUserPreferences({ exportFolder: folder });
			}
			toast.success(
				t("export.exportedSuccessfully", {
					format: formatLabel,
				}),
				{
					description: filePath,
					action: {
						label: rawT("common.actions.showInFolder"),
						onClick: () => {
							void handleShowExportedFile(filePath);
						},
					},
				},
			);
		},
		[handleShowExportedFile, t, rawT],
	);

	const handleSaveUnsavedExport = useCallback(async () => {
		if (!unsavedExport) return;
		try {
			const pickResult = await window.electronAPI.pickExportSavePath(
				unsavedExport.fileName,
				getExportFolder(),
			);
			if (pickResult.canceled || !pickResult.success || !pickResult.path) {
				toast.info("Export canceled");
				return;
			}
			const saveResult = await window.electronAPI.writeExportToPath(
				unsavedExport.arrayBuffer,
				pickResult.path,
			);
			if (saveResult.success && saveResult.path) {
				setUnsavedExport(null);
				handleExportSaved(unsavedExport.format === "gif" ? "GIF" : "Video", saveResult.path);
			} else {
				toast.error(
					buildSaveDiagnosticMessage(
						unsavedExport.format === "gif" ? "GIF" : "Video",
						saveResult.message || "Failed to save export",
					),
				);
			}
		} catch (error) {
			console.error("Error saving unsaved export:", error);
			toast.error(
				buildSaveDiagnosticMessage(
					unsavedExport.format === "gif" ? "GIF" : "Video",
					error instanceof Error ? error.message : "Failed to save exported video",
				),
			);
		}
	}, [unsavedExport, handleExportSaved]);

	const handleExport = useCallback(
		async (settings: ExportSettings) => {
			if (!videoPath) {
				toast.error("No video loaded");
				return;
			}

			const video = videoPlaybackRef.current?.video;
			if (!video) {
				toast.error("Video not ready");
				return;
			}

			// Pick the save path before exporting, otherwise the save dialog can end up
			// hidden behind other windows after a long-running export.
			const isGifFormat = settings.format === "gif";
			const targetFileName = `export-${Date.now()}.${isGifFormat ? "gif" : "mp4"}`;
			const pickResult = await window.electronAPI.pickExportSavePath(
				targetFileName,
				getExportFolder(),
			);
			if (pickResult.canceled || !pickResult.success || !pickResult.path) {
				setShowExportDialog(false);
				return;
			}
			const targetPath = pickResult.path;

			setIsExporting(true);
			setExportProgress(null);
			setExportError(null);
			setExportedFilePath(null);

			try {
				const wasPlaying = isPlaying;
				if (wasPlaying) {
					videoPlaybackRef.current?.pause();
				}

				const sourceWidth = video.videoWidth || DEFAULT_SOURCE_DIMENSIONS.width;
				const sourceHeight = video.videoHeight || DEFAULT_SOURCE_DIMENSIONS.height;
				const effectiveSourceDimensions = calculateEffectiveSourceDimensions(
					sourceWidth,
					sourceHeight,
					cropRegion,
				);
				const aspectRatioValue =
					aspectRatio === "native"
						? getNativeAspectRatioValue(sourceWidth, sourceHeight, cropRegion)
						: getAspectRatioValue(aspectRatio);

				// Preview container dimensions, used for scaling.
				const playbackRef = videoPlaybackRef.current;
				const containerElement = playbackRef?.containerRef?.current;
				const previewWidth = containerElement?.clientWidth || DEFAULT_SOURCE_DIMENSIONS.width;
				const previewHeight = containerElement?.clientHeight || DEFAULT_SOURCE_DIMENSIONS.height;

				if (settings.format === "gif" && settings.gifConfig) {
					// GIF Export
					const gifExporter = new GifExporter({
						videoUrl: videoPath,
						webcamVideoUrl: webcamVideoPath || undefined,
						width: settings.gifConfig.width,
						height: settings.gifConfig.height,
						frameRate: settings.gifConfig.frameRate,
						loop: settings.gifConfig.loop,
						sizePreset: settings.gifConfig.sizePreset,
						wallpaper,
						zoomRegions,
						trimRegions,
						speedRegions,
						showShadow: shadowIntensity > 0,
						shadowIntensity,
						showBlur,
						motionBlurAmount,
						borderRadius,
						padding,
						videoPadding: padding,
						cropRegion,
						cursorRecordingData,
						cursorScale: effectiveShowCursor ? cursorSize : 0,
						cursorSmoothing,
						cursorMotionBlur,
						cursorClickBounce,
						cursorClipToBounds,
						cursorTheme,
						annotationRegions,
						webcamLayoutPreset,
						webcamMaskShape,
						webcamMirrored,
						webcamReactiveZoom,
						webcamSizePreset,
						webcamPosition,
						previewWidth,
						previewHeight,
						cursorTelemetry,
						cursorClickTimestamps,
						onProgress: (progress: ExportProgress) => {
							setExportProgress(progress);
						},
					});

					exporterRef.current = gifExporter as unknown as VideoExporter;
					const result = await gifExporter.export();

					if (result.success && result.blob) {
						const arrayBuffer = await result.blob.arrayBuffer();

						if (result.warnings) {
							for (const warning of result.warnings) {
								toast.warning(warning);
							}
						}

						const saveResult = await window.electronAPI.writeExportToPath(arrayBuffer, targetPath);

						if (saveResult.success && saveResult.path) {
							setUnsavedExport(null);
							handleExportSaved("GIF", saveResult.path);
						} else {
							setUnsavedExport({ arrayBuffer, fileName: targetFileName, format: "gif" });
							const message = buildSaveDiagnosticMessage(
								"GIF",
								saveResult.message || "Failed to save GIF",
							);
							setExportError(message);
							toast.error(message);
						}
					} else {
						const message = buildExportDiagnosticMessage({
							formatLabel: "GIF",
							reason: result.error || "GIF export failed",
							sourcePath: videoSourcePath ?? videoPath,
							width: settings.gifConfig.width,
							height: settings.gifConfig.height,
							frameRate: settings.gifConfig.frameRate,
						});
						setExportError(message);
						toast.error(message);
					}
				} else {
					// MP4 Export
					const quality = settings.quality || exportQuality;
					const {
						width: exportWidth,
						height: exportHeight,
						bitrate,
					} = calculateMp4ExportSettings({
						quality,
						sourceWidth: effectiveSourceDimensions.width,
						sourceHeight: effectiveSourceDimensions.height,
						aspectRatioValue,
					});

					// When the clip timeline has clips, render the sequence (top video track
					// clips, in order, with their trims + per-clip audio gain). With zero
					// clips, keep the legacy single-source export path unchanged.
					const exporter =
						clips.length > 0
							? (new SequenceVideoExporter({
									clips,
									tracks,
									transitions,
									resolveSourceUrl: (clip) => toFileUrl(clip.sourcePath),
									width: exportWidth,
									height: exportHeight,
									frameRate: 60,
									bitrate,
									codec: "avc1.640033",
									onProgress: (progress: ExportProgress) => {
										setExportProgress(progress);
									},
								}) as unknown as VideoExporter)
							: new VideoExporter({
									videoUrl: videoPath,
									webcamVideoUrl: webcamVideoPath || undefined,
									width: exportWidth,
									height: exportHeight,
									frameRate: 60,
									bitrate,
									codec: "avc1.640033",
									wallpaper,
									zoomRegions,
									trimRegions,
									speedRegions,
									showShadow: shadowIntensity > 0,
									shadowIntensity,
									showBlur,
									motionBlurAmount,
									borderRadius,
									padding,
									cropRegion,
									cursorRecordingData,
									cursorScale: effectiveShowCursor ? cursorSize : 0,
									cursorSmoothing,
									cursorMotionBlur,
									cursorClickBounce,
									cursorClipToBounds,
									cursorTheme,
									annotationRegions,
									webcamLayoutPreset,
									webcamMaskShape,
									webcamMirrored,
									webcamReactiveZoom,
									webcamSizePreset,
									webcamPosition,
									previewWidth,
									previewHeight,
									cursorTelemetry,
									cursorClickTimestamps,
									onProgress: (progress: ExportProgress) => {
										setExportProgress(progress);
									},
								});

					exporterRef.current = exporter;
					const result = await exporter.export();

					if (result.success && result.blob) {
						const arrayBuffer = await result.blob.arrayBuffer();

						if (result.warnings) {
							for (const warning of result.warnings) {
								toast.warning(warning);
							}
						}

						const saveResult = await window.electronAPI.writeExportToPath(arrayBuffer, targetPath);

						if (saveResult.success && saveResult.path) {
							setUnsavedExport(null);
							handleExportSaved("Video", saveResult.path);
						} else {
							setUnsavedExport({ arrayBuffer, fileName: targetFileName, format: "mp4" });
							const message = buildSaveDiagnosticMessage(
								"Video",
								saveResult.message || "Failed to save video",
							);
							setExportError(message);
							toast.error(message);
						}
					} else {
						const message = buildExportDiagnosticMessage({
							formatLabel: "Video",
							reason: result.error || "Export failed",
							sourcePath: videoSourcePath ?? videoPath,
							width: exportWidth,
							height: exportHeight,
							frameRate: 60,
							codec: "avc1.640033",
							bitrate,
						});
						setExportError(message);
						toast.error(message);
					}
				}

				if (wasPlaying) {
					videoPlaybackRef.current?.play();
				}
			} catch (error) {
				console.error("Export error:", error);
				if (error instanceof BackgroundLoadError) {
					const message = t("errors.exportBackgroundLoadFailed", { url: error.displayUrl });
					setExportError(message);
					toast.error(message);
				} else {
					const errorMessage = error instanceof Error ? error.message : "Unknown error";
					const message = buildExportDiagnosticMessage({
						formatLabel: settings.format === "gif" ? "GIF" : "Video",
						reason: errorMessage,
						sourcePath: videoSourcePath ?? videoPath,
					});
					setExportError(message);
					toast.error(t("errors.exportFailedWithError", { error: message }));
				}
			} finally {
				setIsExporting(false);
				exporterRef.current = null;
				// Reset so the next export can reopen the dialog (second export
				// otherwise wouldn't show the save dialog).
				setShowExportDialog(false);
				setExportProgress(null);
			}
		},
		[
			videoPath,
			videoSourcePath,
			webcamVideoPath,
			wallpaper,
			zoomRegions,
			trimRegions,
			speedRegions,
			shadowIntensity,
			showBlur,
			motionBlurAmount,
			borderRadius,
			padding,
			cropRegion,
			cursorRecordingData,
			annotationRegions,
			isPlaying,
			aspectRatio,
			webcamLayoutPreset,
			webcamMaskShape,
			webcamMirrored,
			webcamReactiveZoom,
			webcamSizePreset,
			webcamPosition,
			exportQuality,
			handleExportSaved,
			cursorTelemetry,
			cursorClickTimestamps,
			effectiveShowCursor,
			cursorSize,
			cursorSmoothing,
			cursorMotionBlur,
			cursorClickBounce,
			cursorClipToBounds,
			cursorTheme,
			t,
			clips,
			tracks,
			transitions,
		],
	);

	const handleOpenExportDialog = useCallback(() => {
		if (!videoPath) {
			toast.error("No video loaded");
			return;
		}

		const video = videoPlaybackRef.current?.video;
		if (!video) {
			toast.error("Video not ready");
			return;
		}

		// Build export settings from current state
		const sourceWidth = video.videoWidth || DEFAULT_SOURCE_DIMENSIONS.width;
		const sourceHeight = video.videoHeight || DEFAULT_SOURCE_DIMENSIONS.height;
		const effectiveSourceDimensions = calculateEffectiveSourceDimensions(
			sourceWidth,
			sourceHeight,
			cropRegion,
		);
		const aspectRatioValue =
			aspectRatio === "native"
				? getNativeAspectRatioValue(sourceWidth, sourceHeight, cropRegion)
				: getAspectRatioValue(aspectRatio);
		const gifDimensions = calculateOutputDimensions(
			effectiveSourceDimensions.width,
			effectiveSourceDimensions.height,
			gifSizePreset,
			GIF_SIZE_PRESETS,
			aspectRatioValue,
		);

		const settings: ExportSettings = {
			format: exportFormat,
			quality: exportFormat === "mp4" ? exportQuality : undefined,
			gifConfig:
				exportFormat === "gif"
					? {
							frameRate: gifFrameRate,
							loop: gifLoop,
							sizePreset: gifSizePreset,
							width: gifDimensions.width,
							height: gifDimensions.height,
						}
					: undefined,
		};

		setShowExportDialog(true);
		setExportError(null);
		setExportedFilePath(null);

		// Start export immediately
		handleExport(settings);
	}, [
		videoPath,
		exportFormat,
		exportQuality,
		gifFrameRate,
		gifLoop,
		gifSizePreset,
		aspectRatio,
		cropRegion,
		handleExport,
	]);

	const handleCancelExport = useCallback(() => {
		if (exporterRef.current) {
			exporterRef.current.cancel();
			toast.info("Export canceled");
			setShowExportDialog(false);
			setIsExporting(false);
			setExportProgress(null);
			setExportError(null);
			setExportedFilePath(null);
		}
	}, []);

	const generateAutoCaptions = useCallback(
		async (minWords: number, maxWords: number) => {
			if (!videoPath) {
				toast.error(t("errors.noVideoLoaded"));
				return;
			}
			if (isAutoCaptioningRef.current) {
				toast.error(t("autoCaptions.busy"));
				return;
			}
			const minW = Math.max(1, Math.min(minWords, maxWords));
			const maxW = Math.max(minW, maxWords);

			isAutoCaptioningRef.current = true;
			setIsAutoCaptioning(true);
			toast.loading(t("autoCaptions.generating"), { id: AUTO_CAPTION_PROGRESS_TOAST_ID });
			try {
				const { samples, truncated, durationSec } = await extractMono16kFromVideoUrl(videoPath);
				if (!Number.isFinite(durationSec) || durationSec <= 0 || samples.length < 800) {
					toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
					toast.error(t("autoCaptions.noAudio"));
					return;
				}

				const { samples: speechSamples, trimSec } = trimLeadingSilenceMono16k(samples);
				if (speechSamples.length < 800) {
					toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
					toast.error(t("autoCaptions.noAudio"));
					return;
				}

				const trimMs = Math.round(trimSec * 1000);
				const trimRegionsForTranscribe = shiftTrimRegionsMsForCaptionBuffer(trimRegions, trimMs);

				const transcribeOptions = {
					onStatus: (phase: "model" | "transcribe") => {
						if (phase === "model") {
							toast.loading(t("autoCaptions.loadingModel"), {
								id: AUTO_CAPTION_PROGRESS_TOAST_ID,
							});
						} else {
							toast.loading(t("autoCaptions.transcribing"), {
								id: AUTO_CAPTION_PROGRESS_TOAST_ID,
							});
						}
					},
				};

				let { segments: segmentsRaw, granularity } = await transcribeMono16kToSegments(
					speechSamples,
					{
						trimRegions: trimRegionsForTranscribe,
						...transcribeOptions,
					},
				);
				let transcribedFromTrimmedBuffer = true;

				// Leading-silence trimming can return empty even when the full source has
				// speech. Retry once against the untrimmed buffer before giving up.
				if (segmentsRaw.length === 0 && trimSec > 0) {
					({ segments: segmentsRaw, granularity } = await transcribeMono16kToSegments(samples, {
						trimRegions,
						...transcribeOptions,
					}));
					transcribedFromTrimmedBuffer = false;
				}

				const segments =
					transcribedFromTrimmedBuffer && trimSec > 0
						? segmentsRaw.map((s) => ({
								...s,
								startSec: s.startSec + trimSec,
								endSec: s.endSec + trimSec,
							}))
						: segmentsRaw;

				let { regions, nextNumericId, nextZIndex } = captionSegmentsToAnnotationRegions(
					segments,
					nextAnnotationIdRef.current,
					nextAnnotationZIndexRef.current,
					{
						minWordsPerCaption: minW,
						maxWordsPerCaption: maxW,
						timestampGranularity: granularity,
					},
				);

				if (regions.length === 0 && segments.length > 0) {
					({ regions, nextNumericId, nextZIndex } = captionSegmentsToAnnotationRegions(
						segments,
						nextAnnotationIdRef.current,
						nextAnnotationZIndexRef.current,
						{
							minWordsPerCaption: 1,
							maxWordsPerCaption: Number.MAX_SAFE_INTEGER,
							timestampGranularity: granularity,
						},
					));
				}

				if (regions.length === 0) {
					toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
					toast.info(t("autoCaptions.noneHeard"));
					return;
				}

				pushState((prev) => ({ annotationRegions: [...prev.annotationRegions, ...regions] }));
				nextAnnotationIdRef.current = nextNumericId;
				nextAnnotationZIndexRef.current = nextZIndex;

				toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
				const minutesTrunc = String(Math.round(MAX_CAPTION_AUDIO_SEC / 60));
				if (truncated) {
					toast.success(t("autoCaptions.done", { count: String(regions.length) }), {
						description: t("autoCaptions.truncated", { minutes: minutesTrunc }),
					});
				} else {
					toast.success(t("autoCaptions.done", { count: String(regions.length) }));
				}
			} catch (e) {
				console.error(e);
				toast.dismiss(AUTO_CAPTION_PROGRESS_TOAST_ID);
				const detail = e instanceof Error ? e.message : String(e);
				toast.error(t("autoCaptions.failed"), { description: detail });
			} finally {
				isAutoCaptioningRef.current = false;
				setIsAutoCaptioning(false);
			}
		},
		[videoPath, trimRegions, pushState, t],
	);

	const handleSaveDiagnostic = useCallback(async () => {
		const result = await window.electronAPI.saveDiagnostic({
			error: exportError ?? "Manual diagnostic export",
			projectState: editorState,
			logs: [],
		});
		if (result.success) {
			toast.success("Diagnostic file saved");
		} else if (!result.canceled) {
			toast.error("Failed to save diagnostic file");
		}
	}, [exportError, editorState]);

	// Region-authoring handlers from the retired single-source TimelineEditor.
	// The new ClipTimeline doesn't expose region editing yet — zoom/trim/speed/
	// annotation regions are still consumed by the preview (VideoPlayback) but are
	// no longer editable from the timeline. Retained here for re-wiring into the
	// clip timeline in a later phase; referenced so they don't read as dead code.
	void [
		handleSelectTrim,
		handleZoomAdded,
		handleToggleAutoZoom,
		handleToggleAutoFocusAll,
		handleTrimAdded,
		handleZoomSpanChange,
		handleTrimSpanChange,
		handleSelectSpeed,
		handleSpeedAdded,
		handleSpeedSpanChange,
		handleAnnotationAdded,
		handleBlurAdded,
		handleAnnotationSpanChange,
	];

	if (loading) {
		return (
			<div className="flex items-center justify-center h-screen bg-background">
				<div className="text-foreground">{t("loadingVideo")}</div>
			</div>
		);
	}
	// Only full-screen an error when there's no project context. With a project open
	// (or a video loaded), a video-load error is shown inline in the preview slot so
	// the editor, timeline and tracks stay put — a failed source ≠ a dead project.
	if (error && !projectOpen && !videoPath) {
		return (
			<div className="flex items-center justify-center h-screen bg-background">
				<div className="flex flex-col items-center gap-3">
					<div className="text-destructive">{error}</div>
					<button
						type="button"
						onClick={handleLoadProject}
						className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90"
					>
						{ts("project.load")}
					</button>
				</div>
			</div>
		);
	}

	// --- Top menu bar + status bar derived display values --------------------
	const tm = (key: string, vars?: Record<string, string>) => t(`menubar.${key}`, vars);
	const sbT = (key: string, vars?: Record<string, string>) => t(`statusBar.${key}`, vars);
	const modKey = isMac ? "⌘" : "Ctrl+";
	const projectName = currentProjectPath
		? (currentProjectPath
				.split(/[\\/]/)
				.pop()
				?.replace(/\.[^.]+$/, "") ?? tm("untitledProject"))
		: tm("untitledProject");
	// Output resolution from the (real) aspect-ratio setting, 1080 short side.
	const aspectValue = getAspectRatioValue(aspectRatio) || 16 / 9;
	const outputHeight = aspectValue >= 1 ? 1080 : Math.round(1080 * aspectValue);
	const outputWidth = aspectValue >= 1 ? Math.round(1080 * aspectValue) : 1080;
	// fps / codec follow the real export format (mp4 encodes at 60fps H.264).
	const statusFps = exportFormat === "gif" ? gifFrameRate : 60;
	const statusCodec = exportFormat === "gif" ? "GIF" : "H.264";

	const fileMenu: MenuEntry[] = [
		{ kind: "item", label: tm("newProject"), onSelect: handleNewProject },
		{ kind: "item", label: tm("open"), onSelect: handleLoadProject, shortcut: `${modKey}O` },
		{ kind: "separator" },
		{ kind: "item", label: tm("save"), onSelect: handleSaveProject, shortcut: `${modKey}S` },
		{
			kind: "item",
			label: tm("saveAs"),
			onSelect: handleSaveProjectAs,
			shortcut: `⇧${modKey}S`,
		},
		{ kind: "separator" },
		{ kind: "item", label: tm("export"), onSelect: handleOpenExportDialog },
	];
	const editMenu: MenuEntry[] = [
		{ kind: "item", label: tm("undo"), onSelect: undo, shortcut: `${modKey}Z` },
		{ kind: "item", label: tm("redo"), onSelect: redo, shortcut: `⇧${modKey}Z` },
		{ kind: "separator" },
		{
			kind: "item",
			label: tm("split"),
			onSelect: menuSplitClips,
			disabled: !hasEditableSelection,
			shortcut: "S",
		},
		{
			kind: "item",
			label: tm("duplicate"),
			onSelect: menuDuplicateClips,
			disabled: !hasEditableSelection,
			shortcut: `${modKey}D`,
		},
		{
			kind: "item",
			label: tm("delete"),
			onSelect: menuDeleteClips,
			disabled: !hasEditableSelection,
			shortcut: "⌫",
		},
	];
	const viewMenu: MenuEntry[] = [
		{ kind: "item", label: tm("zoomIn"), onSelect: () => clipTimelineRef.current?.zoomIn() },
		{ kind: "item", label: tm("zoomOut"), onSelect: () => clipTimelineRef.current?.zoomOut() },
		{ kind: "item", label: tm("fit"), onSelect: () => clipTimelineRef.current?.zoomFit() },
		{ kind: "separator" },
		{
			kind: "checkbox",
			label: tm("toggleSnapping"),
			checked: snapEnabled,
			onSelect: toggleSnapEnabled,
		},
	];
	const helpMenu: MenuEntry[] = [
		{ kind: "item", label: tm("keyboardShortcuts"), onSelect: openConfig },
		{ kind: "item", label: tm("tutorial"), onSelect: () => setShowTutorial(true) },
	];

	return (
		<div className="flex flex-col h-screen bg-card text-foreground overflow-hidden selection:bg-primary/30">
			<TutorialHelp open={showTutorial} onOpenChange={setShowTutorial} />
			<Dialog open={showNewRecordingDialog} onOpenChange={setShowNewRecordingDialog}>
				<DialogContent
					className="sm:max-w-[425px]"
					style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
				>
					<DialogHeader>
						<DialogTitle>{t("newRecording.title")}</DialogTitle>
						<DialogDescription>{t("newRecording.description")}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<button
							type="button"
							onClick={() => setShowNewRecordingDialog(false)}
							className="px-4 py-2 rounded-md bg-muted text-foreground hover:bg-accent text-sm font-medium transition-colors"
						>
							{t("newRecording.cancel")}
						</button>
						<button
							type="button"
							onClick={handleNewRecordingConfirm}
							className="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium transition-colors"
						>
							{t("newRecording.confirm")}
						</button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={showAutoCaptionsDialog} onOpenChange={setShowAutoCaptionsDialog}>
				<DialogContent
					className="sm:max-w-md"
					style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
				>
					<DialogHeader>
						<DialogTitle>{t("autoCaptions.dialogTitle")}</DialogTitle>
						<DialogDescription>{t("autoCaptions.dialogDescription")}</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-2">
						<div className="grid gap-2">
							<Label htmlFor="caption-min-words">{t("autoCaptions.minWords")}</Label>
							<Select
								value={String(captionWordsMin)}
								onValueChange={(v) => {
									const n = Number.parseInt(v, 10);
									setCaptionWordsMin(n);
									if (n > captionWordsMax) setCaptionWordsMax(n);
								}}
							>
								<SelectTrigger id="caption-min-words" className="h-9">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CAPTION_WORD_CHOICES.map((n) => (
										<SelectItem key={`min-${n}`} value={String(n)}>
											{t("autoCaptions.wordsCount", { count: String(n) })}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="grid gap-2">
							<Label htmlFor="caption-max-words">{t("autoCaptions.maxWords")}</Label>
							<Select
								value={String(captionWordsMax)}
								onValueChange={(v) => {
									const n = Number.parseInt(v, 10);
									setCaptionWordsMax(n);
									if (n < captionWordsMin) setCaptionWordsMin(n);
								}}
							>
								<SelectTrigger id="caption-max-words" className="h-9">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CAPTION_WORD_CHOICES.map((n) => (
										<SelectItem key={`max-${n}`} value={String(n)}>
											{t("autoCaptions.wordsCount", { count: String(n) })}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					<DialogFooter className="gap-2 sm:gap-0">
						<Button
							type="button"
							variant="outline"
							onClick={() => setShowAutoCaptionsDialog(false)}
							className="border-border bg-transparent text-foreground hover:bg-accent"
						>
							{t("autoCaptions.dialogCancel")}
						</Button>
						<Button
							type="button"
							disabled={isAutoCaptioning}
							onClick={() => {
								setShowAutoCaptionsDialog(false);
								void generateAutoCaptions(captionWordsMin, captionWordsMax);
							}}
							className="bg-primary text-primary-foreground hover:bg-primary/90"
						>
							{t("autoCaptions.generate")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<div
				data-tauri-drag-region
				className="h-12 flex-shrink-0 bg-panel/95 backdrop-blur-xl border-b border-border flex items-center gap-3 px-3 z-50"
				style={{ WebkitAppRegion: "drag" } as CSSProperties}
			>
				{/* Left cluster: wordmark, menu bar, project name + autosave indicator */}
				<div
					className="flex items-center gap-2 min-w-0"
					style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
				>
					<span
						className={`font-extrabold text-[13.5px] tracking-tight text-foreground ${isMac ? "ml-16" : "ml-1"}`}
					>
						foxscreen
					</span>
					<span className="h-4 w-px bg-border" />
					<nav className="flex items-center gap-0.5">
						<TopMenu label={tm("file")} items={fileMenu} />
						<TopMenu label={tm("edit")} items={editMenu} />
						<TopMenu label={tm("view")} items={viewMenu} />
						<TopMenu label={tm("help")} items={helpMenu} />
					</nav>
					<span className="h-4 w-px bg-border" />
					<div className="flex items-center gap-1 min-w-0 text-[12px] font-medium text-muted-foreground">
						<span className="truncate max-w-[180px]">{projectName}</span>
						<span className="whitespace-nowrap text-[11px] text-muted-foreground/70">
							· {hasUnsavedChanges ? tm("unsaved") : tm("autosaved")}
						</span>
					</div>
				</div>

				<span className="flex-1" />

				{/* Right cluster: language, theme, undo/redo, recorder, load, save, export */}
				<div
					className="flex items-center gap-1"
					style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
				>
					<div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
						<Languages size={14} />
						<select
							value={locale}
							onChange={(e) => setLocale(e.target.value as Locale)}
							className="bg-transparent text-[11px] font-medium outline-none cursor-pointer appearance-none pr-1"
							style={{ color: "inherit" }}
						>
							{availableLocales.map((loc) => (
								<option key={loc} value={loc} className="bg-card text-foreground">
									{getLocaleName(loc)}
								</option>
							))}
						</select>
					</div>
					<ThemeToggle />
					<div className="flex items-center gap-0.5">
						<button
							type="button"
							title={tm("undo")}
							aria-label={tm("undo")}
							onClick={undo}
							className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-foreground/[0.03] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
						>
							<Undo2 size={15} />
						</button>
						<button
							type="button"
							title={tm("redo")}
							aria-label={tm("redo")}
							onClick={redo}
							className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-foreground/[0.03] text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
						>
							<Redo2 size={15} />
						</button>
					</div>
					<button
						type="button"
						onClick={() => setShowNewRecordingDialog(true)}
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors text-[11px] font-medium"
					>
						<Video size={14} />
						{t("newRecording.title")}
					</button>
					<button
						type="button"
						onClick={handleLoadProject}
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors text-[11px] font-medium"
					>
						<FolderOpen size={14} />
						{ts("project.load")}
					</button>
					<button
						type="button"
						onClick={handleSaveProject}
						className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors text-[11px] font-medium"
					>
						<Save size={14} />
						{ts("project.save")}
					</button>
					{/* cutti actions tucked from the topbar for now; flip SHOW_CUTTI_TOOLBAR to re-enter. */}
					{SHOW_CUTTI_TOOLBAR && (
						<>
							<button
								type="button"
								onClick={handleLoadCuttiDemo}
								className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors text-[11px] font-medium"
							>
								<Captions size={14} />
								cutti 字幕
							</button>
							<button
								type="button"
								onClick={handleCuttiFirstCut}
								className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors text-[11px] font-medium"
							>
								<Scissors size={14} />
								cutti 初剪
							</button>
							<button
								type="button"
								onClick={handleCuttiAiCut}
								className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors text-[11px] font-medium"
							>
								<Sparkles size={14} />
								cutti AI 剪
							</button>
						</>
					)}
					<button
						type="button"
						onClick={handleOpenExportDialog}
						className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-[12px] font-semibold shadow-[0_6px_16px_-8px_hsl(var(--primary)/0.7)]"
					>
						<Download size={14} />
						{tm("exportButton")}
					</button>
				</div>
			</div>

			{/* Empty state shown when no video is loaded */}
			{!videoPath && !projectOpen && (
				<div className="flex-1 min-h-0 relative">
					<EditorEmptyState
						onVideoImported={(path) => {
							setVideoPath(toFileUrl(path));
							setVideoSourcePath(path);
							setWebcamVideoPath(null);
							setWebcamVideoSourcePath(null);
							setProjectOpen(true);
							addMediaAsset(path);
						}}
						onNewProject={handleNewProject}
						onProjectOpened={async (project, path) => {
							const restored = await applyLoadedProject(project, path);
							if (!restored) {
								toast.error(t("project.invalidFormat"));
							}
						}}
					/>
				</div>
			)}

			{/* A project is the document: show the real editor (timeline + tracks) even
			    with no video source yet. The preview slot shows an import prompt until a
			    source is attached; the timeline/tracks render from the (possibly empty) project. */}
			{(videoPath || projectOpen) && (
				<div className="editor-workspace flex-1 min-h-0 relative">
					<PanelGroup direction="vertical" className="gap-0 min-h-0">
						{/* Top section: preview and contextual settings */}
						<Panel defaultSize={67} maxSize={76} minSize={46} className="min-h-[300px]">
							<PanelGroup
								direction="horizontal"
								className="h-full min-h-0"
								autoSaveId="foxscreen.topDeck.v3"
							>
								<Panel defaultSize={26} minSize={18} maxSize={40} className="min-h-0">
									<div className="editor-inspector-shell h-full w-full overflow-y-auto custom-scrollbar">
										<SettingsPanel
											selected={wallpaper}
											onWallpaperChange={(w) => pushState({ wallpaper: w })}
											mediaAssets={mediaAssets}
											mediaActivePath={videoSourcePath}
											onMediaImport={handleImportVideoSource}
											onMediaSelect={selectMediaAsset}
											onMediaRemove={removeMediaAsset}
											onMediaImportPaths={importMediaPaths}
											selectedZoomDepth={
												selectedZoomId
													? zoomRegions.find((z) => z.id === selectedZoomId)?.depth
													: null
											}
											onZoomDepthChange={(depth) => selectedZoomId && handleZoomDepthChange(depth)}
											selectedZoomCustomScale={
												selectedZoomId
													? (zoomRegions.find((z) => z.id === selectedZoomId)?.customScale ?? null)
													: null
											}
											onZoomCustomScaleChange={handleZoomCustomScaleChange}
											onZoomCustomScaleCommit={handleZoomCustomScaleCommit}
											onZoomPreviewStart={() => setIsPreviewingZoom(true)}
											onZoomPreviewEnd={() => setIsPreviewingZoom(false)}
											selectedZoomFocusMode={
												selectedZoomId
													? (zoomRegions.find((z) => z.id === selectedZoomId)?.focusMode ??
														"manual")
													: null
											}
											onZoomFocusModeChange={(mode) =>
												selectedZoomId && handleZoomFocusModeChange(mode)
											}
											focusModeLocked={autoFocusAll}
											selectedZoomFocus={
												selectedZoomId
													? (zoomRegions.find((z) => z.id === selectedZoomId)?.focus ?? null)
													: null
											}
											onZoomFocusCoordinateChange={(focus) =>
												selectedZoomId && handleZoomFocusChange(selectedZoomId, focus)
											}
											onZoomFocusCoordinateCommit={commitState}
											hasCursorTelemetry={cursorTelemetry.length > 0}
											selectedZoomId={selectedZoomId}
											onZoomDelete={handleZoomDelete}
											selectedZoomRotationPreset={
												selectedZoomId
													? (zoomRegions.find((z) => z.id === selectedZoomId)?.rotationPreset ??
														null)
													: null
											}
											onZoomRotationPresetChange={handleZoomRotationPresetChange}
											selectedTrimId={selectedTrimId}
											onTrimDelete={handleTrimDelete}
											shadowIntensity={shadowIntensity}
											onShadowChange={(v) => updateState({ shadowIntensity: v })}
											onShadowCommit={commitState}
											showBlur={showBlur}
											onBlurChange={(v) => pushState({ showBlur: v })}
											showTrimWaveform={showTrimWaveform}
											onTrimWaveformChange={(v) => pushState({ showTrimWaveform: v })}
											motionBlurAmount={motionBlurAmount}
											onMotionBlurChange={(v) => updateState({ motionBlurAmount: v })}
											onMotionBlurCommit={commitState}
											borderRadius={borderRadius}
											onBorderRadiusChange={(v) => updateState({ borderRadius: v })}
											onBorderRadiusCommit={commitState}
											padding={padding}
											onPaddingChange={(v) => updateState({ padding: v })}
											onPaddingCommit={commitState}
											cropRegion={cropRegion}
											onCropChange={(r) => pushState({ cropRegion: r })}
											aspectRatio={aspectRatio}
											hasWebcam={Boolean(webcamVideoPath)}
											webcamLayoutPreset={webcamLayoutPreset}
											onWebcamLayoutPresetChange={(preset) =>
												pushState({
													webcamLayoutPreset: preset,
													webcamPosition: preset === "picture-in-picture" ? webcamPosition : null,
												})
											}
											webcamMaskShape={webcamMaskShape}
											onWebcamMaskShapeChange={(shape) => pushState({ webcamMaskShape: shape })}
											webcamMirrored={webcamMirrored}
											webcamReactiveZoom={webcamReactiveZoom}
											onWebcamMirroredChange={(mirrored) => pushState({ webcamMirrored: mirrored })}
											onWebcamReactiveZoomChange={(reactive) =>
												pushState({ webcamReactiveZoom: reactive })
											}
											webcamSizePreset={webcamSizePreset}
											onWebcamSizePresetChange={(v) => updateState({ webcamSizePreset: v })}
											onWebcamSizePresetCommit={commitState}
											videoElement={videoPlaybackRef.current?.video || null}
											exportQuality={exportQuality}
											onExportQualityChange={setExportQuality}
											exportFormat={exportFormat}
											onExportFormatChange={setExportFormat}
											gifFrameRate={gifFrameRate}
											onGifFrameRateChange={setGifFrameRate}
											gifLoop={gifLoop}
											onGifLoopChange={setGifLoop}
											gifSizePreset={gifSizePreset}
											onGifSizePresetChange={setGifSizePreset}
											gifOutputDimensions={calculateOutputDimensions(
												calculateEffectiveSourceDimensions(
													videoPlaybackRef.current?.video?.videoWidth ||
														DEFAULT_SOURCE_DIMENSIONS.width,
													videoPlaybackRef.current?.video?.videoHeight ||
														DEFAULT_SOURCE_DIMENSIONS.height,
													cropRegion,
												).width,
												calculateEffectiveSourceDimensions(
													videoPlaybackRef.current?.video?.videoWidth ||
														DEFAULT_SOURCE_DIMENSIONS.width,
													videoPlaybackRef.current?.video?.videoHeight ||
														DEFAULT_SOURCE_DIMENSIONS.height,
													cropRegion,
												).height,
												gifSizePreset,
												GIF_SIZE_PRESETS,
												aspectRatio === "native"
													? getNativeAspectRatioValue(
															videoPlaybackRef.current?.video?.videoWidth ||
																DEFAULT_SOURCE_DIMENSIONS.width,
															videoPlaybackRef.current?.video?.videoHeight ||
																DEFAULT_SOURCE_DIMENSIONS.height,
															cropRegion,
														)
													: getAspectRatioValue(aspectRatio),
											)}
											onExport={handleOpenExportDialog}
											onExportPanelOpen={() => {
												setSelectedZoomId(null);
												setSelectedTrimId(null);
												setSelectedSpeedId(null);
											}}
											selectedAnnotationId={selectedAnnotationId}
											annotationRegions={annotationOnlyRegions}
											onAnnotationContentChange={handleAnnotationContentChange}
											onAnnotationTypeChange={handleAnnotationTypeChange}
											onAnnotationStyleChange={handleAnnotationStyleChange}
											onAnnotationFigureDataChange={handleAnnotationFigureDataChange}
											onAnnotationDuplicate={handleAnnotationDuplicate}
											onAnnotationDelete={handleAnnotationDelete}
											selectedBlurId={selectedBlurId}
											blurRegions={blurRegions}
											onBlurDataChange={handleBlurDataPanelChange}
											onBlurDataCommit={commitState}
											onBlurDelete={handleAnnotationDelete}
											selectedSpeedId={selectedSpeedId}
											selectedSpeedValue={
												selectedSpeedId
													? (speedRegions.find((r) => r.id === selectedSpeedId)?.speed ?? null)
													: null
											}
											onSpeedChange={handleSpeedChange}
											onSpeedDelete={handleSpeedDelete}
											unsavedExport={unsavedExport}
											onSaveUnsavedExport={handleSaveUnsavedExport}
											onSaveDiagnostic={handleSaveDiagnostic}
											showCursor={showCursor}
											onShowCursorChange={setShowCursor}
											cursorSize={cursorSize}
											onCursorSizeChange={setCursorSize}
											cursorSmoothing={cursorSmoothing}
											onCursorSmoothingChange={setCursorSmoothing}
											cursorMotionBlur={cursorMotionBlur}
											onCursorMotionBlurChange={setCursorMotionBlur}
											cursorClickBounce={cursorClickBounce}
											onCursorClickBounceChange={setCursorClickBounce}
											cursorClipToBounds={cursorClipToBounds}
											onCursorClipToBoundsChange={setCursorClipToBounds}
											cursorTheme={cursorTheme}
											onCursorThemeChange={setCursorTheme}
											hasCursorData={
												cursorTelemetry.length > 0 ||
												hasNativeCursorRecordingData(cursorRecordingData)
											}
											showCursorSettings={showCursorSettings}
											selectedClip={selectedClip}
											onClipChange={handleClipChange}
											onClipChangePreview={handleClipChangePreview}
											onClipCommit={handleClipsDragCommit}
											selectedClipCount={selectedClipIds.length}
											onSelectedClipsChange={handleSelectedClipsChange}
											onSelectedClipsDelete={handleDeleteSelectedClips}
										/>
									</div>
								</Panel>

								<PanelResizeHandle className="editor-resize-handle-h group">
									<div className="h-10 w-1 rounded-full bg-foreground/20 transition-colors group-hover:bg-primary/70" />
								</PanelResizeHandle>

								<Panel defaultSize={74} minSize={40} className="min-h-0">
									<div
										ref={playerContainerRef}
										className={
											isFullscreen
												? "fixed inset-0 z-[99999] w-full h-full flex flex-col items-center justify-center bg-card"
												: "editor-preview-panel w-full h-full flex flex-col items-center justify-center overflow-hidden relative"
										}
									>
										{/* Video preview */}
										<div className="w-full min-h-0 flex justify-center items-center flex-auto px-4 pt-4">
											<div
												className="relative flex justify-center items-center w-auto h-full max-w-full box-border"
												style={{
													aspectRatio:
														aspectRatio === "native"
															? getNativeAspectRatioValue(
																	videoPlaybackRef.current?.video?.videoWidth ||
																		DEFAULT_SOURCE_DIMENSIONS.width,
																	videoPlaybackRef.current?.video?.videoHeight ||
																		DEFAULT_SOURCE_DIMENSIONS.height,
																	cropRegion,
																)
															: getAspectRatioValue(aspectRatio),
												}}
											>
												{videoPath && !error ? (
													<VideoPlayback
														key={`${videoPath || "no-video"}:${webcamVideoPath || "no-webcam"}`}
														aspectRatio={aspectRatio}
														ref={videoPlaybackRef}
														videoPath={videoPath || ""}
														webcamVideoPath={webcamVideoPath || undefined}
														webcamLayoutPreset={webcamLayoutPreset}
														webcamMaskShape={webcamMaskShape}
														webcamMirrored={webcamMirrored}
														webcamReactiveZoom={webcamReactiveZoom}
														webcamSizePreset={webcamSizePreset}
														webcamPosition={webcamPosition}
														onWebcamPositionChange={(pos) => updateState({ webcamPosition: pos })}
														onWebcamPositionDragEnd={commitState}
														onDurationChange={setDuration}
														onTimeUpdate={handleVideoTime}
														currentTime={currentTime}
														onPlayStateChange={setIsPlaying}
														onError={setError}
														wallpaper={wallpaper}
														zoomRegions={zoomRegions}
														selectedZoomId={selectedZoomId}
														onSelectZoom={handleSelectZoom}
														onZoomFocusChange={handleZoomFocusChange}
														onZoomFocusDragEnd={commitState}
														isPlaying={isPlaying}
														showShadow={shadowIntensity > 0}
														shadowIntensity={shadowIntensity}
														showBlur={showBlur}
														motionBlurAmount={motionBlurAmount}
														borderRadius={borderRadius}
														padding={padding}
														cropRegion={cropRegion}
														cursorRecordingData={cursorRecordingData}
														trimRegions={trimRegions}
														speedRegions={speedRegions}
														annotationRegions={annotationOnlyRegions}
														selectedAnnotationId={selectedAnnotationId}
														onSelectAnnotation={handleSelectAnnotation}
														onAnnotationPositionChange={handleAnnotationPositionChange}
														onAnnotationSizeChange={handleAnnotationSizeChange}
														blurRegions={blurRegions}
														selectedBlurId={selectedBlurId}
														onSelectBlur={handleSelectBlur}
														onBlurPositionChange={handleAnnotationPositionChange}
														onBlurSizeChange={handleAnnotationSizeChange}
														onBlurDataChange={handleBlurDataPreviewChange}
														onBlurDataCommit={commitState}
														cursorTelemetry={cursorTelemetry}
														cursorClickTimestamps={cursorClickTimestamps}
														showCursor={effectiveShowCursor}
														cursorSize={cursorSize}
														cursorSmoothing={cursorSmoothing}
														cursorMotionBlur={cursorMotionBlur}
														cursorClickBounce={cursorClickBounce}
														cursorClipToBounds={cursorClipToBounds}
														cursorTheme={cursorTheme}
														isPreviewingZoom={isPreviewingZoom}
													/>
												) : (
													<div className="flex flex-col items-center justify-center gap-4 text-center px-6 w-full h-full">
														{/* A missing/failed video source is treated as an empty state, not a
														   scary load error — show the neutral "no video yet" message + the
														   import CTA. The underlying error is still kept in state for guards. */}
														<p className="text-sm max-w-xs text-muted-foreground">
															{t("emptyState.noSourceTitle")}
														</p>
														<button
															type="button"
															onClick={handleImportVideoSource}
															className="flex items-center justify-center gap-2.5 px-5 py-3 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-sm transition-colors"
														>
															<Video className="h-4 w-4" />
															{t("emptyState.importVideoButton")}
														</button>
													</div>
												)}
											</div>
										</div>
										{/* Playback controls */}
										<div className="w-full flex justify-center items-center h-14 flex-shrink-0 px-4 py-2">
											<div className="w-full max-w-[760px]">
												<PlaybackControls
													isPlaying={isPlaying}
													currentTime={currentTime}
													duration={timelineDuration}
													isFullscreen={isFullscreen}
													onToggleFullscreen={toggleFullscreen}
													onTogglePlayPause={togglePlayPause}
													onSeek={handleSeek}
												/>
											</div>
										</div>
									</div>
								</Panel>
							</PanelGroup>
						</Panel>

						<PanelResizeHandle className="editor-resize-handle group">
							<div className="w-10 h-1 bg-muted rounded-full transition-colors group-hover:bg-primary/70"></div>
						</PanelResizeHandle>

						{/* Full-width timeline */}
						<Panel defaultSize={33} maxSize={54} minSize={24} className="min-h-[210px]">
							<div className="editor-timeline-panel h-full overflow-hidden flex flex-col">
								<ClipTimeline
									ref={clipTimelineRef}
									clips={clips}
									transitions={transitions}
									snapEnabled={snapEnabled}
									onToggleSnap={toggleSnapEnabled}
									onAddTransition={handleAddTransition}
									onRemoveTransition={handleRemoveTransition}
									onClipsChange={handleClipsChange}
									onClipsDragPreview={handleClipsDragPreview}
									onClipsDragCommit={handleClipsDragCommit}
									tracks={tracks}
									onToggleTrackMuted={handleToggleTrackMuted}
									onToggleTrackSolo={handleToggleTrackSolo}
									onToggleTrackLocked={handleToggleTrackLocked}
									onAddTrack={handleAddTrack}
									onRemoveTrack={handleRemoveTrack}
									currentTime={currentTime}
									videoDuration={duration}
									onSeek={handleSeek}
									selectedClipIds={selectedClipIds}
									onSelectClip={handleSelectClip}
									onToggleClip={handleToggleClipSelection}
									onMarqueeSelect={handleSelectClipIds}
									onAddClip={handleAddClipFromBin}
								/>
							</div>
						</Panel>
					</PanelGroup>
				</div>
			)}

			{/* Full-width status bar: live track/clip counts + project output metrics. */}
			{(videoPath || projectOpen) && (
				<div className="flex h-7 flex-none items-center gap-3 border-t border-border bg-chrome px-4 font-mono text-[11px] text-muted-foreground">
					<span className="inline-flex items-center gap-1.5">
						<span className="h-1.5 w-1.5 rounded-full bg-primary" />
						{sbT("ready")}
					</span>
					<span>
						{sbT("tracksClips", { tracks: String(tracks.length), clips: String(clips.length) })}
					</span>
					<span className="flex-1" />
					<span>
						{outputWidth} × {outputHeight}
					</span>
					<span className="text-border">·</span>
					<span>{statusFps} fps</span>
					<span className="text-border">·</span>
					<span>{statusCodec}</span>
					<span className="text-border">·</span>
					<span className="text-foreground/70">
						{sbT("duration", { time: formatTimecode(timelineDuration) })}
					</span>
				</div>
			)}

			<ExportDialog
				isOpen={showExportDialog}
				onClose={() => setShowExportDialog(false)}
				progress={exportProgress}
				isExporting={isExporting}
				error={exportError}
				onCancel={handleCancelExport}
				exportFormat={exportFormat}
				exportedFilePath={exportedFilePath || undefined}
				onShowInFolder={
					exportedFilePath ? () => void handleShowExportedFile(exportedFilePath) : undefined
				}
			/>

			<UnsavedChangesDialog
				isOpen={showCloseConfirmDialog}
				onSaveAndClose={handleCloseConfirmSave}
				onDiscardAndClose={handleCloseConfirmDiscard}
				onCancel={handleCloseConfirmCancel}
			/>

			<UnsavedChangesDialog
				isOpen={confirmDialogVariant !== null}
				variant={confirmDialogVariant ?? "newProject"}
				onSaveAndClose={
					confirmDialogVariant === "loadProject"
						? handleLoadProjectConfirmSave
						: handleNewProjectConfirmSave
				}
				onDiscardAndClose={
					confirmDialogVariant === "loadProject"
						? handleLoadProjectConfirmDiscard
						: handleNewProjectConfirmDiscard
				}
				onCancel={() => setConfirmDialogVariant(null)}
			/>
		</div>
	);
}
