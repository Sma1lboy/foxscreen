import { AlertCircle, FilePlus, Film, FolderOpen, Upload, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useScopedT } from "@/contexts/I18nContext";
import { getProjectFolder, parentDirectoryOf, saveUserPreferences } from "@/lib/userPreferences";
import { nativeBridgeClient } from "@/native";

interface EditorEmptyStateProps {
	onVideoImported: (videoPath: string) => void;
	/** Called with the loaded project data; handles both button click and drag-drop */
	onProjectOpened: (project: unknown, path: string | null) => void;
	/** Create a blank project and enter the editor with no video source yet. */
	onNewProject: () => void;
}

type DropError = "unsupported-format" | "load-failed" | null;

export function EditorEmptyState({
	onVideoImported,
	onProjectOpened,
	onNewProject,
}: EditorEmptyStateProps) {
	const te = useScopedT("editor");
	const tc = useScopedT("common");
	const [isDraggingOver, setIsDraggingOver] = useState(false);
	const [dropError, setDropError] = useState<DropError>(null);
	// Freeze the last non-null error type so dialog content doesn't snap to the else-branch
	// during the closing animation (same pattern as UnsavedChangesDialog).
	const lastDropErrorRef = useRef<Exclude<DropError, null>>("unsupported-format");
	if (dropError !== null) {
		lastDropErrorRef.current = dropError;
	}

	const handleImportVideo = useCallback(async () => {
		const result = await window.electronAPI.openVideoFilePicker();
		if (result.canceled || !result.success || !result.path) return;

		const setResult = await nativeBridgeClient.project.setCurrentVideoPath(result.path);
		if (!setResult.success) return;

		onVideoImported(result.path);
	}, [onVideoImported]);

	const handleLoadProject = useCallback(async () => {
		const result = await nativeBridgeClient.project.loadProjectFile(getProjectFolder());
		if (result.canceled || !result.success || !result.project) return;
		if (result.path) {
			const folder = parentDirectoryOf(result.path);
			if (folder) {
				saveUserPreferences({ projectFolder: folder });
			}
		}
		onProjectOpened(result.project, result.path ?? null);
	}, [onProjectOpened]);

	const handleDragOver = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		if (e.dataTransfer.items.length > 0) {
			setIsDraggingOver(true);
		}
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		if (!e.currentTarget.contains(e.relatedTarget as Node)) {
			setIsDraggingOver(false);
		}
	}, []);

	const handleDrop = useCallback(
		async (e: React.DragEvent) => {
			e.preventDefault();
			setIsDraggingOver(false);

			const files = Array.from(e.dataTransfer.files);
			if (files.length === 0) return;

			const projectFile = files.find(
				(f) => f.name.endsWith(".foxscreen") || f.name.endsWith(".openscreen"),
			);
			if (!projectFile) {
				setDropError("unsupported-format");
				return;
			}

			// Use Electron's webUtils.getPathForFile; File.path was removed in Electron 32+
			let filePath: string;
			try {
				filePath = window.electronAPI.getPathForFile(projectFile);
			} catch {
				setDropError("load-failed");
				return;
			}
			if (!filePath) {
				setDropError("load-failed");
				return;
			}

			let result: Awaited<ReturnType<typeof window.electronAPI.loadProjectFileFromPath>>;
			try {
				result = await window.electronAPI.loadProjectFileFromPath(filePath);
			} catch {
				setDropError("load-failed");
				return;
			}
			if (!result.success || !result.project) {
				setDropError("load-failed");
				return;
			}

			onProjectOpened(result.project, result.path ?? null);
		},
		[onProjectOpened],
	);

	return (
		<div
			className="flex h-full w-full flex-col items-center justify-center bg-card"
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{/* Drop overlay */}
			{isDraggingOver && (
				<div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10">
					<Upload className="mb-3 h-10 w-10 text-primary" />
					<p className="text-base font-semibold text-primary">{te("emptyState.dropOverlay")}</p>
				</div>
			)}

			{/* Drop error dialog */}
			<Dialog open={dropError !== null} onOpenChange={(open) => !open && setDropError(null)}>
				<DialogContent className="bg-card border-border rounded-2xl max-w-sm p-6 gap-0">
					<DialogHeader className="mb-4">
						<div className="flex items-center gap-3">
							<img
								src="./foxscreen-logo.png"
								alt=""
								aria-hidden="true"
								className="w-9 h-9 rounded-xl flex-shrink-0"
							/>
							<DialogTitle className="text-base font-semibold text-foreground leading-tight">
								{lastDropErrorRef.current === "unsupported-format"
									? te("emptyState.dropErrors.unsupportedFormatTitle")
									: te("emptyState.dropErrors.couldNotOpenTitle")}
							</DialogTitle>
						</div>
					</DialogHeader>

					<div className="flex flex-col items-center gap-3 mb-6 text-center">
						<div className="flex items-center justify-center w-10 h-10 rounded-full bg-muted ring-1 ring-ring">
							<AlertCircle className="w-5 h-5 text-muted-foreground flex-shrink-0" />
						</div>
						<p className="text-sm text-muted-foreground leading-relaxed">
							{lastDropErrorRef.current === "unsupported-format"
								? te("emptyState.dropErrors.unsupportedFormatMessage")
								: te("emptyState.dropErrors.couldNotOpenMessage")}
						</p>
					</div>

					<button
						type="button"
						onClick={() => setDropError(null)}
						className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-muted hover:bg-accent border border-border text-foreground/80 font-medium text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					>
						<X className="w-4 h-4" />
						{tc("actions.close")}
					</button>
				</DialogContent>
			</Dialog>

			<div className="relative flex flex-col items-center gap-8 px-6 text-center">
				{/* Logo */}
				<img
					src="./foxscreen-logo.png"
					alt=""
					aria-hidden="true"
					className="h-16 w-16 rounded-2xl opacity-90"
				/>

				<div className="flex flex-col gap-2">
					<h2 className="text-xl font-semibold text-foreground">{te("emptyState.title")}</h2>
					<p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
						{te("emptyState.description")}
					</p>
				</div>

				{/* Actions */}
				<div className="flex flex-col gap-3 w-full max-w-xs">
					<button
						type="button"
						onClick={handleImportVideo}
						className="flex items-center justify-center gap-2.5 w-full px-4 py-3 rounded-xl bg-primary hover:bg-primary/90 active:bg-primary/80 text-primary-foreground font-medium text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					>
						<Film className="h-4 w-4" />
						{te("emptyState.importVideoButton")}
					</button>
					<button
						type="button"
						onClick={handleLoadProject}
						className="flex items-center justify-center gap-2.5 w-full px-4 py-3 rounded-xl bg-muted hover:bg-accent border border-border text-foreground/80 font-medium text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					>
						<FolderOpen className="h-4 w-4" />
						{te("emptyState.loadProjectButton")}
					</button>
					<button
						type="button"
						onClick={onNewProject}
						className="flex items-center justify-center gap-2.5 w-full px-4 py-2.5 rounded-xl text-muted-foreground hover:text-foreground hover:bg-accent font-medium text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					>
						<FilePlus className="h-4 w-4" />
						{te("emptyState.newProjectButton")}
					</button>
				</div>

				<div className="flex flex-col items-center gap-2">
					<p className="text-xs text-muted-foreground/70">{te("emptyState.supportedFormats")}</p>
					<div className="flex items-center gap-1.5 text-xs text-muted-foreground/70 mt-4">
						<Upload className="h-3 w-3" />
						<span>{te("emptyState.dragDropHint")}</span>
					</div>
				</div>
			</div>
		</div>
	);
}
