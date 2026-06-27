/**
 * Electron → Tauri compatibility shim.
 *
 * The whole renderer talks to the desktop backend through `window.electronApi`.
 * Rather than rewrite every call site, this shim re-implements that surface on
 * top of the official Tauri plugins (fs / dialog / os / shell). The core
 * import→edit→preview→export path is fully implemented; recording + HUD + menu
 * integration are stubbed (deferred — recording needs the native capture
 * helpers re-bridged through Rust, a separate effort).
 *
 * Installed at startup only when running under Tauri (`installElectronApiShim`).
 * Under Electron the real preload bridge is used and this is a no-op.
 */

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
	exists,
	mkdir,
	readFile,
	readTextFile,
	writeFile,
	writeTextFile,
} from "@tauri-apps/plugin-fs";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

const VIDEO_EXTENSIONS = ["webm", "mp4", "mov", "avi", "mkv", "m4v", "wmv", "flv", "ts"];

// In-renderer state that Electron kept in the main process.
let currentVideoPath: string | null = null;
let currentProjectPath: string | null = null;
let currentRecordingSession: unknown = null;

function dirname(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i > 0 ? p.slice(0, i) : "";
}

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

async function ensureParentDir(filePath: string): Promise<void> {
	const dir = dirname(filePath);
	if (dir && !(await exists(dir))) await mkdir(dir, { recursive: true });
}

// ── Core: file / project IO ────────────────────────────────────────────────

async function readBinaryFile(filePath: string) {
	try {
		const bytes = await readFile(filePath);
		// Copy into a standalone ArrayBuffer (Electron returned a fresh ArrayBuffer).
		const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		return { success: true, data: buf, path: filePath };
	} catch (e) {
		return { success: false, error: msg(e), message: msg(e) };
	}
}

async function openVideoFilePicker() {
	try {
		const picked = await openDialog({
			multiple: false,
			directory: false,
			filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
		});
		if (typeof picked !== "string") return { success: false, canceled: true };
		return { success: true, path: picked };
	} catch (e) {
		return { success: false, error: msg(e) };
	}
}

async function pickExportSavePath(fileName: string, _exportFolder?: string) {
	try {
		const picked = await saveDialog({
			defaultPath: fileName,
			filters: [
				{ name: "MP4 Video", extensions: ["mp4"] },
				{ name: "GIF", extensions: ["gif"] },
			],
		});
		if (typeof picked !== "string") return { success: false, canceled: true };
		return { success: true, path: picked };
	} catch (e) {
		return { success: false, error: msg(e) };
	}
}

async function writeExportToPath(videoData: ArrayBuffer, filePath: string) {
	try {
		await ensureParentDir(filePath);
		await writeFile(filePath, new Uint8Array(videoData));
		return { success: true, path: filePath };
	} catch (e) {
		return { success: false, error: msg(e) };
	}
}

async function saveProjectFile(
	projectData: unknown,
	suggestedName?: string,
	existingProjectPath?: string,
) {
	try {
		let target = existingProjectPath ?? null;
		if (!target) {
			const picked = await saveDialog({
				defaultPath: suggestedName ?? "project.foxscreen",
				filters: [{ name: "foxscreen project", extensions: ["foxscreen", "openscreen", "json"] }],
			});
			if (typeof picked !== "string") return { success: false, canceled: true };
			target = picked;
		}
		await ensureParentDir(target);
		await writeTextFile(target, JSON.stringify(projectData, null, 2));
		currentProjectPath = target;
		return { success: true, path: target };
	} catch (e) {
		return { success: false, error: msg(e) };
	}
}

async function readProjectAt(filePath: string) {
	const text = await readTextFile(filePath);
	const project = JSON.parse(text);
	currentProjectPath = filePath;
	return { success: true, path: filePath, project };
}

async function loadProjectFile(_projectFolder?: string) {
	try {
		const picked = await openDialog({
			multiple: false,
			directory: false,
			filters: [{ name: "foxscreen project", extensions: ["foxscreen", "openscreen", "json"] }],
		});
		if (typeof picked !== "string") return { success: false, canceled: true };
		return await readProjectAt(picked);
	} catch (e) {
		return { success: false, error: msg(e) };
	}
}

async function loadProjectFileFromPath(filePath: string) {
	try {
		return await readProjectAt(filePath);
	} catch (e) {
		return { success: false, error: msg(e) };
	}
}

