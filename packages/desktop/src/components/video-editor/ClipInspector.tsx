import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { clipDuration, clipEndSec, type TimelineClip } from "./timeline/clipModel";

/** Editor-namespace `t` (passed in so labels resolve under `editor.clipInspector.*`). */
type ScopedT = (key: string) => string;

interface ClipInspectorProps {
	clip: TimelineClip;
	onChange?: (patch: Partial<TimelineClip>) => void;
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

/**
 * Left-panel inspector for one selected timeline clip: read-only position/source
 * facts plus the editable per-clip audio controls (volume / mute / fade-in /
 * fade-out). Pure presentation — every mutation flows up through `onChange`.
 */
export function ClipInspector({ clip, onChange, t }: ClipInspectorProps) {
	const duration = clipDuration(clip);
	const halfDuration = duration / 2;
	const volumePercent = Math.round((clip.volume ?? 1) * 100);
	const muted = clip.muted ?? false;
	const fadeIn = clip.fadeInSec ?? 0;
	const fadeOut = clip.fadeOutSec ?? 0;

	return (
		<div className="min-w-0 p-4 flex flex-col h-full overflow-y-auto custom-scrollbar bg-card">
			<div className="mb-4">
				<span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
					{t("clipInspector.title")}
				</span>
				<div className="mt-1 truncate text-xl font-semibold text-foreground" title={clip.name}>
					{clip.name}
				</div>
			</div>

			<div className="mb-4 space-y-2 rounded-lg editor-control-surface p-3 text-[11px]">
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
					<span className="font-mono tabular-nums text-foreground">{formatSeconds(duration)}</span>
				</div>
			</div>

			<div className="space-y-3">
				<span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
					{t("clipInspector.audio")}
				</span>

				<div className="flex items-center justify-between gap-3 rounded-lg editor-control-surface p-3">
					<span className="text-xs font-medium text-foreground/80">{t("clipInspector.mute")}</span>
					<Switch
						checked={muted}
						onCheckedChange={(checked) => onChange?.({ muted: checked })}
						className="data-[state=checked]:bg-primary scale-90"
						aria-label={t("clipInspector.mute")}
					/>
				</div>

				<div
					className={cn(
						"rounded-lg editor-control-surface p-3 transition-opacity",
						muted && "opacity-50",
					)}
				>
					<div className="mb-2 flex items-center justify-between">
						<span className="text-xs font-medium text-foreground/80">
							{t("clipInspector.volume")}
						</span>
						<span className="font-mono text-[10px] text-muted-foreground">{volumePercent}%</span>
					</div>
					<Slider
						value={[volumePercent]}
						onValueChange={(values) => onChange?.({ volume: values[0] / 100 })}
						min={0}
						max={100}
						step={1}
						disabled={muted}
						className="w-full [&_[role=slider]]:h-3 [&_[role=slider]]:w-3 [&_[role=slider]]:border-primary [&_[role=slider]]:bg-primary "
					/>
				</div>

				<div className="rounded-lg editor-control-surface p-3">
					<div className="mb-2 flex items-center justify-between">
						<span className="text-xs font-medium text-foreground/80">
							{t("clipInspector.fadeIn")}
						</span>
						<span className="font-mono text-[10px] text-muted-foreground">
							{formatSeconds(Math.min(fadeIn, halfDuration))}
						</span>
					</div>
					<Slider
						value={[Math.min(fadeIn, halfDuration)]}
						onValueChange={(values) => onChange?.({ fadeInSec: values[0] })}
						min={0}
						max={Math.max(halfDuration, 0.01)}
						step={0.05}
						className="w-full [&_[role=slider]]:h-3 [&_[role=slider]]:w-3 [&_[role=slider]]:border-primary [&_[role=slider]]:bg-primary "
					/>
				</div>

				<div className="rounded-lg editor-control-surface p-3">
					<div className="mb-2 flex items-center justify-between">
						<span className="text-xs font-medium text-foreground/80">
							{t("clipInspector.fadeOut")}
						</span>
						<span className="font-mono text-[10px] text-muted-foreground">
							{formatSeconds(Math.min(fadeOut, halfDuration))}
						</span>
					</div>
					<Slider
						value={[Math.min(fadeOut, halfDuration)]}
						onValueChange={(values) => onChange?.({ fadeOutSec: values[0] })}
						min={0}
						max={Math.max(halfDuration, 0.01)}
						step={0.05}
						className="w-full [&_[role=slider]]:h-3 [&_[role=slider]]:w-3 [&_[role=slider]]:border-primary [&_[role=slider]]:bg-primary "
					/>
				</div>
			</div>
		</div>
	);
}
