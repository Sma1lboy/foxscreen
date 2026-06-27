/**
 * Renders the clip-based timeline as a single output video by *sequencing* the
 * top video track's clips (with trims + per-clip audio gain), instead of the
 * legacy single-source export. This is the clip-timeline counterpart to
 * {@link VideoExporter}: same WebCodecs encoder + mediabunny muxer + export
 * dialog settings, but the frame/audio source is a {@link TimelineRenderPlan}.
 *
 * Pipeline per export:
 *  - {@link buildTimelineRenderPlan} flattens the clips into ordered segments.
 *  - VIDEO: for each segment, decode the clip's `[sourceStartSec, sourceEndSec]`
 *    window (via {@link StreamingVideoDecoder}, keeping only that range), draw it
 *    "contain"-scaled onto a black compositor canvas, and encode exactly the
 *    segment's frame count so the output tiles to `totalFrames` with no drift.
 *    Gaps render black frames.
 *  - AUDIO: an OfflineAudioContext mixdown places each clip's source audio at its
 *    timeline position, scaled per-sample by the active clip's gain envelope
 *    ({@link planAudioGainAt} → volume/mute/fade), then re-encodes via WebCodecs.
 *
 * v1 limits (follow-ups): no cross-track compositing (top track wins outright,
 * no V2-over-V1), no transitions, and no per-clip openscreen effects
 * (zoom/padding/wallpaper/cursor) — those remain on the legacy single-source path.
 */
import type { TimelineClip } from "@/components/video-editor/timeline/clipModel";
import type { TrimRegion } from "@/components/video-editor/types";
import { getPlatform } from "@/utils/platformUtils";
import {
	buildTimelineRenderPlan,
	planAudioGainAt,
	type RenderSegment,
	segmentFrameCount,
	type TimelineRenderPlan,
} from "../timelineRender";
import { AudioProcessor } from "./audioEncoder";
import { VideoMuxer } from "./muxer";
import { loadFileAsArrayBuffer, StreamingVideoDecoder } from "./streamingDecoder";
import type { ExportConfig, ExportProgress, ExportResult } from "./types";

const ENCODER_FLUSH_TIMEOUT_MS = 20_000;
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_CHANNELS = 2;
const AUDIO_ENCODE_CHUNK_FRAMES = 1024;

/** Resolves a clip's source path to the URL form the decoders/loaders accept. */
export type SourceUrlResolver = (clip: TimelineClip) => string;

export interface SequenceVideoExporterConfig extends ExportConfig {
	/** The timeline to render (top video track is sequenced). */
	clips: TimelineClip[];
	/** Maps a clip to a readable source URL (e.g. `toFileUrl(clip.sourcePath)`). */
	resolveSourceUrl: SourceUrlResolver;
	onProgress?: (progress: ExportProgress) => void;
}

interface DecodedAudio {
	sampleRate: number;
	channels: Float32Array[];
	durationSec: number;
}

