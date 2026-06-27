/**
 * Lazy, cached media previews for timeline clips — a poster thumbnail for video
 * clips and a downsampled waveform for audio clips. Both are best-effort: under
 * the headless/Tauri runtime decoding can fail, so every path resolves `null`
 * (never throws) and the timeline falls back to a solid block.
 *
 * Each generator caches by source path in a module-level Map and returns the
 * cached (or still-in-flight) promise, so the same asset is only decoded once
 * across every clip that references it.
 */

import { toMediaSrc } from "../projectPersistence";

const THUMB_W = 160;
const THUMB_H = 90;
const THUMB_TIMEOUT_MS = 4000;

const thumbnailCache = new Map<string, Promise<string | null>>();
const waveformCache = new Map<string, Promise<number[] | null>>();

/**
 * Grab a single poster frame (~the source midpoint) as a small JPEG data URL.
 * Resolves `null` on any error or after ~4s so a stuck decode never blocks the UI.
 */
export function getThumbnail(path: string): Promise<string | null> {
	const cached = thumbnailCache.get(path);
	if (cached) return cached;

	const promise = new Promise<string | null>((resolve) => {
		let settled = false;
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				video.removeAttribute("src");
				video.load();
			} catch {
				// ignore teardown failures
			}
			resolve(value);
		};

		const timer = setTimeout(() => finish(null), THUMB_TIMEOUT_MS);

		let video: HTMLVideoElement;
		try {
			video = document.createElement("video");
		} catch {
			clearTimeout(timer);
			resolve(null);
			return;
		}
		video.muted = true;
		video.crossOrigin = "anonymous";
		video.preload = "auto";
		video.playsInline = true;

		video.addEventListener("error", () => finish(null));
		video.addEventListener("loadeddata", () => {
			const target = Number.isFinite(video.duration) ? Math.min(1, video.duration / 2) : 0;
			try {
				video.currentTime = target;
			} catch {
				finish(null);
			}
		});
		video.addEventListener("seeked", () => {
			try {
				const canvas = document.createElement("canvas");
				canvas.width = THUMB_W;
				canvas.height = THUMB_H;
				const ctx = canvas.getContext("2d");
				if (!ctx) {
					finish(null);
					return;
				}
				ctx.drawImage(video, 0, 0, THUMB_W, THUMB_H);
				finish(canvas.toDataURL("image/jpeg", 0.6));
			} catch {
				finish(null);
			}
		});

		try {
			video.src = toMediaSrc(path);
			video.load();
		} catch {
			finish(null);
		}
	});

	thumbnailCache.set(path, promise);
	return promise;
}

/**
 * Decode the source's audio and downsample channel 0 to `buckets` max-abs peaks
 * normalized to [0,1]. Resolves `null` on any error (no audio, decode failure,
 * unavailable file shim) so the timeline can fall back to a solid block.
 */
export function getWaveformPeaks(path: string, buckets = 200): Promise<number[] | null> {
	const cached = waveformCache.get(path);
	if (cached) return cached;

	const promise = (async (): Promise<number[] | null> => {
		try {
			const shim = window.electronAPI;
			if (!shim?.readBinaryFile) return null;
			const result = await shim.readBinaryFile(path);
			if (!result.success || !result.data) return null;

			// The shim hands back an ArrayBuffer; tolerate a base64 string too.
			const buffer = await toArrayBuffer(result.data);
			if (!buffer || buffer.byteLength === 0) return null;

			const AudioCtx =
				window.AudioContext ??
				(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
			if (!AudioCtx) return null;
			const ctx = new AudioCtx();
			let audio: AudioBuffer;
			try {
				audio = await ctx.decodeAudioData(buffer.slice(0));
			} finally {
				try {
					await ctx.close();
				} catch {
					// ignore
				}
			}

			const channel = audio.getChannelData(0);
			if (channel.length === 0) return null;
			const n = Math.max(1, Math.min(buckets, channel.length));
			const step = channel.length / n;
			const peaks = new Array<number>(n);
			let max = 0;
			for (let i = 0; i < n; i++) {
				const start = Math.floor(i * step);
				const end = Math.min(channel.length, Math.floor((i + 1) * step));
				let peak = 0;
				for (let j = start; j < end; j++) {
					const v = Math.abs(channel[j]);
					if (v > peak) peak = v;
				}
				peaks[i] = peak;
				if (peak > max) max = peak;
			}
			if (max > 0) {
				for (let i = 0; i < n; i++) peaks[i] = peaks[i] / max;
			}
			return peaks;
		} catch {
			return null;
		}
	})();

	waveformCache.set(path, promise);
	return promise;
}

/** Normalize the binary-read result (ArrayBuffer or base64 string) to ArrayBuffer. */
async function toArrayBuffer(data: ArrayBuffer | string): Promise<ArrayBuffer | null> {
	if (typeof data !== "string") return data;
	try {
		const binary = atob(data);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes.buffer;
	} catch {
		return null;
	}
}
