import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getFfmpegBinaryPath, getFfprobeBinaryPath } from "../ffmpeg/binary";
import { getRecordingsDir } from "../utils";

const execFileAsync = promisify(execFile);

/**
 * Linux system-audio capture.
 *
 * The XDG desktop portal is the only supported way to capture the
 * screen on Linux, but it is unreliable for system audio: every portal
 * backend (gnome, kde, wlr) handles the `audio: true` flag
 * differently, the portal picker often does not surface an audio toggle,
 * and some PipeWire configurations do not expose the audio stream to
 * the portal at all. The bundled `ffmpeg-static` binary also ships
 * without `pulse` / `pipewire` input support, so an
 * `ffmpeg -f pulse ...` sidecar cannot work.
 *
 * Kooha, OBS, and SimpleScreenRecorder all solve this with a
 * **long-running** audio capture: a `parec` (or equivalent) process
 * is spawned once and kept alive for the lifetime of the app. The
 * PulseAudio / PipeWire connection is opened once on the first
 * recording that wants system audio (paying the 1.5–2.5 s
 * `pipewire-pulse` attach cost in one place, not on every recording),
 * and audio is captured continuously into a circular buffer. When a
 * recording starts, we just note the current byte offset; when it
 * stops, we extract the audio segment between those two offsets out
 * of the buffer and hand it to the existing FFmpeg mux step.
 * Subsequent recordings are essentially instant because the connection
 * is already warm.
 *
 * Format: We capture **raw** s16le / 48 kHz / 2ch PCM to stdout (no
 * WAV container). Both `parec --file-format=wav` and
 * `pw-record --container=wav` route through libsndfile, which refuses
 * to write a WAV container to a non-seekable pipe
 * ("this file format does not support pipe write"). Forcing the
 * format via flags also means we know the exact sample rate /
 * channel layout / bytes-per-sample up front, so the byte-offset
 * math in `extractSegmentAsWav` does not need a runtime header
 * parser. The WAV header is synthesized in `buildWavHeader` on
 * extract using the same constants.
 *
 * Buffer: 60 s of PCM ≈ 11.5 MB. Recordings longer than 60 s have
 * the first 60 s of audio dropped (the most recent 60 s is kept).
 * Plenty for a normal screen-recording session; memory-bounded.
 */

const BUFFER_SECONDS = 60;
const BUFFER_SIZE = 48_000 * 4 * BUFFER_SECONDS; // 48 kHz × 4 B/frame × 60 s = ~11.5 MB

export type LinuxAudioSidecarStartResult = {
	success: boolean;
	backend?: string;
	error?: string;
};

export type LinuxAudioSidecarStopResult = {
	success: boolean;
	error?: string;
};

class CircularAudioBuffer {
	private readonly buffer: Buffer;
	private writeIndex = 0;
	private totalBytesWritten = 0;

	constructor() {
		this.buffer = Buffer.alloc(BUFFER_SIZE);
	}

	write(chunk: Buffer): void {
		if (chunk.length === 0) return;

		// If the incoming chunk is larger than the entire buffer, only
		// keep the last BUFFER_SIZE bytes — older data is already gone.
		if (chunk.length >= BUFFER_SIZE) {
			chunk.copy(this.buffer, 0, chunk.length - BUFFER_SIZE);
			this.writeIndex = 0;
			this.totalBytesWritten += chunk.length;
			return;
		}

		const spaceToEnd = BUFFER_SIZE - this.writeIndex;
		if (chunk.length <= spaceToEnd) {
			chunk.copy(this.buffer, this.writeIndex);
		} else {
			chunk.copy(this.buffer, this.writeIndex, 0, spaceToEnd);
			chunk.copy(this.buffer, 0, spaceToEnd);
		}
		this.writeIndex = (this.writeIndex + chunk.length) % BUFFER_SIZE;
		this.totalBytesWritten += chunk.length;
	}

