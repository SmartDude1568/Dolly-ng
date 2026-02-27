import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";
import { fileURLToPath } from "node:url";
import { AudioAnalyzer } from "../src/analysis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "fixtures");
const TEST_WAV = path.join(TEST_DIR, "test-tone.wav");

function generateWavFile(
    filePath: string,
    options: {
        sampleRate?: number;
        duration?: number;
        frequency?: number;
        amplitude?: number;
        bitDepth?: number;
    } = {}
): void {
    const {
        sampleRate = 44100,
        duration = 1,
        frequency = 440,
        amplitude = 0.5,
        bitDepth = 16,
    } = options;

    const numSamples = Math.floor(sampleRate * duration);
    const bytesPerSample = bitDepth / 8;
    const dataSize = numSamples * bytesPerSample;

    // WAV header (44 bytes) + data
    const buffer = Buffer.alloc(44 + dataSize);

    // RIFF header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);

    // fmt chunk
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16); // chunk size
    buffer.writeUInt16LE(1, 20); // audio format (PCM)
    buffer.writeUInt16LE(1, 22); // channels (mono)
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
    buffer.writeUInt16LE(bytesPerSample, 32); // block align
    buffer.writeUInt16LE(bitDepth, 34);

    // data chunk
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);

    // Generate sine wave samples
    for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        const sample = amplitude * Math.sin(2 * Math.PI * frequency * t);

        if (bitDepth === 16) {
            const intSample = Math.round(sample * 32767);
            buffer.writeInt16LE(intSample, 44 + i * 2);
        } else if (bitDepth === 8) {
            const intSample = Math.round((sample + 1) * 127.5);
            buffer.writeUInt8(intSample, 44 + i);
        }
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
}

function generateClickTrack(
    filePath: string,
    options: {
        sampleRate?: number;
        duration?: number;
        bpm?: number;
        clickDuration?: number;
    } = {}
): void {
    const {
        sampleRate = 44100,
        duration = 4,
        bpm = 120,
        clickDuration = 0.02,
    } = options;

    const numSamples = Math.floor(sampleRate * duration);
    const bytesPerSample = 2;
    const dataSize = numSamples * bytesPerSample;

    const buffer = Buffer.alloc(44 + dataSize);

    // RIFF header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);

    // fmt chunk
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
    buffer.writeUInt16LE(bytesPerSample, 32);
    buffer.writeUInt16LE(16, 34);

    // data chunk
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);

    // Generate click track
    const samplesPerBeat = Math.floor((60 / bpm) * sampleRate);
    const clickSamples = Math.floor(clickDuration * sampleRate);

    for (let i = 0; i < numSamples; i++) {
        let sample = 0;
        const positionInBeat = i % samplesPerBeat;

        if (positionInBeat < clickSamples) {
            // Short burst of noise for the click
            sample = 0.8 * Math.sin(2 * Math.PI * 1000 * (i / sampleRate));
            // Apply envelope
            const envelope = 1 - positionInBeat / clickSamples;
            sample *= envelope;
        }

        const intSample = Math.round(sample * 32767);
        buffer.writeInt16LE(intSample, 44 + i * 2);
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
}

