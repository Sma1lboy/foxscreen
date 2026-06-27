import { Save, Trash2 } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useScopedT } from "@/contexts/I18nContext";

interface UnsavedChangesDialogProps {
	isOpen: boolean;
	variant?: "close" | "newProject" | "loadProject";
	onSaveAndClose: () => void;
	onDiscardAndClose: () => void;
	onCancel: () => void;
}

export function UnsavedChangesDialog({
	isOpen,
	variant = "close",
	onSaveAndClose,
	onDiscardAndClose,
	onCancel,
}: UnsavedChangesDialogProps) {
	const td = useScopedT("dialogs");
	const tc = useScopedT("common");

	const detail =
		variant === "newProject"
			? td("unsavedChanges.detailNewProject")
			: variant === "loadProject"
				? td("unsavedChanges.detailLoadProject")
				: td("unsavedChanges.detail");
	const saveLabel =
		variant === "newProject"
			? td("unsavedChanges.saveAndNewProject")
			: variant === "loadProject"
				? td("unsavedChanges.saveAndLoadProject")
				: td("unsavedChanges.saveAndClose");
	const discardLabel =
		variant === "newProject"
			? td("unsavedChanges.discardAndNewProject")
			: variant === "loadProject"
				? td("unsavedChanges.discardAndLoadProject")
				: td("unsavedChanges.discardAndClose");

	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onCancel()}>
			<DialogContent className="bg-card border-border rounded-2xl max-w-sm p-6 gap-0">
				<DialogHeader className="mb-5">
					<div className="flex items-center gap-3">
						<img
							src="./openscreen.png"
							alt=""
							aria-hidden="true"
							className="w-9 h-9 rounded-xl flex-shrink-0"
						/>
						<DialogTitle className="text-base font-semibold text-foreground leading-tight">
							{td("unsavedChanges.title")}
						</DialogTitle>
					</div>
				</DialogHeader>

				<p className="text-sm text-foreground/80 mb-1">{td("unsavedChanges.message")}</p>
				<DialogDescription className="text-sm text-muted-foreground mb-6">
					{detail}
				</DialogDescription>

				<div className="flex flex-col gap-2">
					<button
						type="button"
						onClick={onSaveAndClose}
						className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-primary hover:bg-primary/90 active:bg-primary/80 text-primary-foreground font-medium text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					>
						<Save className="w-4 h-4" />
						{saveLabel}
					</button>
					<button
						type="button"
						onClick={onDiscardAndClose}
						className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg bg-muted hover:bg-destructive/15 border border-border hover:border-destructive/30 text-foreground/80 hover:text-destructive font-medium text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					>
						<Trash2 className="w-4 h-4" />
						{discardLabel}
					</button>
					<button
						type="button"
						onClick={onCancel}
						className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground/80 font-medium text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					>
						{tc("actions.cancel")}
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
