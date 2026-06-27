import { Film, FolderPlus } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";

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
}

/**
 * The media library ("素材 Bin") — a first-class pane of every source imported
 * into the project. A standard NLE puts the bin alongside the preview + timeline;
 * this is the foundation for multi-source editing (sources you pick here become
 * the preview source today, and clips you drag onto the timeline next).
 */
export function MediaBin({ assets, activePath, onImport, onSelect }: MediaBinProps) {
	const t = useScopedT("editor");

	return (
		<div className="editor-inspector-shell flex h-full w-full flex-col overflow-hidden">
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
								<button
									key={asset.id}
									type="button"
									onClick={() => onSelect(asset)}
									title={asset.path}
									className={`flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left transition-colors ${
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
								</button>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}
