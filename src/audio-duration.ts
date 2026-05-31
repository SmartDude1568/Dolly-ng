/**
 * Audio duration probe.
 *
 * Uses the bundled ffmpeg-static binary so any input format (WAV, MP3, …) can
 * be measured — `src/analysis.ts` only decodes PCM WAV. Running ffmpeg with no
 * output target makes it exit non-zero but still print the `Duration:` line to
 * stderr, which we parse.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
// ffmpeg-static exports the binary path (CJS `export =`).
const FFMPEG_PATH: string = require("ffmpeg-static");

/**
 * The audio2chart model chunks audio into 30-second windows and rejects
 * anything shorter (`ValueError: Audio must be >= 30s`). Conversions on shorter
 * input are doomed, so we reject them up front.
 */
export const MIN_AUDIO_DURATION_SEC = 30;

/** Probe an audio file's duration in seconds via ffmpeg. */
export async function getAudioDurationSec(input: string): Promise<number> {
    let stderr = "";
    try {
        const r = await execFileAsync(FFMPEG_PATH, ["-i", input], {
            timeout: 60 * 1000,
            maxBuffer: 1024 * 1024 * 8,
        });
        stderr = r.stderr;
    } catch (err) {
        // ffmpeg exits 1 when given no output target — the Duration line we
        // need is still on stderr.
        stderr = (err as { stderr?: string }).stderr ?? "";
    }

    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!m) {
        throw new Error("could not determine audio duration");
    }
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
