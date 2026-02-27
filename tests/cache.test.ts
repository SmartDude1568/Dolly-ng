import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";
import { fileURLToPath } from "node:url";
import { DummySplitter } from "../src/split/dummy.js";
import { CachedSplitter } from "../src/cache.js";
import type { DummyStem } from "../src/split/dummy.js";
import type { StemSplitter, SplitResult } from "../src/split.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "fixtures", "cache");
const CACHE_DIR = path.join(TEST_DIR, ".cache");

/**
 * A wrapper around DummySplitter that tracks how many times split() is called
 * and which stems were requested.
 */
class SpyDummySplitter implements StemSplitter<DummyStem> {
    readonly name = "dummy";
    private inner: DummySplitter;
    splitCalls: DummyStem[][] = [];

    constructor(outputDir: string) {
        this.inner = new DummySplitter(outputDir);
    }

    supportedStems(): DummyStem[] {
        return this.inner.supportedStems();
    }

    async split(audioPath: string, stems: DummyStem[]): Promise<SplitResult<DummyStem>> {
        this.splitCalls.push([...stems]);
        const result = await this.inner.split(audioPath, stems);
        // Create actual files on disk so cache hit verification works
        for (const stemResult of result.stems) {
            fs.mkdirSync(path.dirname(stemResult.path), { recursive: true });
            fs.writeFileSync(stemResult.path, `fake-${stemResult.stem}-data`);
        }
        return result;
    }
}

async function runTests(): Promise<void> {
    console.log("Setting up cache test fixtures...\n");
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const DUMMY_AUDIO = path.join(TEST_DIR, "input.wav");
    fs.writeFileSync(DUMMY_AUDIO, "fake-wav-content");

    let passed = 0;
    let failed = 0;

    async function test(name: string, fn: () => Promise<void>): Promise<void> {
        // Clean cache before each test
        if (fs.existsSync(CACHE_DIR)) {
            fs.rmSync(CACHE_DIR, { recursive: true, force: true });
        }
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

    console.log("CachedSplitter");

    await test("should expose name with (cached) suffix", async () => {
        const inner = new SpyDummySplitter(TEST_DIR);
        const cached = new CachedSplitter({ inner, cacheDir: CACHE_DIR });
        assert.strictEqual(cached.name, "dummy (cached)");
    });

    await test("should delegate supportedStems to inner splitter", async () => {
        const inner = new SpyDummySplitter(TEST_DIR);
        const cached = new CachedSplitter({ inner, cacheDir: CACHE_DIR });
        assert.deepStrictEqual(cached.supportedStems(), inner.supportedStems());
    });

    await test("cache miss: delegates to inner splitter and records result", async () => {
        const inner = new SpyDummySplitter(TEST_DIR);
        const cached = new CachedSplitter({ inner, cacheDir: CACHE_DIR });

        const result = await cached.split(DUMMY_AUDIO, ["vocals", "drums"]);

        assert.strictEqual(inner.splitCalls.length, 1, "Should call inner split once");
        assert.deepStrictEqual(inner.splitCalls[0], ["vocals", "drums"]);
        assert.strictEqual(result.stems.length, 2);
        assert.strictEqual(result.stems[0]!.stem, "vocals");
        assert.strictEqual(result.stems[1]!.stem, "drums");

        // Verify manifest was written
        const manifestPath = path.join(CACHE_DIR, "cache-manifest.json");
        assert.ok(fs.existsSync(manifestPath), "Manifest file should exist");
    });

    await test("cache hit: returns cached result without calling inner splitter", async () => {
        const inner = new SpyDummySplitter(TEST_DIR);
        const cached = new CachedSplitter({ inner, cacheDir: CACHE_DIR });

        // First call: cache miss
        await cached.split(DUMMY_AUDIO, ["vocals", "drums"]);
        assert.strictEqual(inner.splitCalls.length, 1);

        // Second call: cache hit
        const result = await cached.split(DUMMY_AUDIO, ["vocals", "drums"]);
        assert.strictEqual(inner.splitCalls.length, 1, "Should NOT call inner split again");
        assert.strictEqual(result.stems.length, 2);
        assert.strictEqual(result.stems[0]!.stem, "vocals");
        assert.strictEqual(result.stems[1]!.stem, "drums");
    });

    await test("partial cache hit: only uncached stems are delegated", async () => {
        const inner = new SpyDummySplitter(TEST_DIR);
        const cached = new CachedSplitter({ inner, cacheDir: CACHE_DIR });

        // First call: only vocals
        await cached.split(DUMMY_AUDIO, ["vocals"]);
        assert.strictEqual(inner.splitCalls.length, 1);
        assert.deepStrictEqual(inner.splitCalls[0], ["vocals"]);

        // Second call: vocals + drums — only drums should be delegated
        const result = await cached.split(DUMMY_AUDIO, ["vocals", "drums"]);
        assert.strictEqual(inner.splitCalls.length, 2, "Should call inner split for uncached stems");
        assert.deepStrictEqual(inner.splitCalls[1], ["drums"], "Only drums should be uncached");
        assert.strictEqual(result.stems.length, 2);
        assert.strictEqual(result.stems[0]!.stem, "vocals");
        assert.strictEqual(result.stems[1]!.stem, "drums");
    });

    await test("stale cache (output file deleted): treats as cache miss", async () => {
        const inner = new SpyDummySplitter(TEST_DIR);
        const cached = new CachedSplitter({ inner, cacheDir: CACHE_DIR });

        // First call: populates cache
        const firstResult = await cached.split(DUMMY_AUDIO, ["vocals"]);
        assert.strictEqual(inner.splitCalls.length, 1);

        // Delete the output file to simulate staleness
        fs.unlinkSync(firstResult.stems[0]!.path);

        // Second call: should treat as miss since file is gone
        await cached.split(DUMMY_AUDIO, ["vocals"]);
        assert.strictEqual(inner.splitCalls.length, 2, "Should re-split when cached file is missing");
        assert.deepStrictEqual(inner.splitCalls[1], ["vocals"]);
    });

    await test("preserves stem order from original request", async () => {
        const inner = new SpyDummySplitter(TEST_DIR);
        const cached = new CachedSplitter({ inner, cacheDir: CACHE_DIR });

        // Cache drums first
        await cached.split(DUMMY_AUDIO, ["drums"]);

        // Request in reverse order: vocals (miss), drums (hit)
        const result = await cached.split(DUMMY_AUDIO, ["vocals", "drums"]);
        assert.strictEqual(result.stems[0]!.stem, "vocals", "First stem should be vocals");
        assert.strictEqual(result.stems[1]!.stem, "drums", "Second stem should be drums");
    });

    await test("different file contents produce different cache keys", async () => {
        const inner = new SpyDummySplitter(TEST_DIR);
        const cached = new CachedSplitter({ inner, cacheDir: CACHE_DIR });

        const audio2 = path.join(TEST_DIR, "input2.wav");
        fs.writeFileSync(audio2, "different-wav-content");

        await cached.split(DUMMY_AUDIO, ["vocals"]);
        assert.strictEqual(inner.splitCalls.length, 1);

        // Same stem but different file — should be a miss
        await cached.split(audio2, ["vocals"]);
        assert.strictEqual(inner.splitCalls.length, 2, "Different file should cause cache miss");
    });

    // Cleanup
    console.log("\nCleaning up cache test fixtures...");
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        console.log("Warning: could not fully clean up test fixtures.");
    }

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
