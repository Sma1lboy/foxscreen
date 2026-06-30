import { Film, FolderPlus, Music, Search, Upload, X } from "lucide-react";
import { type DragEvent, useCallback, useMemo, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|wmv|mpg|mpeg)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|aiff?|wma)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|tiff?|avif)$/i;

/**
 * `dataTransfer` MIME used when dragging a bin asset onto the timeline. Shared
 * with {@link ClipTimeline} so the drop target can recognize our own payload
 * (and ignore unrelated drags like OS file drops).
 */
export const ASSET_DRAG_MIME = "application/x-foxscreen-asset";

/** Coarse media kind derived from an asset's file extension. */
export type AssetKind = "video" | "audio" | "image";

/** One imported source in the project's media library. */
export interface MediaAsset {
	id: string;
	/** Absolute file path of the source on disk. */
	path: string;
	/** Display name (basename). */
	name: string;
	/** Source length in seconds, when known (renders a mono duration badge). */
	duration?: number;
	/** File size in bytes, when known (summed into the footer). */
	size?: number;
	/** Thumbnail as a usable image URL/data-URL, when available. */
	thumbnail?: string | null;
	/** Audio peak samples (0..1), when available — drives the waveform motif. */
	peaks?: number[];
}

/** Classify an asset by extension; defaults to video for unknown types. */
export function assetKind(asset: MediaAsset): AssetKind {
	const name = asset.name || asset.path;
	if (AUDIO_EXT.test(name)) return "audio";
	if (IMAGE_EXT.test(name)) return "image";
	return "video";
}

