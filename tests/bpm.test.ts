import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";
import { fileURLToPath } from "node:url";
import { detectBpm } from "../src/bpm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "fixtures-bpm");

/** Write a mono 16-bit PCM WAV click track at a given BPM. */
function generateClickTrack(filePath: string, bpm: number, duration = 8): void {
    const sampleRate = 44100;
    const numSamples = Math.floor(sampleRate * duration);
    const dataSize = numSamples * 2;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);

    const samplesPerBeat = Math.floor((60 / bpm) * sampleRate);
    const clickSamples = Math.floor(0.02 * sampleRate);
    for (let i = 0; i < numSamples; i++) {
        let sample = 0;
        const positionInBeat = i % samplesPerBeat;
        if (positionInBeat < clickSamples) {
            sample = 0.8 * Math.sin(2 * Math.PI * 1000 * (i / sampleRate));
            sample *= 1 - positionInBeat / clickSamples;
        }
        buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
}

async function runTests(): Promise<void> {
    console.log("Setting up BPM test fixtures...\n");

    const wavPath = path.join(TEST_DIR, "click-120.wav");
    generateClickTrack(wavPath, 120);

    let passed = 0;
    let failed = 0;
    async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

    // detectBpm transcodes via ffmpeg first, so this also covers the decode path.
    await test("should detect ~120 BPM from a click track via ffmpeg decode", async () => {
        const { bpm, duration } = await detectBpm(wavPath);
        assert.ok(bpm !== null, "BPM should be detected");
        assert.ok(Math.abs(bpm! - 120) < 10, `BPM should be ~120, got ${bpm}`);
        assert.ok(duration > 7 && duration < 9, `Duration should be ~8s, got ${duration}`);
    });

    await test("should throw for a non-existent file", async () => {
        let threw = false;
        try {
            await detectBpm(path.join(TEST_DIR, "nope.wav"));
        } catch {
            threw = true;
        }
        assert.ok(threw, "Should throw for a missing file");
    });

    console.log("\nCleaning up BPM test fixtures...");
    fs.rmSync(TEST_DIR, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
    console.error("Test runner error:", error);
    process.exit(1);
});