async function runTests(): Promise<void> {
    console.log("Setting up test fixtures...\n");

    // Generate test files
    generateWavFile(TEST_WAV, {
        sampleRate: 44100,
        duration: 1,
        frequency: 440,
        amplitude: 0.5,
    });

    const clickTrackPath = path.join(TEST_DIR, "click-track.wav");
    generateClickTrack(clickTrackPath, {
        sampleRate: 44100,
        duration: 8,
        bpm: 120,
    });

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

    // Test: Basic analysis
    await test("should analyze a WAV file successfully", async () => {
        const analyzer = new AudioAnalyzer(TEST_WAV);
        const result = await analyzer.analyze();

        assert.ok(result, "Result should exist");
        assert.strictEqual(result.sampleRate, 44100);
        assert.strictEqual(result.channels, 1);
        assert.strictEqual(result.bitDepth, 16);
        assert.ok(result.duration > 0.9 && result.duration < 1.1, "Duration should be ~1 second");
    });

    // Test: Peak level
    await test("should calculate correct peak level for sine wave", async () => {
        const analyzer = new AudioAnalyzer(TEST_WAV);
        const result = await analyzer.analyze();

        // Amplitude was 0.5, so peak should be close to 0.5
        assert.ok(
            Math.abs(result.peakLevel - 0.5) < 0.01,
            `Peak level should be ~0.5, got ${result.peakLevel}`
        );
    });

    // Test: RMS level
    await test("should calculate correct RMS level for sine wave", async () => {
        const analyzer = new AudioAnalyzer(TEST_WAV);
        const result = await analyzer.analyze();

        // RMS of sine wave = amplitude / sqrt(2) ≈ 0.5 / 1.414 ≈ 0.354
        const expectedRms = 0.5 / Math.sqrt(2);
        assert.ok(
            Math.abs(result.rmsLevel - expectedRms) < 0.02,
            `RMS level should be ~${expectedRms.toFixed(3)}, got ${result.rmsLevel.toFixed(3)}`
        );
    });

    // Test: Mean volume
    await test("should calculate mean volume", async () => {
        const analyzer = new AudioAnalyzer(TEST_WAV);
        const result = await analyzer.analyze();

        // Mean of |sin| over full period = 2/π ≈ 0.637, times amplitude 0.5 ≈ 0.318
        const expectedMean = (2 / Math.PI) * 0.5;
        assert.ok(
            Math.abs(result.meanVolume - expectedMean) < 0.02,
            `Mean volume should be ~${expectedMean.toFixed(3)}, got ${result.meanVolume.toFixed(3)}`
        );
    });

    // Test: Decibel conversion
    await test("should convert levels to decibels correctly", async () => {
        const analyzer = new AudioAnalyzer(TEST_WAV);
        const result = await analyzer.analyze();

        // Peak of 0.5 = -6.02 dB
        const expectedPeakDb = 20 * Math.log10(0.5);
        assert.ok(
            Math.abs(result.peakLevelDb - expectedPeakDb) < 0.5,
            `Peak dB should be ~${expectedPeakDb.toFixed(1)}, got ${result.peakLevelDb.toFixed(1)}`
        );
    });

    // Test: BPM detection
    await test("should detect BPM from click track", async () => {
        const analyzer = new AudioAnalyzer(clickTrackPath);
        const result = await analyzer.analyze();

        assert.ok(result.bpm !== null, "BPM should be detected");
        // Allow some tolerance in BPM detection
        assert.ok(
            Math.abs(result.bpm! - 120) < 10,
            `BPM should be ~120, got ${result.bpm}`
        );
    });

    // Test: Invalid file
    await test("should throw error for non-existent file", async () => {
        const analyzer = new AudioAnalyzer("non-existent.wav");
        let threw = false;
        try {
            await analyzer.analyze();
        } catch {
            threw = true;
        }
        assert.ok(threw, "Should throw an error for non-existent file");
    });

    // Test: Invalid WAV header
    await test("should throw error for invalid WAV file", async () => {
        const invalidPath = path.join(TEST_DIR, "invalid.wav");
        fs.writeFileSync(invalidPath, "not a wav file");

        const analyzer = new AudioAnalyzer(invalidPath);
        let threw = false;
        try {
            await analyzer.analyze();
        } catch {
            threw = true;
        }
        assert.ok(threw, "Should throw an error for invalid WAV file");
    });

    // Cleanup
    console.log("\nCleaning up test fixtures...");
    fs.rmSync(TEST_DIR, { recursive: true, force: true });

    // Summary
    console.log(`\n${passed} passed, ${failed} failed`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch((error) => {
    console.error("Test runner error:", error);
    process.exit(1);
});