async function loadCurrentProjectFile() {
	if (!currentProjectPath) return { success: false, message: "no current project" };
	try {
		return await readProjectAt(currentProjectPath);
	} catch (e) {
		return { success: false, error: msg(e) };
	}
}

function getPathForFile(_file: File): string {
	// Tauri webview Files carry no filesystem path; drag-drop import should use
	// the file picker (or the Tauri drag-drop event, wired later).
	return "";
}

async function setCurrentVideoPath(path: string) {
	currentVideoPath = path;
	currentProjectPath = null;
	return { success: true, path };
}
async function getCurrentVideoPath() {
	return currentVideoPath ? { success: true, path: currentVideoPath } : { success: false };
}
async function clearCurrentVideoPath() {
	currentVideoPath = null;
	currentProjectPath = null;
	currentRecordingSession = null;
	return { success: true };
}
async function setCurrentRecordingSession(session: unknown) {
	currentRecordingSession = session;
	return { success: true, session };
}
async function getCurrentRecordingSession() {
	return currentRecordingSession
		? { success: true, session: currentRecordingSession }
		: { success: false };
}

async function getPlatform(): Promise<string> {
	try {
		return await invoke<string>("get_platform");
	} catch {
		return "darwin";
	}
}

async function revealInFolder(filePath: string) {
	try {
		await shellOpen(dirname(filePath) || filePath);
		return { success: true };
	} catch (e) {
		return { success: false, error: msg(e) };
	}
}

async function openExternalUrl(url: string) {
	try {
		await shellOpen(url);
		return { success: true };
	} catch (e) {
		return { success: false, error: msg(e) };
	}
}

/**
 * The "native bridge" is a second IPC surface (src/native/client.ts) the editor
 * uses at startup via requireNativeBridgeData — which THROWS on ok:false. So we
 * dispatch by (domain, action) and return ok:true with the right data (reusing
 * the file-IO methods above; cursor/capabilities return empty). A failure here
 * would surface as a fatal "Error loading video" instead of the empty state.
 */
async function invokeNativeBridge<TData = unknown>(request?: {
	domain?: string;
	action?: string;
	payload?: Record<string, unknown>;
	requestId?: string;
}): Promise<{ ok: boolean; data?: TData; error?: unknown; meta: unknown }> {
	const req = request ?? {};
	const meta = {
		version: 1 as const,
		requestId: req.requestId ?? String(Date.now()),
		timestampMs: Date.now(),
	};
	const ok = (data: unknown) => ({ ok: true as const, data: data as TData, meta });
	const p = req.payload ?? {};
	switch (`${req.domain}.${req.action}`) {
		case "system.getPlatform":
			return ok(await getPlatform());
		case "system.getAssetBasePath":
			return ok("");
		case "system.getCapabilities":
			return ok({
				bridgeVersion: 1,
				platform: await getPlatform(),
				cursor: { telemetry: false, systemAssets: false, provider: "none" },
				project: { currentContext: true },
			});
		case "project.getCurrentContext":
			return ok({ currentProjectPath, currentVideoPath });
		case "project.saveProjectFile":
			return ok(
				await saveProjectFile(
					p.projectData,
					p.suggestedName as string | undefined,
					p.existingProjectPath as string | undefined,
				),
			);
		case "project.loadProjectFile":
			return ok(await loadProjectFile(p.projectFolder as string | undefined));
		case "project.loadCurrentProjectFile":
			return ok(await loadCurrentProjectFile());
		case "project.loadProjectFileFromPath":
			return ok(await loadProjectFileFromPath(p.path as string));
		case "project.setCurrentVideoPath":
			return ok(await setCurrentVideoPath(p.path as string));
		case "project.getCurrentVideoPath":
			return ok(await getCurrentVideoPath());
		case "project.clearCurrentVideoPath":
			return ok(await clearCurrentVideoPath());
		case "cursor.getCapabilities":
			return ok({ telemetry: false, systemAssets: false, provider: "none" });
		case "cursor.getTelemetry":
			return ok([]);
		case "cursor.getRecordingData":
			return ok({ version: 1, provider: "none", samples: [], assets: [] });
		default:
			return {
				ok: false,
				error: {
					code: "UNSUPPORTED_ACTION",
					message: `cutti tauri bridge: ${req.domain}.${req.action}`,
					retryable: false,
				},
				meta,
			};
	}
}

// ── Stubs: recording / HUD / menu (deferred) ────────────────────────────────

