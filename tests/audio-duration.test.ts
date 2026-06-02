/**
 * Unit tests for the audio duration probe (src/audio-duration.ts).
 *
 * This exercises the real bundled ffmpeg binary (the module's whole purpose is
 * parsing ffmpeg's stderr), generating small PCM WAV files as input.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";
import { fileURLToPath } from "node:url";
import { getAudioDurationSec, MIN_AUDIO_DURATION_SEC } from "../src/audio-duration.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "fixtures", "duration");

/** Write a mono 16-bit PCM WAV of silence with the given duration (seconds). */
function writeSilentWav(filePath: string, durationSec: number, sampleRate = 8000): void {
    const numSamples = Math.floor(sampleRate * durationSec);
    const dataSize = numSamples * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(dataSize, 40);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buf);
}

async function runTests(): Promise<void> {
    fs.mkdirSync(TEST_DIR, { recursive: true });

    let passed = 0;
    let failed = 0;

    async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (error) {
            console.log(`✗ ${name}`);
            console.log(`    Error: ${error instanceof Error ? error.message : error}`);
            failed++;
        }
    }

    console.log("getAudioDurationSec");

    await test("should report the duration of a short clip", async () => {
        const f = path.join(TEST_DIR, "two-seconds.wav");
        writeSilentWav(f, 2);
        const dur = await getAudioDurationSec(f);
        assert.ok(Math.abs(dur - 2) < 0.5, `expected ~2s, got ${dur}`);
    });

    await test("should report the duration of a longer clip", async () => {
        const f = path.join(TEST_DIR, "thirtyone.wav");
        writeSilentWav(f, 31);
        const dur = await getAudioDurationSec(f);
        assert.ok(dur >= 30.5 && dur < 32, `expected ~31s, got ${dur}`);
    });

    await test("should throw on a file ffmpeg cannot read", async () => {
        const f = path.join(TEST_DIR, "garbage.wav");
        fs.writeFileSync(f, "this is not audio at all");
        await assert.rejects(getAudioDurationSec(f), /could not determine audio duration/);
    });

    console.log("\nMIN_AUDIO_DURATION_SEC");

    await test("should be the audio2chart minimum of 30 seconds", () => {
        assert.strictEqual(MIN_AUDIO_DURATION_SEC, 30);
    });

    // Cleanup
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        console.log("Warning: could not fully clean up duration test fixtures.");
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
    console.error("Test runner error:", error);
    process.exit(1);
});
