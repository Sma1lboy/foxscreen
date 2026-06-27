import { Film, FolderPlus, Upload, X } from "lucide-react";
import { type DragEvent, useCallback, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|wmv)$/i;

/** One imported source in the project's media library. */
export interface MediaAsset {
	id: string;
	/** Absolute file path of the source on disk. */
	path: string;
	/** Display name (basename). */
	name: string;
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

/**
 * The media library ("素材 Bin") — a first-class pane of every source imported
 * into the project. A standard NLE puts the bin alongside the preview + timeline;
 * this is the foundation for multi-source editing (sources you pick here become
 * the preview source today, and clips you drag onto the timeline next).
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

	return (
		<div
			className="editor-inspector-shell relative flex h-full w-full flex-col overflow-hidden"
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
			<div className="flex items-center justify-between px-3 py-2.5 border-b border-white/[0.06]">
				<span className="text-[13px] font-semibold text-slate-200">{t("mediaBin.title")}</span>
				<button
					type="button"
					onClick={onImport}
					title={t("mediaBin.import")}
					aria-label={t("mediaBin.import")}
					className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium text-slate-400 hover:text-slate-100 hover:bg-white/[0.06] transition-colors"
				>
					<FolderPlus className="h-3.5 w-3.5" />
				</button>
			</div>

			{assets.length === 0 ? (
				<button
					type="button"
					onClick={onImport}
					className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-slate-500 hover:text-slate-300 transition-colors"
				>
					<Film className="h-7 w-7 opacity-60" />
					<span className="text-xs leading-relaxed">{t("mediaBin.empty")}</span>
				</button>
			) : (
				<div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2">
					<div className="flex flex-col gap-1.5">
						{assets.map((asset) => {
							const isActive = activePath === asset.path;
							return (
								<div
									key={asset.id}
									role="button"
									tabIndex={0}
									onClick={() => onSelect(asset)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											onSelect(asset);
										}
									}}
									title={asset.path}
									className={`group/asset flex cursor-pointer items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left transition-colors ${
										isActive
											? "bg-primary/15 ring-1 ring-primary/40 text-slate-100"
											: "text-slate-300 hover:bg-white/[0.05]"
									}`}
								>
									<span
										className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md ${
											isActive ? "bg-primary/25 text-primary" : "bg-white/[0.05] text-slate-400"
										}`}
									>
										<Film className="h-4 w-4" />
									</span>
									<span className="min-w-0 flex-1 truncate text-xs font-medium">{asset.name}</span>
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											onRemove(asset);
										}}
										aria-label={t("mediaBin.remove")}
										className="flex-shrink-0 p-1 rounded text-slate-500 opacity-0 transition hover:text-slate-100 group-hover/asset:opacity-100"
									>
										<X className="h-3 w-3" />
									</button>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
