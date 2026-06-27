import { describe, expect, it } from "vitest";
import { buildElectronApiShim, isTauri } from "../electronApiShim";

describe("electronApi Tauri shim", () => {
	const api = buildElectronApiShim() as unknown as Record<string, unknown>;

	it("isTauri() is false outside a Tauri webview (node test env)", () => {
		expect(isTauri()).toBe(false);
	});

	it("exposes the core import→edit→preview→export IO surface", () => {
		for (const k of [
			"readBinaryFile",
			"openVideoFilePicker",
			"pickExportSavePath",
			"writeExportToPath",
			"saveProjectFile",
			"loadProjectFile",
			"loadProjectFileFromPath",
			"getPlatform",
			"getPathForFile",
			"setCurrentVideoPath",
			"invokeNativeBridge",
		]) {
			expect(typeof api[k]).toBe("function");
		}
		expect(api.assetBaseUrl).toBe("");
	});

	it("getPathForFile returns '' (no fs path from a webview File)", () => {
		const getPathForFile = api.getPathForFile as (f: File) => string;
		expect(getPathForFile(new File([], "x.mp4"))).toBe("");
	});

	it("recording methods are stubbed (deferred)", async () => {
		const start = api.startNativeMacRecording as () => Promise<{ success: boolean }>;
		expect((await start()).success).toBe(false);
		const avail = api.isNativeMacCaptureAvailable as () => Promise<{ available: boolean }>;
		expect((await avail()).available).toBe(false);
	});

	it("menu/event registrations return an unsubscribe function", () => {
		const onSave = api.onMenuSaveProject as (cb: () => void) => unknown;
		expect(typeof onSave(() => {})).toBe("function");
	});

	it("invokeNativeBridge dispatches known actions (ok:true), rejects unknown (ok:false)", async () => {
		const inb = api.invokeNativeBridge as (
			req?: unknown,
		) => Promise<{ ok: boolean; data?: unknown }>;
		// getCurrentVideoPath with no video → ok:true, data.success=false (→ editor empty state)
		const known = await inb({ domain: "project", action: "getCurrentVideoPath" });
		expect(known.ok).toBe(true);
		expect((known.data as { success: boolean }).success).toBe(false);
		// unknown action → ok:false (but does NOT throw)
		expect((await inb({ domain: "x", action: "y" })).ok).toBe(false);
		// no-arg call is safe too
		expect((await inb()).ok).toBe(false);
	});
});