/** Black RGBA frame used to render gaps and pad short segments. */
function clearToBlack(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
	ctx.fillStyle = "black";
	ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

/** "contain"-fit a source frame into the output canvas, centered, on black. */
function drawContain(
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
	frame: VideoFrame,
	outWidth: number,
	outHeight: number,
) {
	clearToBlack(ctx);
	const srcW = frame.displayWidth || frame.codedWidth;
	const srcH = frame.displayHeight || frame.codedHeight;
	if (srcW <= 0 || srcH <= 0) return;
	const scale = Math.min(outWidth / srcW, outHeight / srcH);
	const drawW = srcW * scale;
	const drawH = srcH * scale;
	const dx = (outWidth - drawW) / 2;
	const dy = (outHeight - drawH) / 2;
	ctx.drawImage(frame, dx, dy, drawW, drawH);
}

export class SequenceVideoExporter {
	private config: SequenceVideoExporterConfig;
	private plan: TimelineRenderPlan;
	private encoder: VideoEncoder | null = null;
	private muxer: VideoMuxer | null = null;
	private activeDecoder: StreamingVideoDecoder | null = null;
	private cancelled = false;
	private muxingPromises: Promise<void>[] = [];
	private chunkCount = 0;
	private videoDescription: Uint8Array | undefined;
	private videoColorSpace: VideoColorSpaceInit | undefined;
	private fatalEncoderError: Error | null = null;
	/** Decoded source audio, cached by source URL (one decode per unique file). */
	private audioCache = new Map<string, DecodedAudio | null>();

	constructor(config: SequenceVideoExporterConfig) {
		this.config = config;
		this.plan = buildTimelineRenderPlan(config.clips, config.frameRate);
	}

	cancel(): void {
		this.cancelled = true;
		this.activeDecoder?.cancel();
	}

	async export(): Promise<ExportResult> {
		if (this.plan.segments.length === 0 || this.plan.totalFrames <= 0) {
			return { success: false, error: "Timeline has no clips to export" };
		}

		const warnings: string[] = [];
		const onWarning = (message: string) => warnings.push(message);

		try {
			const platform = await getPlatform();

			// Build the audio mixdown first so the muxer can be configured with/without
			// an audio track up front, and so audio failures degrade to video-only.
			const audioMix = await this.buildAudioMix(onWarning);
			const audioCodec = audioMix
				? await AudioProcessor.selectSupportedExportCodec(
						audioMix.sampleRate,
						audioMix.numberOfChannels,
					)
				: null;
			const hasAudio = Boolean(audioMix && audioCodec);

			await this.initializeEncoder();
			const muxer = new VideoMuxer(this.config, hasAudio, audioCodec?.muxerCodec);
			this.muxer = muxer;
			await muxer.initialize();

			const canvas =
				typeof OffscreenCanvas !== "undefined"
					? new OffscreenCanvas(this.config.width, this.config.height)
					: Object.assign(document.createElement("canvas"), {
							width: this.config.width,
							height: this.config.height,
						});
			const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext("2d") as
				| CanvasRenderingContext2D
				| OffscreenCanvasRenderingContext2D
				| null;
			if (!ctx) throw new Error("Failed to create 2D compositor context");

			const frameDurationUs = 1_000_000 / this.config.frameRate;
			let globalFrame = 0;

			const encodeCanvasFrame = async () => {
				const timestamp = globalFrame * frameDurationUs;
				const exportFrame = this.canvasToVideoFrame(
					canvas as HTMLCanvasElement | OffscreenCanvas,
					ctx,
					timestamp,
					frameDurationUs,
					platform,
				);
				await this.waitForEncoderCapacity();
				if (this.encoder && this.encoder.state === "configured") {
					this.encoder.encode(exportFrame, { keyFrame: globalFrame % 150 === 0 });
				}
				exportFrame.close();
				globalFrame++;
				this.reportProgress({
					currentFrame: globalFrame,
					totalFrames: this.plan.totalFrames,
					percentage: (globalFrame / this.plan.totalFrames) * 100,
					estimatedTimeRemaining: 0,
				});
			};

			for (const segment of this.plan.segments) {
				if (this.cancelled) return { success: false, error: "Export cancelled" };
				if (this.fatalEncoderError) throw this.fatalEncoderError;

				const expected = segmentFrameCount(segment);
				if (expected <= 0) continue;
				let emitted = 0;

				if (segment.clip) {
					await this.decodeSegment(
						segment,
						async (frame) => {
							if (emitted >= expected || this.cancelled) {
								frame.close();
								return;
							}
							try {
								drawContain(ctx, frame, this.config.width, this.config.height);
								await encodeCanvasFrame();
								emitted++;
							} finally {
								frame.close();
							}
						},
						onWarning,
					);
				}

				// Pad (or fully fill a gap) with the last drawn content / black so the
				// segment contributes exactly its planned frame count.
				if (emitted === 0) clearToBlack(ctx);
				while (emitted < expected && !this.cancelled) {
					await encodeCanvasFrame();
					emitted++;
				}
			}

			if (this.cancelled) return { success: false, error: "Export cancelled" };
			if (this.fatalEncoderError) throw this.fatalEncoderError;

			if (this.encoder && this.encoder.state === "configured") {
				await this.withTimeout(
					this.encoder.flush(),
					ENCODER_FLUSH_TIMEOUT_MS,
					"The video encoder stopped responding while finalizing the export.",
				);
			}
			await Promise.all(this.muxingPromises);

			this.reportProgress({
				currentFrame: this.plan.totalFrames,
				totalFrames: this.plan.totalFrames,
				percentage: 100,
				estimatedTimeRemaining: 0,
				phase: "finalizing",
			});

			if (hasAudio && audioMix && audioCodec && !this.cancelled) {
				await this.encodeAudioMix(muxer, audioMix, audioCodec);
			}

			const blob = await muxer.finalize();
			return { success: true, blob, warnings: warnings.length > 0 ? warnings : undefined };
		} catch (error) {
			if (this.cancelled) return { success: false, error: "Export cancelled" };
			const message = error instanceof Error ? error.message : String(error);
			return { success: false, error: message };
		} finally {
			this.cleanup();
		}
	}

	/** Decode one segment's source window, delivering kept frames in order. */
	private async decodeSegment(
		segment: RenderSegment,
		onFrame: (frame: VideoFrame) => Promise<void>,
		onWarning: (message: string) => void,
	): Promise<void> {
		const clip = segment.clip;
		if (!clip) return;
		const url = this.config.resolveSourceUrl(clip);

		const decoder = new StreamingVideoDecoder();
		this.activeDecoder = decoder;
		try {
			const info = await decoder.loadMetadata(url);
			// Keep only [sourceStartSec, sourceEndSec] by trimming everything else away.
			const sourceStart = Math.max(0, segment.sourceStartSec);
			const sourceEnd = Math.min(info.duration, segment.sourceEndSec);
			const trimRegions: TrimRegion[] = [];
			if (sourceStart > 0.0001) {
				trimRegions.push({ id: "head", startMs: 0, endMs: sourceStart * 1000 });
			}
			if (sourceEnd < info.duration - 0.0001) {
				trimRegions.push({ id: "tail", startMs: sourceEnd * 1000, endMs: info.duration * 1000 });
			}

			await decoder.decodeAll(
				this.config.frameRate,
				trimRegions.length > 0 ? trimRegions : undefined,
				undefined,
				async (frame) => {
					await onFrame(frame);
				},
				onWarning,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			onWarning(`Clip "${clip.name}" failed to decode (${message}); rendered black.`);
		} finally {
			try {
				decoder.destroy();
			} catch {
				/* already disposed */
			}
			if (this.activeDecoder === decoder) this.activeDecoder = null;
		}
	}

	/**
	 * Build the per-sample audio mixdown for the whole timeline. Each clip's source
	 * audio is decoded once (cached by URL), placed at its timeline position, and
	 * scaled by the active clip's gain ({@link planAudioGainAt}). Returns `null`
	 * when no clip contributes any audio.
	 */
	private async buildAudioMix(
		onWarning: (message: string) => void,
	): Promise<{ sampleRate: number; numberOfChannels: number; channels: Float32Array[] } | null> {
		if (typeof OfflineAudioContext === "undefined") return null;
		const sampleRate = AUDIO_SAMPLE_RATE;
		const numberOfChannels = AUDIO_CHANNELS;
		const totalSamples = Math.ceil(this.plan.totalDuration * sampleRate);
		if (totalSamples <= 0) return null;

		const mix: Float32Array[] = Array.from(
			{ length: numberOfChannels },
			() => new Float32Array(totalSamples),
		);
		let anyAudio = false;

		for (const segment of this.plan.segments) {
			if (this.cancelled) break;
			const clip = segment.clip;
			if (!clip) continue;
			const url = this.config.resolveSourceUrl(clip);
			const decoded = await this.getDecodedAudio(url, sampleRate, onWarning);
			if (!decoded) continue;
			anyAudio = true;

			const segStartSample = Math.floor(segment.startSec * sampleRate);
			const segEndSample = Math.min(totalSamples, Math.floor(segment.endSec * sampleRate));
			for (let i = segStartSample; i < segEndSample; i++) {
				const timelineSec = i / sampleRate;
				const gain = planAudioGainAt(this.config.clips, timelineSec);
				if (gain <= 0) continue;
				const sourceSec = segment.sourceStartSec + (timelineSec - segment.startSec);
				const srcIndex = Math.round(sourceSec * decoded.sampleRate);
				for (let ch = 0; ch < numberOfChannels; ch++) {
					const srcChannel = decoded.channels[Math.min(ch, decoded.channels.length - 1)];
					const sample = srcChannel[srcIndex];
					if (sample) mix[ch][i] += sample * gain;
				}
			}
		}

		if (!anyAudio) return null;
		return { sampleRate, numberOfChannels, channels: mix };
	}

	/** Decode (and cache) a source file's audio to planar PCM at `sampleRate`. */
	private async getDecodedAudio(
		url: string,
		sampleRate: number,
		onWarning: (message: string) => void,
	): Promise<DecodedAudio | null> {
		const cached = this.audioCache.get(url);
		if (cached !== undefined) return cached;

		let result: DecodedAudio | null = null;
		try {
			const { data } = await loadFileAsArrayBuffer(url);
			const ctx = new OfflineAudioContext(1, 1, sampleRate);
			const buffer = await ctx.decodeAudioData(data.slice(0));
			const channels: Float32Array[] = [];
			for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
				channels.push(buffer.getChannelData(ch));
			}
			if (channels.length > 0) {
				result = { sampleRate: buffer.sampleRate, channels, durationSec: buffer.duration };
			}
		} catch {
			// No decodable audio track (or unsupported); treat as silent.
			onWarning(
				`Source "${url.split("/").pop()}" has no usable audio; muxed silent for its clips.`,
			);
			result = null;
		}

		this.audioCache.set(url, result);
		return result;
	}

	/** Encode the mixed PCM buffer and append it to the muxer's audio track. */
	private async encodeAudioMix(
		muxer: VideoMuxer,
		mix: { sampleRate: number; numberOfChannels: number; channels: Float32Array[] },
		codec: { encoderCodec: string; numberOfChannels: number; sampleRate: number },
	): Promise<void> {
		const outChannels = codec.numberOfChannels || mix.numberOfChannels;
		const sampleRate = codec.sampleRate || mix.sampleRate;
		const encodeConfig: AudioEncoderConfig = {
			codec: codec.encoderCodec,
			sampleRate,
			numberOfChannels: outChannels,
			bitrate: 128_000,
		};
		const support = await AudioEncoder.isConfigSupported(encodeConfig);
		if (!support.supported) return;

		const encodedChunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = [];
		const encoder = new AudioEncoder({
			output: (chunk, meta) => encodedChunks.push({ chunk, meta }),
			error: (e) => console.error("[SequenceVideoExporter] Audio encode error:", e),
		});
		encoder.configure(encodeConfig);

		const totalSamples = mix.channels[0]?.length ?? 0;
		for (let start = 0; start < totalSamples; start += AUDIO_ENCODE_CHUNK_FRAMES) {
			if (this.cancelled) break;
			const frames = Math.min(AUDIO_ENCODE_CHUNK_FRAMES, totalSamples - start);
			// f32-planar: all of channel 0, then channel 1, ... (downmix/up-map as needed).
			const planar = new Float32Array(frames * outChannels);
			for (let ch = 0; ch < outChannels; ch++) {
				const src = mix.channels[Math.min(ch, mix.channels.length - 1)];
				for (let i = 0; i < frames; i++) planar[ch * frames + i] = src[start + i] ?? 0;
			}
			const audioData = new AudioData({
				format: "f32-planar",
				sampleRate,
				numberOfFrames: frames,
				numberOfChannels: outChannels,
				timestamp: Math.round((start / sampleRate) * 1_000_000),
				data: planar,
			});
			encoder.encode(audioData);
			audioData.close();
			while (encoder.encodeQueueSize > 20 && !this.cancelled) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
		}

		if (encoder.state === "configured") {
			await encoder.flush();
			encoder.close();
		}
		for (const { chunk, meta } of encodedChunks) {
			if (this.cancelled) break;
			await muxer.addAudioChunk(chunk, meta);
		}
	}

	private canvasToVideoFrame(
		canvas: HTMLCanvasElement | OffscreenCanvas,
		ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
		timestamp: number,
		duration: number,
		platform: string,
	): VideoFrame {
		// On Linux the GPU shared-image path can yield empty frames; force a CPU readback.
		if (platform === "linux") {
			const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
			return new VideoFrame(imageData.data.buffer, {
				format: "RGBA",
				codedWidth: canvas.width,
				codedHeight: canvas.height,
				timestamp,
				duration,
				colorSpace: {
					primaries: "bt709",
					transfer: "iec61966-2-1",
					matrix: "rgb",
					fullRange: true,
				},
			});
		}
		return new VideoFrame(canvas as CanvasImageSource, { timestamp, duration });
	}

	private async waitForEncoderCapacity(): Promise<void> {
		while (this.encoder && this.encoder.encodeQueueSize >= 120 && !this.cancelled) {
			if (this.fatalEncoderError) throw this.fatalEncoderError;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}

	private async initializeEncoder(): Promise<void> {
		this.muxingPromises = [];
		this.chunkCount = 0;
		this.fatalEncoderError = null;
		let videoDescription: Uint8Array | undefined;

		this.encoder = new VideoEncoder({
			output: (chunk, meta) => {
				if (meta?.decoderConfig?.description && !videoDescription) {
					const desc = meta.decoderConfig.description;
					if (desc instanceof ArrayBuffer || desc instanceof SharedArrayBuffer) {
						videoDescription = new Uint8Array(desc);
					} else if (ArrayBuffer.isView(desc)) {
						videoDescription = new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
					}
					this.videoDescription = videoDescription;
				}
				if (meta?.decoderConfig?.colorSpace && !this.videoColorSpace) {
					this.videoColorSpace = meta.decoderConfig.colorSpace;
				}

				const isFirstChunk = this.chunkCount === 0;
				this.chunkCount++;

				const muxingPromise = (async () => {
					try {
						if (isFirstChunk && this.videoDescription) {
							const colorSpace = this.videoColorSpace || {
								primaries: "bt709",
								transfer: "iec61966-2-1",
								matrix: "rgb",
								fullRange: true,
							};
							const metadata: EncodedVideoChunkMetadata = {
								decoderConfig: {
									codec: this.config.codec || "avc1.640033",
									codedWidth: this.config.width,
									codedHeight: this.config.height,
									description: this.videoDescription,
									colorSpace,
								},
							};
							await this.muxer!.addVideoChunk(chunk, metadata);
						} else {
							await this.muxer!.addVideoChunk(chunk, meta);
						}
					} catch (error) {
						console.error("[SequenceVideoExporter] Muxing error:", error);
					}
				})();
				this.muxingPromises.push(muxingPromise);
			},
			error: (error) => {
				this.fatalEncoderError =
					error instanceof Error ? error : new Error(`Video encoder error: ${String(error)}`);
				this.activeDecoder?.cancel();
			},
		});

		const encoderConfig: VideoEncoderConfig = {
			codec: this.config.codec || "avc1.640033",
			width: this.config.width,
			height: this.config.height,
			bitrate: this.config.bitrate,
			framerate: this.config.frameRate,
			latencyMode: "quality",
			bitrateMode: "variable",
		};
		const support = await VideoEncoder.isConfigSupported(encoderConfig);
		if (!support.supported) {
			throw new Error("Video encoding is not supported on this system.");
		}
		this.encoder.configure(encoderConfig);
	}

	private cleanup(): void {
		if (this.encoder) {
			try {
				if (this.encoder.state === "configured") this.encoder.close();
			} catch {
				/* ignore */
			}
			this.encoder = null;
		}
		if (this.activeDecoder) {
			try {
				this.activeDecoder.destroy();
			} catch {
				/* ignore */
			}
			this.activeDecoder = null;
		}
		this.muxer = null;
		this.muxingPromises = [];
		this.chunkCount = 0;
		this.videoDescription = undefined;
		this.videoColorSpace = undefined;
		this.audioCache.clear();
	}

	private reportProgress(progress: ExportProgress): void {
		this.config.onProgress?.(progress);
	}

	private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
			promise.then(
				(value) => {
					window.clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					window.clearTimeout(timer);
					reject(error);
				},
			);
		});
	}
}