/** Stable non-negative hash of a string (for deterministic placeholders). */
function hashString(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/**
 * Token-only gradient classes for the placeholder thumbnail. Every entry uses
 * theme variables (no hardcoded hex) so light/dark both work; the asset's hash
 * picks one deterministically so each card looks distinct but stable.
 */
const PLACEHOLDER_GRADIENTS = [
	"from-primary/25 to-muted",
	"from-muted to-accent",
	"from-secondary/40 to-muted",
	"from-accent to-card",
	"from-primary/15 to-secondary/30",
	"from-muted to-primary/20",
];

/** m:ss timecode for a known asset duration. */
function formatDuration(sec: number): string {
	const total = Math.max(0, Math.round(sec));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

/** Human-readable byte size (e.g. "1.2 GB"); empty string for unknown. */
function formatSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let v = bytes;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Deterministic placeholder peaks for an audio asset with no real waveform data,
 * so the bars motif looks lively but stable across renders.
 */
function placeholderPeaks(seed: number, count: number): number[] {
	const out: number[] = [];
	let x = seed || 1;
	for (let i = 0; i < count; i++) {
		x = (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
		out.push(0.25 + (x % 1000) / 1000 / 1.4);
	}
	return out;
}

interface MediaBinProps {
	assets: MediaAsset[];
	/** The source path currently loaded in the preview (highlighted). */
	activePath: string | null;
	/** Open the file picker to add a source to the bin. */
	onImport: () => void;
	/** Load an existing asset into the preview. */
	onSelect: (asset: MediaAsset) => void;
	/** Remove an asset from the library. */
	onRemove: (asset: MediaAsset) => void;
	/** Import one or more video files (dropped onto the bin) by absolute path. */
	onImportPaths: (paths: string[]) => void;
}

/** Active type filter; `"all"` shows everything. */
type Filter = "all" | AssetKind;

/** Small waveform-bars motif for audio cards (real peaks or a placeholder set). */
function Waveform({ peaks }: { peaks: number[] }) {
	return (
		<div className="flex h-full w-full items-center justify-center gap-[2px] px-3">
			{peaks.map((h, i) => (
				<div
					key={`bar-${i}-${Math.round(h * 1000)}`}
					className="w-[2px] flex-shrink-0 rounded-full bg-primary/70"
					style={{ height: `${Math.round(Math.min(1, Math.max(0.12, h)) * 100)}%` }}
				/>
			))}
		</div>
	);
}

/** Thumbnail / waveform / gradient area at the top of a media card. */
function CardMedia({ asset, kind }: { asset: MediaAsset; kind: AssetKind }) {
	const seed = useMemo(() => hashString(asset.id || asset.path || asset.name), [asset]);

	if (kind === "audio") {
		const peaks =
			asset.peaks && asset.peaks.length > 0 ? asset.peaks.slice(0, 22) : placeholderPeaks(seed, 22);
		return (
			<div className="flex h-[74px] w-full items-center justify-center bg-muted/40">
				<Waveform peaks={peaks} />
			</div>
		);
	}

	if (asset.thumbnail) {
		return (
			<div className="h-[74px] w-full bg-muted">
				<img
					src={asset.thumbnail}
					alt=""
					className="h-full w-full object-cover"
					draggable={false}
				/>
			</div>
		);
	}

	const gradient = PLACEHOLDER_GRADIENTS[seed % PLACEHOLDER_GRADIENTS.length];
	return (
		<div
			className={`flex h-[74px] w-full items-center justify-center bg-gradient-to-br ${gradient}`}
		>
			{kind === "image" ? (
				<Film className="h-5 w-5 text-foreground/25" />
			) : (
				<Film className="h-5 w-5 text-foreground/20" />
			)}
		</div>
	);
}

/**
 * The media library ("素材 Bin") — a first-class pane of every source imported
 * into the project. A standard NLE puts the bin alongside the preview + timeline;
 * sources picked here become the preview source and clips dragged onto the
 * timeline. Cards support search, type filtering, thumbnails, and an audio
 * waveform motif while preserving the drag-to-timeline and remove affordances.
 */
export function MediaBin({
	assets,
	activePath,
	onImport,
	onSelect,
	onRemove,
	onImportPaths,
}: MediaBinProps) {
	const t = useScopedT("editor");
	const [isDraggingOver, setIsDraggingOver] = useState(false);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Filter>("all");

	const handleDrop = useCallback(
		(e: DragEvent) => {
			e.preventDefault();
			setIsDraggingOver(false);
			const paths: string[] = [];
			for (const file of Array.from(e.dataTransfer.files)) {
				if (!VIDEO_EXT.test(file.name)) continue;
				try {
					const p = window.electronAPI.getPathForFile(file);
					if (p) paths.push(p);
				} catch {
					// Skip files whose path can't be resolved.
				}
			}
			if (paths.length > 0) onImportPaths(paths);
		},
		[onImportPaths],
	);

	// Which type chips to show — only kinds actually present in the library
	// (plus "all"), so a video-only project doesn't show empty Audio/Image chips.
	const presentKinds = useMemo(() => {
		const set = new Set<AssetKind>();
		for (const a of assets) set.add(assetKind(a));
		return set;
	}, [assets]);

	// Visible assets after the type filter + case-insensitive name search.
	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return assets.filter((a) => {
			if (filter !== "all" && assetKind(a) !== filter) return false;
			if (q && !a.name.toLowerCase().includes(q)) return false;
			return true;
		});
	}, [assets, filter, query]);

	const totalSize = useMemo(
		() => assets.reduce((sum, a) => sum + (typeof a.size === "number" ? a.size : 0), 0),
		[assets],
	);
	const sizeLabel = formatSize(totalSize);

	const chips: { key: Filter; label: string }[] = [
		{ key: "all", label: t("mediaBin.filterAll") },
		...(presentKinds.has("video") ? [{ key: "video" as Filter, label: t("mediaBin.filterVideo") }] : []),
		...(presentKinds.has("audio") ? [{ key: "audio" as Filter, label: t("mediaBin.filterAudio") }] : []),
		...(presentKinds.has("image") ? [{ key: "image" as Filter, label: t("mediaBin.filterImage") }] : []),
	];

	return (
		<div
			className="relative flex h-full w-full flex-col overflow-hidden bg-panel"
			onDragOver={(e) => {
				e.preventDefault();
				if (e.dataTransfer.types.includes("Files")) setIsDraggingOver(true);
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDraggingOver(false);
			}}
			onDrop={handleDrop}
		>
			{isDraggingOver && (
				<div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-primary/60 bg-primary/10 text-primary">
					<Upload className="h-6 w-6" />
					<span className="text-xs font-semibold">{t("mediaBin.drop")}</span>
				</div>
			)}

			{/* Header: title + mono count badge + add button */}
			<div className="flex items-center gap-2 px-4 h-[46px] flex-none">
				<span className="text-[13px] font-bold text-foreground">{t("mediaBin.title")}</span>
				<span className="font-mono text-[11px] text-muted-foreground">{assets.length}</span>
				<span className="flex-1" />
				<button
					type="button"
					onClick={onImport}
					title={t("mediaBin.import")}
					aria-label={t("mediaBin.import")}
					className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-accent/40 text-foreground/80 hover:bg-accent hover:text-foreground transition-colors"
				>
					<FolderPlus className="h-3.5 w-3.5" />
				</button>
			</div>

			{assets.length === 0 ? (
				<button
					type="button"
					onClick={onImport}
					className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-muted-foreground hover:text-foreground/80 transition-colors"
				>
					<Film className="h-7 w-7 opacity-60" />
					<span className="text-xs leading-relaxed">{t("mediaBin.empty")}</span>
				</button>
			) : (
				<>
					{/* Search */}
					<div className="px-4 pb-2.5 flex-none">
						<div className="flex items-center gap-2 h-[34px] px-3 rounded-lg bg-accent/40 border border-border focus-within:border-primary/50 transition-colors">
							<Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
							<input
								type="text"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder={t("mediaBin.search")}
								aria-label={t("mediaBin.search")}
								className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
							/>
							{query && (
								<button
									type="button"
									onClick={() => setQuery("")}
									aria-label={t("mediaBin.clearSearch")}
									className="flex-shrink-0 text-muted-foreground hover:text-foreground"
								>
									<X className="h-3.5 w-3.5" />
								</button>
							)}
						</div>
					</div>

					{/* Type filter chips */}
					<div className="flex flex-wrap gap-1.5 px-4 pb-3 flex-none">
						{chips.map((chip) => {
							const isActive = filter === chip.key;
							return (
								<button
									key={chip.key}
									type="button"
									onClick={() => setFilter(chip.key)}
									className={`px-3 py-[5px] rounded-md text-[11.5px] font-semibold transition-colors ${
										isActive
											? "bg-primary/15 text-primary"
											: "text-muted-foreground hover:text-foreground hover:bg-accent/50"
									}`}
								>
									{chip.label}
								</button>
							);
						})}
					</div>

					{/* 2-column card grid */}
					<div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 pb-4">
						{visible.length === 0 ? (
							<p className="pt-6 text-center text-xs text-muted-foreground">
								{t("mediaBin.noResults")}
							</p>
						) : (
							<div className="grid grid-cols-2 gap-3 content-start">
								{visible.map((asset) => {
									const isActive = activePath === asset.path;
									const kind = assetKind(asset);
									return (
										<div
											key={asset.id}
											role="button"
											tabIndex={0}
											draggable
											onDragStart={(e) => {
												e.dataTransfer.setData(ASSET_DRAG_MIME, JSON.stringify(asset));
												e.dataTransfer.effectAllowed = "copy";
											}}
											onClick={() => onSelect(asset)}
											onKeyDown={(e) => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													onSelect(asset);
												}
											}}
											title={asset.path}
											className={`group/asset relative cursor-pointer overflow-hidden rounded-[10px] border bg-card transition-colors ${
												isActive
													? "border-primary ring-[3px] ring-primary/20"
													: "border-border hover:border-foreground/20"
											}`}
										>
											<div className="relative">
												<CardMedia asset={asset} kind={kind} />
												{kind === "audio" && (
													<span className="absolute left-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded bg-background/55 text-primary">
														<Music className="h-2.5 w-2.5" />
													</span>
												)}
												{typeof asset.duration === "number" && asset.duration > 0 && (
													<span className="absolute right-1.5 bottom-1.5 rounded bg-background/55 px-1 py-px font-mono text-[9px] text-foreground/90">
														{formatDuration(asset.duration)}
													</span>
												)}
												<button
													type="button"
													onClick={(e) => {
														e.stopPropagation();
														onRemove(asset);
													}}
													aria-label={t("mediaBin.remove")}
													className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded bg-background/55 text-foreground/80 opacity-0 transition hover:text-foreground group-hover/asset:opacity-100"
												>
													<X className="h-3 w-3" />
												</button>
											</div>
											<div
												className={`truncate px-2.5 py-[7px] text-[11px] font-semibold ${
													isActive ? "text-primary" : "text-foreground/85"
												}`}
											>
												{asset.name}
											</div>
										</div>
									);
								})}
							</div>
						)}
					</div>
				</>
			)}

			{/* Footer: mono asset count (+ summed size when known) */}
			{assets.length > 0 && (
				<div className="flex h-10 flex-none items-center gap-1.5 border-t border-border px-4 font-mono text-[11px] text-muted-foreground">
					<Film className="h-3 w-3 flex-shrink-0" />
					<span className="truncate">
						{sizeLabel
							? t("mediaBin.footer", { count: assets.length, size: sizeLabel })
							: t("mediaBin.footerNoSize", { count: assets.length })}
					</span>
				</div>
			)}
		</div>
	);
}
