import { useEffect, useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
	CLIP_BLEND_MODES,
	type ClipBlendMode,
	clipBlendMode,
	clipDuration,
	clipEndSec,
	clipOpacity,
	clipRotationDeg,
	clipScale,
	MAX_CLIP_SCALE,
	MIN_CLIP_SCALE,
	type TimelineClip,
} from "./timeline/clipModel";

/** Editor-namespace `t` (passed in so labels resolve under `editor.clipInspector.*`). */
type ScopedT = (key: string) => string;

interface ClipInspectorProps {
	clip: TimelineClip;
	/** Discrete edit → one undo step (switch / dropdown). */
	onChange?: (patch: Partial<TimelineClip>) => void;
	/** Live edit during a slider/number drag (checkpoints once per gesture). */
	onPreview?: (patch: Partial<TimelineClip>) => void;
	/** Seal the in-progress gesture into a single undo step. */
	onCommit?: () => void;
	/** Scoped to the `editor` namespace by the parent. */
	t: ScopedT;
}

/** Format a non-negative second count as `m:ss.t` (e.g. 73.4 → `1:13.4`). */
function formatSeconds(sec: number): string {
	const safe = Math.max(0, sec);
	const minutes = Math.floor(safe / 60);
	const seconds = safe - minutes * 60;
	return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** Deterministic 0–1 pseudo-noise from a string seed — drives the decorative
 *  audio-waveform motif (no real PCM available in the inspector). */
function seededBars(seed: string, count: number): number[] {
	let h = 0;
	for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
	const bars: number[] = [];
	for (let i = 0; i < count; i++) {
		h = (h * 1103515245 + 12345) & 0x7fffffff;
		bars.push(0.2 + ((h >>> 8) % 1000) / 1250); // 0.2 … 1.0
	}
	return bars;
}

const SECTION_LABEL = "text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground";
const FIELD_LABEL = "text-xs font-medium text-foreground/80";
const VALUE_LABEL = "font-mono text-[10px] text-muted-foreground";
const SLIDER_CLASS =
	"w-full [&_[role=slider]]:h-3 [&_[role=slider]]:w-3 [&_[role=slider]]:border-primary [&_[role=slider]]:bg-primary ";

/** A labelled slider row that streams via `onPreview` and seals via `onCommit`. */
function SliderRow({
	label,
	value,
	display,
	min,
	max,
	step,
	disabled,
	onPreview,
	onCommit,
}: {
	label: string;
	value: number;
	display: string;
	min: number;
	max: number;
	step: number;
	disabled?: boolean;
	onPreview: (v: number) => void;
	onCommit: () => void;
}) {
	return (
		<div className={cn("rounded-lg editor-control-surface p-3", disabled && "opacity-50")}>
			<div className="mb-2 flex items-center justify-between">
				<span className={FIELD_LABEL}>{label}</span>
				<span className={VALUE_LABEL}>{display}</span>
			</div>
			<Slider
				value={[value]}
				min={min}
				max={max}
				step={step}
				disabled={disabled}
				onValueChange={(values) => onPreview(values[0])}
				onValueCommit={() => onCommit()}
				className={SLIDER_CLASS}
			/>
		</div>
	);
}

/** A number input that streams via `onPreview` while typing and seals on blur. */
function NumberField({
	label,
	value,
	onPreview,
	onCommit,
}: {
	label: string;
	value: number;
	onPreview: (v: number) => void;
	onCommit: () => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	return (
		<div className="flex-1">
			<div className="mb-1.5 text-[11px] text-muted-foreground">{label}</div>
			<input
				type="number"
				inputMode="numeric"
				aria-label={label}
				value={draft ?? String(Math.round(value))}
				onFocus={() => setDraft(String(Math.round(value)))}
				onChange={(e) => {
					setDraft(e.target.value);
					const parsed = Number(e.target.value);
					if (e.target.value !== "" && Number.isFinite(parsed)) onPreview(parsed);
				}}
				onBlur={() => {
					setDraft(null);
					onCommit();
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") (e.target as HTMLInputElement).blur();
				}}
				className="h-8 w-full rounded-md border border-border bg-muted px-2.5 font-mono text-xs text-foreground outline-none focus:border-primary/50 focus:ring-1 focus:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
			/>
		</div>
	);
}

const TAB_TRIGGER_CLASS =
	"flex-1 rounded-md text-xs data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:shadow-none";

/**
 * Left-panel inspector for one selected timeline clip, organised into three tabs:
 * Properties (read-only facts + Transform + Composite), Color (basic colour
 * grade) and Audio (gain / mute / fades). Pure presentation — every mutation
 * flows up through `onChange` (discrete) or `onPreview`/`onCommit` (drag).
 */
export function ClipInspector({ clip, onChange, onPreview, onCommit, t }: ClipInspectorProps) {
	const duration = clipDuration(clip);
	const halfDuration = duration / 2;
	const volumePercent = Math.round((clip.volume ?? 1) * 100);
	const muted = clip.muted ?? false;
	const fadeIn = clip.fadeInSec ?? 0;
	const fadeOut = clip.fadeOutSec ?? 0;

	const scale = clipScale(clip);
	const rotation = clipRotationDeg(clip);
	const opacity = clipOpacity(clip);
	const blend = clipBlendMode(clip);

	const change = onChange ?? (() => undefined);
	const preview = onPreview ?? change;
	const commit = onCommit ?? (() => undefined);

	return (
		<div className="min-w-0 flex flex-col h-full bg-card">
			{/* Clip header: thumb chip + filename + mono track · start → end. */}
			<div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
				<div className="h-9 w-14 flex-none rounded-md border border-border bg-gradient-to-br from-muted to-accent" />
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-bold text-foreground" title={clip.name}>
						{clip.name}
					</div>
					<div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
						{t("clipInspector.trackLabel")}
						{clip.trackIndex + 1} · {formatSeconds(clip.startSec)} →{" "}
						{formatSeconds(clipEndSec(clip))}
					</div>
				</div>
			</div>

			<Tabs defaultValue="properties" className="flex min-h-0 flex-1 flex-col">
				<TabsList className="m-2 flex h-9 bg-muted/60">
					<TabsTrigger value="properties" className={TAB_TRIGGER_CLASS}>
						{t("clipInspector.tabProperties")}
					</TabsTrigger>
					<TabsTrigger value="color" className={TAB_TRIGGER_CLASS}>
						{t("clipInspector.tabColor")}
					</TabsTrigger>
					<TabsTrigger value="audio" className={TAB_TRIGGER_CLASS}>
						{t("clipInspector.tabAudio")}
					</TabsTrigger>
				</TabsList>

				{/* ---------------------------------------------------------------- */}
				{/* PROPERTIES */}
				{/* ---------------------------------------------------------------- */}
				<TabsContent
					value="properties"
					className="mt-0 min-h-0 flex-1 space-y-4 overflow-y-auto custom-scrollbar p-4"
				>
					<div className="space-y-2 rounded-lg editor-control-surface p-3 text-[11px]">
						<div className="flex items-center justify-between gap-3">
							<span className="text-muted-foreground">{t("clipInspector.timelinePosition")}</span>
							<span className="font-mono tabular-nums text-foreground">
								{formatSeconds(clip.startSec)} – {formatSeconds(clipEndSec(clip))}
							</span>
						</div>
						<div className="flex items-center justify-between gap-3">
							<span className="text-muted-foreground">{t("clipInspector.sourceRange")}</span>
							<span className="font-mono tabular-nums text-foreground">
								{formatSeconds(clip.inSec)} – {formatSeconds(clip.outSec)}
							</span>
						</div>
						<div className="flex items-center justify-between gap-3">
							<span className="text-muted-foreground">{t("clipInspector.duration")}</span>
							<span className="font-mono tabular-nums text-foreground">
								{formatSeconds(duration)}
							</span>
						</div>
					</div>

					{/* 变换 Transform */}
					<div className="space-y-3">
						<span className={SECTION_LABEL}>{t("clipInspector.transform")}</span>
						<div className="flex gap-2.5">
							<NumberField
								label={t("clipInspector.positionX")}
								value={clip.posX ?? 0}
								onPreview={(v) => preview({ posX: v })}
								onCommit={commit}
							/>
							<NumberField
								label={t("clipInspector.positionY")}
								value={clip.posY ?? 0}
								onPreview={(v) => preview({ posY: v })}
								onCommit={commit}
							/>
						</div>
						<SliderRow
							label={t("clipInspector.scale")}
							value={scale}
							display={`${Math.round(scale * 100)}%`}
							min={MIN_CLIP_SCALE}
							max={MAX_CLIP_SCALE}
							step={0.01}
							onPreview={(v) => preview({ scale: v })}
							onCommit={commit}
						/>
						<SliderRow
							label={t("clipInspector.rotation")}
							value={rotation}
							display={`${Math.round(rotation)}°`}
							min={-180}
							max={180}
							step={1}
							onPreview={(v) => preview({ rotationDeg: v })}
							onCommit={commit}
						/>
					</div>

					{/* 合成 Composite */}
					<div className="space-y-3">
						<span className={SECTION_LABEL}>{t("clipInspector.composite")}</span>
						<SliderRow
							label={t("clipInspector.opacity")}
							value={opacity}
							display={`${Math.round(opacity * 100)}%`}
							min={0}
							max={1}
							step={0.01}
							onPreview={(v) => preview({ opacity: v })}
							onCommit={commit}
						/>
						<div className="rounded-lg editor-control-surface p-3">
							<div className="mb-2">
								<span className={FIELD_LABEL}>{t("clipInspector.blendMode")}</span>
							</div>
							<Select
								value={blend}
								onValueChange={(value) => change({ blendMode: value as ClipBlendMode })}
							>
								<SelectTrigger className="h-8 border-border bg-muted text-xs">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CLIP_BLEND_MODES.map((mode) => (
										<SelectItem key={mode} value={mode} className="text-xs">
											{t(`clipInspector.blend.${mode}`)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
				</TabsContent>

				{/* ---------------------------------------------------------------- */}
				{/* COLOR */}
				{/* ---------------------------------------------------------------- */}
				<TabsContent
					value="color"
					className="mt-0 min-h-0 flex-1 space-y-3 overflow-y-auto custom-scrollbar p-4"
				>
					<span className={SECTION_LABEL}>{t("clipInspector.colorGrade")}</span>
					<SliderRow
						label={t("clipInspector.exposure")}
						value={clip.exposure ?? 0}
						display={`${(clip.exposure ?? 0) > 0 ? "+" : ""}${Math.round(clip.exposure ?? 0)}`}
						min={-100}
						max={100}
						step={1}
						onPreview={(v) => preview({ exposure: v })}
						onCommit={commit}
					/>
					<SliderRow
						label={t("clipInspector.contrast")}
						value={clip.contrast ?? 0}
						display={`${(clip.contrast ?? 0) > 0 ? "+" : ""}${Math.round(clip.contrast ?? 0)}`}
						min={-100}
						max={100}
						step={1}
						onPreview={(v) => preview({ contrast: v })}
						onCommit={commit}
					/>
					<SliderRow
						label={t("clipInspector.saturation")}
						value={clip.saturation ?? 0}
						display={`${(clip.saturation ?? 0) > 0 ? "+" : ""}${Math.round(clip.saturation ?? 0)}`}
						min={-100}
						max={100}
						step={1}
						onPreview={(v) => preview({ saturation: v })}
						onCommit={commit}
					/>
					<SliderRow
						label={t("clipInspector.temperature")}
						value={clip.temperature ?? 0}
						display={`${(clip.temperature ?? 0) > 0 ? "+" : ""}${Math.round(clip.temperature ?? 0)}`}
						min={-100}
						max={100}
						step={1}
						onPreview={(v) => preview({ temperature: v })}
						onCommit={commit}
					/>
				</TabsContent>

				{/* ---------------------------------------------------------------- */}
				{/* AUDIO */}
				{/* ---------------------------------------------------------------- */}
				<TabsContent
					value="audio"
					className="mt-0 min-h-0 flex-1 space-y-3 overflow-y-auto custom-scrollbar p-4"
				>
					<span className={SECTION_LABEL}>{t("clipInspector.audio")}</span>

					<div className="flex items-center justify-between gap-3 rounded-lg editor-control-surface p-3">
						<span className={FIELD_LABEL}>{t("clipInspector.mute")}</span>
						<Switch
							checked={muted}
							onCheckedChange={(checked) => change({ muted: checked })}
							className="data-[state=checked]:bg-primary scale-90"
							aria-label={t("clipInspector.mute")}
						/>
					</div>

					<SliderRow
						label={t("clipInspector.volume")}
						value={volumePercent}
						display={`${volumePercent}%`}
						min={0}
						max={100}
						step={1}
						disabled={muted}
						onPreview={(v) => preview({ volume: v / 100 })}
						onCommit={commit}
					/>

					<SliderRow
						label={t("clipInspector.fadeIn")}
						value={Math.min(fadeIn, halfDuration)}
						display={formatSeconds(Math.min(fadeIn, halfDuration))}
						min={0}
						max={Math.max(halfDuration, 0.01)}
						step={0.05}
						onPreview={(v) => preview({ fadeInSec: v })}
						onCommit={commit}
					/>

					<SliderRow
						label={t("clipInspector.fadeOut")}
						value={Math.min(fadeOut, halfDuration)}
						display={formatSeconds(Math.min(fadeOut, halfDuration))}
						min={0}
						max={Math.max(halfDuration, 0.01)}
						step={0.05}
						onPreview={(v) => preview({ fadeOutSec: v })}
						onCommit={commit}
					/>

					{/* Decorative waveform motif (deterministic from the clip id). */}
					<WaveformMotif seed={clip.id} />
				</TabsContent>
			</Tabs>
		</div>
	);
}

/** Decorative, deterministic waveform bar strip (no real PCM in the inspector). */
function WaveformMotif({ seed }: { seed: string }) {
	const [bars, setBars] = useState<number[]>([]);
	// Compute after mount so SSR/headless markup stays stable & key-free of math.
	useEffect(() => {
		setBars(seededBars(seed, 48));
	}, [seed]);
	return (
		<div className="flex h-12 items-center gap-[2px] overflow-hidden rounded-lg editor-control-surface px-2.5">
			{bars.map((h, i) => (
				<div
					key={`${seed}-${i}`}
					className="w-[2px] flex-none rounded-sm bg-primary/55"
					style={{ height: `${Math.round(h * 100)}%` }}
				/>
			))}
		</div>
	);
}