	extract(startByte: number, endByte: number): Buffer {
		if (startByte >= endByte) return Buffer.alloc(0);

		const bufferStartByte = this.totalBytesWritten - BUFFER_SIZE;
		const bufferEndByte = this.totalBytesWritten;
		const clampedStart = Math.max(startByte, bufferStartByte);
		const clampedEnd = Math.min(endByte, bufferEndByte);
		if (clampedStart >= clampedEnd) return Buffer.alloc(0);

		// Translate clamped logical byte offsets (from the recording
		// start) into physical indices in the circular buffer. The
		// oldest retained byte is at writeIndex.
		const startLogical = clampedStart - bufferStartByte;
		const endLogical = clampedEnd - bufferStartByte;
		const startPhysical = (this.writeIndex + startLogical) % BUFFER_SIZE;
		const endPhysical = (this.writeIndex + endLogical) % BUFFER_SIZE;

		if (startPhysical < endPhysical) {
			return this.buffer.slice(startPhysical, endPhysical);
		}
		// Wraps around the end of the buffer.
		const first = this.buffer.slice(startPhysical);
		const second = this.buffer.slice(0, endPhysical);
		return Buffer.concat([first, second]);
	}

	getTotalBytes(): number {
		return this.totalBytesWritten;
	}
}

class LinuxAudioCapture {
	private readonly buffer = new CircularAudioBuffer();
	private process: ChildProcess | null = null;
	private recordingStartTimeMs: number | null = null;
	// Absolute byte offset in the cumulative stream at the moment of
	// `markRecordingStart`. `extractSegmentAsWav` uses this as the start
	// of the recording in the ring buffer (not `0` — the buffer's byte
	// coordinates are absolute).
	private recordingStartByte = 0;
	private latestExtractedPath: string | null = null;

	// Audio format is fixed by the `parec` / `pw-record` flags we use
	// (s16le / 48 kHz / 2ch). Knowing the format up front means the
	// byte-offset math in `extractSegmentAsWav` is correct without
	// parsing a runtime WAV header — and lets us avoid `--file-format=wav`,
	// which libsndfile refuses to write to a non-seekable pipe.
	private readonly actualSampleRate = 48_000;
	private readonly actualChannels = 2;
	private readonly actualBytesPerSample = 4; // 2 bytes/sample × 2 channels

	private totalAudioBytesSeen = 0;

	async start(): Promise<LinuxAudioSidecarStartResult> {
		if (this.process) {
			return { success: false, error: "Linux audio capture is already running" };
		}
		// Capture the instance reference so the late `onExit` handler can
		// tell whether it is still the published capture and clear the
		// module-level pointer if so.
		const thisInstance = this;

		const backend = await detectLinuxAudioBackend();
		if (!backend) {
			return {
				success: false,
				error: "Neither `parec` (pulseaudio-utils) nor `pw-record` (pipewire-bin) is on PATH; system audio capture is unavailable. Install pulseaudio-utils (Debian/Ubuntu: `sudo apt install pulseaudio-utils`, Arch: `sudo pacman -S pulseaudio`, Fedora: `sudo dnf install pulseaudio-utils`).",
			};
		}

		const monitor = (await resolveLinuxDefaultMonitor()) ?? "default.monitor";

		// Capture raw PCM (s16le / 48 kHz / 2ch) to stdout. We deliberately
		// avoid `--file-format=wav` / `--container=wav` because both
		// `parec` and `pw-record` route through libsndfile, which refuses
		// to write a WAV container to a non-seekable pipe
		// ("this file format does not support pipe write"). Forcing the
		// format via flags also means we know the exact sample rate /
		// channel layout / bytes-per-sample up front, so the byte-offset
		// math in `extractSegmentAsWav` does not need a runtime header
		// parser. The WAV header is synthesized in `buildWavHeader` on
		// extract using these same constants.
		const args =
			backend === "parec"
				? [
						`--device=${monitor}`,
						"--format=s16le",
						"--channels=2",
						"--rate=48000",
						"--latency-msec=10",
						"--process-time-msec=10",
					]
				: [
						"--raw",
						"--rate=48000",
						"--channels=2",
						"--format=s16",
						"--latency=10ms",
						"--target",
						monitor,
					];

		const proc = spawn(backend, args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		// Capture stderr from the very first byte so a failure mid-attach
		// (which the 750ms timer used to swallow) is visible in the logs.
		const stderrChunks: string[] = [];
		proc.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			stderrChunks.push(text);
			const trimmed = text.trim();
			if (trimmed.length > 0) {
				console.warn(`[linux-audio-sidecar] ${backend} stderr:`, trimmed);
			}
		});

