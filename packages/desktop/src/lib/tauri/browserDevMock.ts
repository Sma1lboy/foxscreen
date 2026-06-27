/**
 * Browser dev mock for the native bridge.
 *
 * The app talks to the OS through `window.electronAPI` (and `nativeBridgeClient`,
 * which itself calls `window.electronAPI.invokeNativeBridge`). Under Tauri that's
 * the real shim; in a plain browser (`bun run dev:web` on :17420) it's absent, so
 * the editor can't mount. This installs a SAFE no-op mock so the renderer shell
 * boots for headless visual QA (`/browse` screenshots) — layout, theme, panels,
 * the empty/new-project editor. Native-dependent behaviour (real import, playback,
 * file IO) is intentionally inert. Dev + non-Tauri only.
 */

import { isTauri } from "./electronApiShim";

/** Safe default `data` for a (domain, action) native-bridge request. */
function bridgeData(domain: string, action: string): unknown {
	switch (`${domain}.${action}`) {
		case "platform.getPlatform":
			return "darwin";
		case "project.getCurrentVideoPath":
		case "project.loadCurrentProjectFile":
			return { success: false };
		case "project.setCurrentVideoPath":
		case "project.clearCurrentVideoPath":
		case "project.saveProjectFile":
			return { success: true };
		case "project.loadProjectFile":
			return { canceled: true, success: false };
		default:
			return {};
	}
}

/** Install the mock. Returns true if it was installed. */
export function installBrowserDevMock(): boolean {
	if (isTauri() || !import.meta.env.DEV) return false;
	const w = window as unknown as { electronApi?: unknown; electronAPI?: unknown };
	if (w.electronAPI) return false;

	const noopUnsub = () => () => {};
	// Explicit handlers for the shapes the editor reads on mount / idle.
	const explicit: Record<string, unknown> = {
		invokeNativeBridge: async (req: { domain: string; action: string }) => ({
			ok: true as const,
			data: bridgeData(req?.domain ?? "", req?.action ?? ""),
		}),
		getCurrentRecordingSession: async () => ({ success: false }),
		openVideoFilePicker: async () => ({ canceled: true, success: false }),
		loadProjectFileFromPath: async () => ({ success: false }),
		getPathForFile: () => "",
		readBinaryFile: async () => ({ success: false, data: new ArrayBuffer(0) }),
		openExternalUrl: () => {},
		setHasUnsavedChanges: () => {},
		sendCloseConfirmResponse: () => {},
		onRequestSaveBeforeClose: noopUnsub,
		onRequestCloseConfirm: noopUnsub,
		onMenuNewProject: noopUnsub,
		onMenuLoadProject: noopUnsub,
		onMenuSaveProject: noopUnsub,
		onMenuSaveProjectAs: noopUnsub,
		startNewRecording: async () => ({ success: false, error: "browser dev mock" }),
		revealInFolder: async () => ({ success: false }),
		pickExportSavePath: async () => ({ canceled: true }),
		writeExportToPath: async () => ({ success: false }),
		saveDiagnostic: async () => ({ success: false }),
	};

	// Any method we didn't enumerate → a permissive async no-op so nothing throws.
	const mock = new Proxy(explicit, {
		get(target, prop: string) {
			if (prop in target) return target[prop];
			return async () => ({});
		},
	});

	w.electronApi = mock;
	w.electronAPI = mock;
	// eslint-disable-next-line no-console
	console.info("[foxscreen] browser dev mock installed (non-Tauri) — native bridge is inert");
	return true;
}
