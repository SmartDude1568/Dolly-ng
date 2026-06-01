/**
 * BPM detection for arbitrary audio files.
 *
 * `src/analysis.ts` (AudioAnalyzer) only decodes PCM WAV, but uploads arrive as
 * MP3/FLAC/OGG/WAV. This module bridges the gap: it transcodes any input to a
 * small mono 16-bit WAV via the bundled ffmpeg-static binary and runs the
 * autocorrelation tempo detector on it.
 *
 * To keep detection fast and bounded for long songs we downsample to 16 kHz
 * mono and only analyse the first {@link ANALYSIS_WINDOW_SEC} seconds — plenty
 * for a stable tempo estimate, since pop/rock tempo is constant throughout.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

import { AudioAnalyzer } from "./analysis.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
// ffmpeg-static exports the binary path (CJS `export =`).
const FFMPEG_PATH: string = require("ffmpeg-static");

/** Sample rate of the decoded mono WAV fed to the detector. */
const ANALYSIS_SAMPLE_RATE = 16000;
/** Seconds of audio analysed (from the start) — bounds work for long songs. */
const ANALYSIS_WINDOW_SEC = 90;

export interface BpmResult {
    /** Detected tempo in beats per minute, or null if it could not be found. */
    bpm: number | null;
    /** Full duration of the source audio in seconds (from the decode probe). */
    duration: number;
}

/**
 * Detect the tempo of an audio file in any ffmpeg-readable format.
 *
 * Transcodes a bounded, downsampled mono WAV to a temp file, analyses it, then
 * cleans up. Never throws on a detection miss — returns `{ bpm: null }`; only a
 * hard ffmpeg/decoder failure propagates.
 */
export async function detectBpm(input: string): Promise<BpmResult> {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) {
        throw new Error(`Audio file not found: ${resolved}`);
    }

    const tmpWav = path.join(
        os.tmpdir(),
        `dolly-bpm-${crypto.randomUUID()}.wav`,
    );

    try {
        // -t before -i would clip the input; placing it as an output option
        // limits the decoded duration we write. PCM s16le mono @ 16 kHz.
        await execFileAsync(
            FFMPEG_PATH,
            [
                "-y",
                "-i", resolved,
                "-t", String(ANALYSIS_WINDOW_SEC),
                "-ac", "1",
                "-ar", String(ANALYSIS_SAMPLE_RATE),
                "-c:a", "pcm_s16le",
                tmpWav,
            ],
            { timeout: 2 * 60 * 1000, maxBuffer: 1024 * 1024 * 16 },
        );

        const analyzer = new AudioAnalyzer(tmpWav);
        const result = await analyzer.analyze();
        return { bpm: result.bpm, duration: result.duration };
    } finally {
        try {
            fs.unlinkSync(tmpWav);
        } catch {
            /* ignore cleanup failure */
        }
    }
}