		// Wait for the *first stdout chunk* — the WAV header that
		// `parec --file-format=wav` writes once it has actually attached
		// to the PulseAudio / PipeWire monitor — before declaring the
		// capture live. The previous 750ms timer was a false positive on
		// `pipewire-pulse` systems where the attach takes 1.5–2.5 s.
		const attachStderr = () => stderrChunks.join("").trim();
		let firstChunk: Buffer | null = null;
		const started = await new Promise<boolean>((resolve) => {
			let settled = false;
			const settle = (ok: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				proc.stdout?.removeListener("data", onStdout);
				proc.removeListener("exit", onExit);
				proc.removeListener("error", onError);
				resolve(ok);
			};
			const onStdout = (chunk: Buffer) => {
				if (firstChunk === null) {
					firstChunk = chunk;
				}
				settle(true);
			};
			const onExit = (code: number | null) => {
				const stderr = attachStderr();
				console.warn(
					`[linux-audio-sidecar] ${backend} exited before capture started (code ${code}). Stderr: ${stderr || "(none)"}`,
				);
				settle(false);
			};
			const onError = (error: Error) => {
				console.warn(`[linux-audio-sidecar] ${backend} failed to start:`, error);
				settle(false);
			};
			const timeout = setTimeout(() => {
				const stderr = attachStderr();
				console.warn(
					`[linux-audio-sidecar] ${backend} did not produce any output within 30s. Stderr: ${stderr || "(none)"}`,
				);
				settle(false);
			}, 30_000);
			proc.stdout?.once("data", onStdout);
			proc.once("exit", onExit);
			proc.once("error", onError);
		});

		if (!started) {
			try {
				proc.kill();
			} catch {
				/* ignore */
			}
			return {
				success: false,
				error: `${backend} could not start capturing from "${monitor}". ${attachStderr() || "No stderr output."}`,
			};
		}

		// Replay the first chunk (which contains the WAV header) so
		// `handleCaptureChunk` can parse it. Without this, the parser
		// would fall back to assuming a 48 kHz / 2ch / s16le format and
		// the byte-offset math would be wrong on non-48 kHz sinks.
		if (firstChunk) {
			this.handleCaptureChunk(firstChunk);
		}
		proc.stdout?.on("data", (chunk: Buffer) => {
			this.handleCaptureChunk(chunk);
		});
		proc.once("exit", (code, signal) => {
			console.log(
				`[linux-audio-sidecar] ${backend} exited (code ${code}, signal ${signal}) after ${this.totalAudioBytesSeen} audio bytes`,
			);
			this.process = null;
			// If this is still the published capture, drop the reference so
			// the next `setRecordingState(true, { systemAudioEnabled: true })`
			// can spawn a fresh process instead of seeing a dead one as
			// "already running".
			if (capture === thisInstance) {
				capture = null;
			}
		});

		this.process = proc;
		return { success: true, backend };
	}

	stop(): void {
		const proc = this.process;
		if (!proc) return;
		this.process = null;
		try {
			proc.kill("SIGINT");
		} catch {
			/* ignore */
		}
	}

	markRecordingStart(): number {
		this.recordingStartTimeMs = Date.now();
		this.recordingStartByte = this.buffer.getTotalBytes();
		this.latestExtractedPath = null;
		console.log(
			`[linux-audio-sidecar] Recording marked at ${this.recordingStartTimeMs} (byte offset ${this.recordingStartByte}, buffer has ${this.buffer.getTotalBytes()} audio bytes, ${this.actualSampleRate}Hz/${this.actualChannels}ch)`,
		);
		return this.recordingStartTimeMs;
	}

	hasRecordingMark(): boolean {
		return this.recordingStartTimeMs !== null;
	}

	getRecordingStartTimeMs(): number | null {
		return this.recordingStartTimeMs;
	}

	/**
	 * Extract audio from the recording mark to `endTimeMs`, save it
	 * as a WAV file in the recordings directory, and return the path.
	 * Returns `null` if there's nothing to extract (e.g. no mark set,
	 * or the audio data has been overwritten by the ring buffer).
	 *
	 * The byte-offset math uses the *actual* sample rate parsed from
	 * the WAV header — assuming 48 kHz was the bug that left the
	 * extracted segment empty on sinks running at other rates.
	 */
	async extractSegmentAsWav(endTimeMs: number): Promise<string | null> {
		const startMs = this.recordingStartTimeMs;
		if (startMs === null) return null;
		if (endTimeMs <= startMs) return null;

		const durationMs = endTimeMs - startMs;
		const startByte = this.recordingStartByte;
		const totalBufferBytes = this.buffer.getTotalBytes();
		const calculatedEndByte =
			startByte +
			Math.floor((durationMs / 1000) * this.actualSampleRate * this.actualBytesPerSample);
		const endByte = Math.min(totalBufferBytes, calculatedEndByte);
		const audioData = this.buffer.extract(startByte, endByte);
		if (audioData.length === 0) {
			console.warn(
				`[linux-audio-sidecar] Extracted segment is empty (duration ${durationMs}ms, computed byte range ${startByte}..${endByte}, buffer has ${this.buffer.getTotalBytes()} total bytes)`,
			);
			return null;
		}

		const recordingsDir = await getRecordingsDir();
		const outputPath = path.join(recordingsDir, `recording-${startMs}.system.wav`);

		const wavHeader = buildWavHeader(
			audioData.length,
			this.actualSampleRate,
			this.actualChannels,
		);
		await fs.writeFile(outputPath, Buffer.concat([wavHeader, audioData]));

		console.log(
			`[linux-audio-sidecar] Extracted ${audioData.length} bytes (${(audioData.length / this.actualBytesPerSample / this.actualSampleRate).toFixed(2)}s @ ${this.actualSampleRate}Hz/${this.actualChannels}ch) to ${outputPath}`,
		);

		this.latestExtractedPath = outputPath;
		this.recordingStartTimeMs = null; // consumed
		return outputPath;
	}

	getLatestExtractedPath(): string | null {
		return this.latestExtractedPath;
	}

	clearLatestExtractedPath(): void {
		this.latestExtractedPath = null;
	}

	/**
	 * Consume a chunk of stdout from the capture process. We capture
	 * raw s16le / 48 kHz / 2ch PCM (no WAV container) so the entire
	 * chunk is audio data — no header to strip.
	 */
	private handleCaptureChunk(chunk: Buffer): void {
		this.buffer.write(chunk);
		this.totalAudioBytesSeen += chunk.length;
	}
}