const RECORDING_DEFERRED = "recording is not available in the foxscreen Tauri build yet";
function deferred() {
	return Promise.resolve({
		success: false,
		error: RECORDING_DEFERRED,
		message: RECORDING_DEFERRED,
	});
}
function unavailable() {
	return Promise.resolve({ success: true, available: false, reason: "tauri-build" });
}
const noop = () => {};
const noopUnsub = (_cb?: unknown) => () => {};

// ── Assemble the surface ────────────────────────────────────────────────────

export function buildElectronApiShim() {
	return {
		// property
		assetBaseUrl: "",

		// core IO
		readBinaryFile,
		openVideoFilePicker,
		pickExportSavePath,
		writeExportToPath,
		saveProjectFile,
		loadProjectFile,
		loadProjectFileFromPath,
		loadCurrentProjectFile,
		getPathForFile,
		setCurrentVideoPath,
		getCurrentVideoPath,
		clearCurrentVideoPath,
		setCurrentRecordingSession,
		getCurrentRecordingSession,
		getPlatform,
		revealInFolder,
		openExternalUrl,
		invokeNativeBridge,
		preparePreviewAudioTrack: async (_p: string) => ({ success: false, path: null }),

		// settings (best-effort no-ops)
		getShortcuts: async () => null,
		saveShortcuts: async () => ({ success: true }),
		updateGlobalShortcut: async () => ({ success: true }),
		setLocale: async () => {},
		saveDiagnostic: async () => ({ success: false, canceled: true }),
		setHasUnsavedChanges: noop,

		// window / menu (stubs)
		switchToEditor: async () => {},
		switchToHud: async () => {},
		startNewRecording: deferred,
		onMenuNewProject: noopUnsub,
		onMenuImportVideo: noopUnsub,
		onMenuLoadProject: noopUnsub,
		onMenuSaveProject: noopUnsub,
		onMenuSaveProjectAs: noopUnsub,
		onRequestSaveBeforeClose: noopUnsub,
		onRequestCloseConfirm: noopUnsub,
		sendCloseConfirmResponse: noop,

		// recording / capture (deferred stubs)
		getSources: async () => [],
		selectSource: async () => null,
		getSelectedSource: async () => null,
		openSourceSelector: async () => ({ opened: false, reason: "tauri-build" }),
		requestScreenAccess: async () => ({ success: true, granted: false, status: "tauri-build" }),
		requestCameraAccess: async () => ({ success: true, granted: false, status: "tauri-build" }),
		requestNativeMacCursorAccess: async () => ({ success: true, granted: false }),
		isNativeMacCaptureAvailable: unavailable,
		isNativeWindowsCaptureAvailable: unavailable,
		startNativeMacRecording: deferred,
		stopNativeMacRecording: deferred,
		pauseNativeMacRecording: deferred,
		resumeNativeMacRecording: deferred,
		startNativeWindowsRecording: deferred,
		stopNativeWindowsRecording: deferred,
		pauseNativeWindowsRecording: deferred,
		resumeNativeWindowsRecording: deferred,
		attachNativeMacWebcamRecording: deferred,
		storeRecordedVideo: deferred,
		storeRecordedSession: deferred,
		openRecordingStream: deferred,
		appendRecordingChunk: deferred,
		closeRecordingStream: deferred,
		getRecordedVideoPath: deferred,
		setRecordingState: async () => {},
		getCursorTelemetry: async () => ({ success: false, samples: [] }),
		discardCursorTelemetry: async () => {},
		onStopRecordingFromTray: noopUnsub,

		// HUD / countdown (stubs)
		showCountdownOverlay: async () => {},
		setCountdownOverlayValue: async () => {},
		hideCountdownOverlay: async () => {},
		onCountdownOverlayValue: noopUnsub,
		hudOverlayHide: noop,
		hudOverlayClose: noop,
		moveHudOverlayBy: noop,
		setHudOverlaySize: noop,
		setHudOverlayIgnoreMouseEvents: noop,
		setMicrophoneExpanded: noop,
	};
}

/** True when running inside a Tauri webview. */
export function isTauri(): boolean {
	return (
		typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
	);
}

/**
 * Install the shim onto `window.electronApi` when under Tauri. Returns true if
 * installed. No-op (returns false) under Electron, where the real preload bridge
 * already provides `window.electronApi`.
 */
export function installElectronApiShim(): boolean {
	if (!isTauri()) return false;
	const w = window as unknown as { electronApi?: unknown; electronAPI?: unknown };
	const shim = buildElectronApiShim();
	w.electronApi = shim;
	// Some call sites historically used the `electronAPI` casing.
	w.electronAPI = shim;
	return true;
}
