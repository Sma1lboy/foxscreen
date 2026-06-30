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

const TEST_MEDIA = "/Users/jacksonc/i/cutti/examples/test-media";

/** A populated demo project (4 sources, clips across V1/V2/A3) for visual QA via
 *  `?seed=demo`. Videos won't load in a plain browser (file:// is blocked) but the
 *  bin, clips, timeline, and clip inspector all render. */
const DEMO_PROJECT = {
	version: 2,
	media: { screenVideoPath: `${TEST_MEDIA}/sample-10s.mp4` },
	editor: {},
	mediaLibrary: [
		// a1 is an audio source (unused by clips) so the media bin shows the
		// audio filter chip + waveform card in headless QA (?seed=demo).
		{ id: "a1", path: `${TEST_MEDIA}/vo_master.wav`, name: "vo_master.wav", size: 18_400_000 },
		{
			id: "a2",
			path: `${TEST_MEDIA}/bbb-10s.mp4`,
			name: "bbb-10s.mp4",
			duration: 10,
			size: 42_000_000,
		},
		{
			id: "a3",
			path: `${TEST_MEDIA}/sample-5s.mp4`,
			name: "sample-5s.mp4",
			duration: 5,
			size: 11_500_000,
		},
		{
			id: "a4",
			path: `${TEST_MEDIA}/sample-10s.mp4`,
			name: "sample-10s.mp4",
			duration: 10,
			size: 23_000_000,
		},
	],
	timelineClips: [
		{
			id: "c1",
			assetId: "a4",
			name: "sample-10s.mp4",
			sourcePath: `${TEST_MEDIA}/sample-10s.mp4`,
			trackIndex: 0,
			startSec: 0,
			inSec: 0,
			outSec: 10,
		},
		{
			id: "c2",
			assetId: "a3",
			name: "sample-5s.mp4",
			sourcePath: `${TEST_MEDIA}/sample-5s.mp4`,
			trackIndex: 0,
			// Overlaps c1 ([0,10]) across [8,10] so the crossfade affordance is visible
			// in headless QA (?seed=demo); click it to add a transition.
			startSec: 8,
			inSec: 0,
			outSec: 5,
		},
		{
			id: "c5",
			assetId: "a2",
			name: "bbb-10s.mp4",
			sourcePath: `${TEST_MEDIA}/bbb-10s.mp4`,
			trackIndex: 1,
			startSec: 2,
			inSec: 0,
			outSec: 10,
		},
		{
			id: "c6",
			assetId: "a3",
			name: "sample-5s.mp4",
			sourcePath: `${TEST_MEDIA}/sample-5s.mp4`,
			trackIndex: 2,
			startSec: 0,
			inSec: 0,
			outSec: 5,
		},
	],
};

/** Safe default `data` for a (domain, action) native-bridge request. */
function bridgeData(domain: string, action: string): unknown {
	switch (`${domain}.${action}`) {
		case "platform.getPlatform":
			return "darwin";
		case "project.loadCurrentProjectFile":
			return new URLSearchParams(window.location.search).get("seed") === "demo"
				? { success: true, project: DEMO_PROJECT, path: "demo" }
				: { success: false };
		case "project.getCurrentVideoPath":
			return { success: false };
		case "project.setCurrentVideoPath":
		case "project.clearCurrentVideoPath":
		case "project.saveProjectFile":
			return { success: true };
		case "project.loadProjectFile":
			return { canceled: true, success: false };
		// Cursor hooks run on every project with a source. They expect typed shapes
		// (an array / a CursorRecordingData), not a bare {} — returning {} crashes the
		// editor on `.filter`/`.length`. Empty-but-well-formed = inert, no crash.
		case "cursor.getTelemetry":
			return [];
		case "cursor.getRecordingData":
			return { version: 1, provider: "none", samples: [], assets: [] };
		case "cursor.getCapabilities":
			return { telemetry: false, systemAssets: false, provider: "none" };
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