function buildWavHeader(
	dataLength: number,
	sampleRate: number,
	channels: number,
): Buffer {
	const bytesPerFrame = (channels * 16) / 8; // 16-bit assumed
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + dataLength, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16); // fmt chunk size for PCM
	header.writeUInt16LE(1, 20); // audio format = PCM
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE((sampleRate * bytesPerFrame) / 1, 28);
	header.writeUInt16LE(bytesPerFrame, 32);
	header.writeUInt16LE(16, 34); // bits per sample
	header.write("data", 36);
	header.writeUInt32LE(dataLength, 40);
	return header;
}

let capture: LinuxAudioCapture | null = null;

async function commandExists(command: string): Promise<boolean> {
	try {
		const locator = process.platform === "win32" ? "where" : "which";
		await execFileAsync(locator, [command], { timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}

export async function detectLinuxAudioBackend(): Promise<string | null> {
	if (process.platform !== "linux") return null;
	if (await commandExists("parec")) return "parec";
	if (await commandExists("pw-record")) return "pw-record";
	return null;
}

export async function resolveLinuxDefaultMonitor(): Promise<string | null> {
	if (process.platform !== "linux") return null;
	if (await commandExists("pactl")) {
		try {
			const { stdout } = await execFileAsync("pactl", ["get-default-sink"], {
				timeout: 1500,
			});
			const sinkName = stdout.trim();
			if (sinkName.length > 0 && !sinkName.includes("null")) {
				return `${sinkName}.monitor`;
			}
		} catch {
			// fall through
		}
	}
	return "default.monitor";
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Start the long-running system-audio capture. Call once on app
 * start (after `app.whenReady()`), not per recording. The 1.5–2.5 s
 * `pipewire-pulse` attach cost is paid here, off the recording hot
 * path.
 */
export async function startLinuxAudioSidecar(): Promise<LinuxAudioSidecarStartResult> {
	if (process.platform !== "linux") {
		return { success: true };
	}
	if (capture) {
		return { success: false, error: "Linux audio sidecar is already running" };
	}
	const newCapture = new LinuxAudioCapture();
	const result = await newCapture.start();
	// Only publish the capture on success — otherwise `isLinuxAudioSidecarRunning()`
	// would return true for a dead `parec` and the next `extractLinuxAudioSegment`
	// call would log a misleading "extraction produced no file" warning.
	if (!result.success) {
		return result;
	}
	capture = newCapture;
	return result;
}

/**
 * Stop the long-running capture. Call once on app exit. Idempotent.
 */
export function stopLinuxAudioSidecar(): LinuxAudioSidecarStopResult {
	if (process.platform !== "linux") {
		return { success: true };
	}
	if (!capture) {
		return { success: true };
	}
	capture.stop();
	capture = null;
	return { success: true };
}

export function isLinuxAudioSidecarRunning(): boolean {
	return capture !== null;
}

export function markLinuxAudioRecordingStart(): number | null {
	if (!capture) return null;
	return capture.markRecordingStart();
}

export async function extractLinuxAudioSegment(
	endTimeMs: number,
): Promise<string | null> {
	if (!capture) return null;
	return capture.extractSegmentAsWav(endTimeMs);
}

export function getLinuxAudioSidecarPath(): string | null {
	if (!capture) return null;
	return capture.getLatestExtractedPath();
}

export function clearLinuxAudioSidecarPath(): void {
	if (!capture) return;
	capture.clearLatestExtractedPath();
}

// ─── Probe + mux (unchanged from previous versions) ─────────────────────

type AudioStreamShape = { count: 0 | 1 | "many" };

export async function probeVideoAudioStreams(videoPath: string): Promise<AudioStreamShape> {
	const ffprobePath = getFfprobeBinaryPath();
	return new Promise<AudioStreamShape>((resolve) => {
		const proc = spawn(
			ffprobePath,
			[
				"-v",
				"error",
				"-select_streams",
				"a",
				"-show_entries",
				"stream=index",
				"-of",
				"csv=p=0",
				videoPath,
			],
			{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
		);
		let stdout = "";
		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8");
		});
		proc.once("error", () => resolve({ count: 0 }));
		proc.once("exit", (code) => {
			if (code !== 0) {
				resolve({ count: 0 });
				return;
			}
			const lines = stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			if (lines.length === 0) resolve({ count: 0 });
			else if (lines.length === 1) resolve({ count: 1 });
			else resolve({ count: "many" });
		});
	});
}

export type MuxStrategy = "replace" | "mix" | "skip";

export function decideMuxStrategy(shape: AudioStreamShape): MuxStrategy {
	if (shape.count === 0) return "replace";
	if (shape.count === 1) return "mix";
	return "skip";
}

function runFfmpegMux(args: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
	const ffmpegPath = getFfmpegBinaryPath();
	return new Promise((resolve) => {
		const proc = spawn(ffmpegPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const stderrChunks: string[] = [];
		proc.stderr?.on("data", (chunk: Buffer) =>
			stderrChunks.push(chunk.toString("utf-8")),
		);
		proc.once("error", (error) => resolve({ ok: false, error: String(error) }));
		proc.once("exit", (code) => {
			if (code === 0) {
				resolve({ ok: true });
				return;
			}
			resolve({
				ok: false,
				error: `FFmpeg mux exited with code ${code}: ${stderrChunks.join("").trim()}`,
			});
		});
	});
}

export async function muxLinuxAudioSidecarIntoVideo(
	videoPath: string,
	audioPath: string,
	strategy: MuxStrategy,
): Promise<{ success: boolean; error?: string }> {
	if (strategy === "skip") {
		await fs.rm(audioPath, { force: true }).catch(() => undefined);
		return { success: true };
	}

	const videoDir = path.dirname(videoPath);
	const videoBase = path.basename(videoPath, path.extname(videoPath));
	const tempOutput = path.join(videoDir, `${videoBase}.with-system.muxed.webm`);

	const args =
		strategy === "replace"
			? [
					"-y",
					"-hide_banner",
					"-nostdin",
					"-nostats",
					"-i",
					videoPath,
					"-i",
					audioPath,
					"-map",
					"0:v:0",
					"-map",
					"1:a:0",
					"-c:v",
					"copy",
					"-c:a",
					"libopus",
					"-b:a",
					"192k",
					"-shortest",
					tempOutput,
				]
			: [
					"-y",
					"-hide_banner",
					"-nostdin",
					"-nostats",
					"-i",
					videoPath,
					"-i",
					audioPath,
					"-filter_complex",
					"[0:a]aresample=48000[a0];[a0][1:a]amix=inputs=2:duration=longest:dropout_transition=0[aout]",
					"-map",
					"0:v:0",
					"-map",
					"[aout]",
					"-c:v",
					"copy",
					"-c:a",
					"libopus",
					"-b:a",
					"192k",
					"-shortest",
					tempOutput,
				];

	const result = await runFfmpegMux(args);
	if (!result.ok) {
		return { success: false, error: result.error };
	}

	try {
		await fs.rename(tempOutput, videoPath);
		await fs.rm(audioPath, { force: true }).catch(() => undefined);
		return { success: true };
	} catch (error) {
		return { success: false, error: String(error) };
	}
}
