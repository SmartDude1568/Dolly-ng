import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";
import { fileURLToPath } from "node:url";
import { DummySplitter } from "../src/split/dummy";
import { LalalSplitter } from "../src/split/lalal";
import type { LalalStem } from "../src/split/lalal";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "fixtures", "split");

// ── Fetch mock infrastructure ───────────────────────────────────────────────

const originalFetch = globalThis.fetch;

interface MockRoute {
    url: string;
    response: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
}

function mockFetch(routes: MockRoute[]): void {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        // Destroy any readable stream body so file handles are released.
        const body = init?.body;
        if (body && typeof (body as NodeJS.ReadableStream).destroy === "function") {
            const stream = body as NodeJS.ReadableStream;
            stream.on("error", () => {}); // swallow errors from early destroy
            (stream as fs.ReadStream).destroy();
        }

        for (const route of routes) {
            if (url.includes(route.url)) {
                const { status, body: responseBody } = await route.response();
                return new Response(
                    typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody),
                    { status },
                );
            }
        }

        throw new Error(`Unmocked fetch: ${url}`);
    }) as typeof fetch;
}

function restoreFetch(): void {
    globalThis.fetch = originalFetch;
}

// ── Test runner ─────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
    console.log("Setting up split test fixtures...\n");
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Create a tiny dummy audio file for LALAL tests that read from disk.
    const DUMMY_AUDIO = path.join(TEST_DIR, "input.wav");
    fs.writeFileSync(DUMMY_AUDIO, "fake-wav-content");

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

    // ── DummySplitter tests ─────────────────────────────────────────────

    console.log("DummySplitter");

    await test("should expose its name", async () => {
        const splitter = new DummySplitter(TEST_DIR);
        assert.strictEqual(splitter.name, "dummy");
    });

    await test("should list all supported stems", async () => {
        const splitter = new DummySplitter(TEST_DIR);
        const stems = splitter.supportedStems();
        assert.deepStrictEqual(stems, [
            "vocals", "instrumental", "drums", "bass", "guitar", "piano", "other",
        ]);
    });

    await test("should return correct paths for requested stems", async () => {
        const splitter = new DummySplitter(TEST_DIR);
        const result = await splitter.split("/music/song.wav", ["vocals", "drums"]);

        assert.strictEqual(result.sourcePath, "/music/song.wav");
        assert.strictEqual(result.stems.length, 2);
        assert.strictEqual(result.stems[0]!.stem, "vocals");
        assert.strictEqual(result.stems[0]!.path, path.join(TEST_DIR, "song_vocals.wav"));
        assert.strictEqual(result.stems[1]!.stem, "drums");
        assert.strictEqual(result.stems[1]!.path, path.join(TEST_DIR, "song_drums.wav"));
    });

    await test("should handle a single stem", async () => {
        const splitter = new DummySplitter(TEST_DIR);
        const result = await splitter.split("/music/track.mp3", ["bass"]);

        assert.strictEqual(result.stems.length, 1);
        assert.strictEqual(result.stems[0]!.stem, "bass");
        assert.strictEqual(result.stems[0]!.path, path.join(TEST_DIR, "track_bass.wav"));
    });

    await test("should strip the original extension from output filenames", async () => {
        const splitter = new DummySplitter(TEST_DIR);
        const result = await splitter.split("/music/demo.flac", ["piano"]);

        assert.strictEqual(result.stems[0]!.path, path.join(TEST_DIR, "demo_piano.wav"));
    });

    await test("should throw on unsupported stems", async () => {
        const splitter = new DummySplitter(TEST_DIR);
        let threw = false;
        try {
            // @ts-expect-error intentionally passing an invalid stem
            await splitter.split("/music/song.wav", ["vocals", "synth"]);
        } catch (error) {
            threw = true;
            assert.ok(
                error instanceof Error && error.message.includes("synth"),
                "Error should mention the unsupported stem",
            );
        }
        assert.ok(threw, "Should throw for unsupported stems");
    });

    // ── LalalSplitter tests ─────────────────────────────────────────────

    console.log("\nLalalSplitter");

    await test("should expose its name", async () => {
        const splitter = new LalalSplitter({ apiKey: "test", outputDir: TEST_DIR });
        assert.strictEqual(splitter.name, "lalal");
    });

    await test("should list all supported stems", async () => {
        const splitter = new LalalSplitter({ apiKey: "test", outputDir: TEST_DIR });
        const stems = splitter.supportedStems();
        assert.deepStrictEqual(stems, [
            "vocals", "voice", "drum", "bass", "piano",
            "electric_guitar", "acoustic_guitar", "synthesizer", "strings", "wind",
        ]);
    });

    await test("should throw on unsupported stems", async () => {
        const splitter = new LalalSplitter({ apiKey: "test", outputDir: TEST_DIR });
        let threw = false;
        try {
            await splitter.split(DUMMY_AUDIO, ["bogus" as LalalStem]);
        } catch (error) {
            threw = true;
            assert.ok(
                error instanceof Error && error.message.includes("bogus"),
                "Error should mention the unsupported stem",
            );
        }
        assert.ok(threw, "Should throw for unsupported stems");
    });

    await test("should upload, split, poll, and download for a single stem", async () => {
        const fileId = "file-abc-123";
        const stemContent = "fake-audio-bytes";

        mockFetch([
            {
                url: "/api/upload/",
                response: () => ({ status: 200, body: { status: "success", id: fileId } }),
            },
            {
                url: "/api/split/",
                response: () => ({ status: 200, body: { status: "success" } }),
            },
            {
                url: "/api/check/",
                response: () => ({
                    status: 200,
                    body: {
                        status: "success",
                        result: {
                            [fileId]: {
                                status: "success",
                                split: {
                                    stem: "vocals",
                                    stem_track: "https://cdn.lalal.ai/vocals.wav",
                                    stem_track_size: stemContent.length,
                                    back_track: "https://cdn.lalal.ai/backing.wav",
                                    back_track_size: 0,
                                },
                            },
                        },
                    },
                }),
            },
            {
                url: "https://cdn.lalal.ai/vocals.wav",
                response: () => ({ status: 200, body: stemContent }),
            },
        ]);

        try {
            const splitter = new LalalSplitter({ apiKey: "key-123", outputDir: TEST_DIR });
            const result = await splitter.split(DUMMY_AUDIO, ["vocals"]);

            assert.strictEqual(result.sourcePath, DUMMY_AUDIO);
            assert.strictEqual(result.stems.length, 1);
            assert.strictEqual(result.stems[0]!.stem, "vocals");
            assert.strictEqual(result.stems[0]!.path, path.join(TEST_DIR, "input_vocals.wav"));

            // Verify the file was written
            assert.ok(fs.existsSync(result.stems[0]!.path), "Stem file should exist on disk");
        } finally {
            restoreFetch();
        }
    });

    await test("should process multiple stems sequentially", async () => {
        const fileId = "file-multi-456";
        const stems: LalalStem[] = ["drum", "bass"];
        let splitCallCount = 0;
        let checkCallCount = 0;

        mockFetch([
            {
                url: "/api/upload/",
                response: () => ({ status: 200, body: { status: "success", id: fileId } }),
            },
            {
                url: "/api/split/",
                response: () => {
                    splitCallCount++;
                    return { status: 200, body: { status: "success" } };
                },
            },
            {
                url: "/api/check/",
                response: () => {
                    checkCallCount++;
                    const currentStem = checkCallCount <= 1 ? "drum" : "bass";
                    return {
                        status: 200,
                        body: {
                            status: "success",
                            result: {
                                [fileId]: {
                                    status: "success",
                                    split: {
                                        stem: currentStem,
                                        stem_track: `https://cdn.lalal.ai/${currentStem}.wav`,
                                        stem_track_size: 100,
                                        back_track: `https://cdn.lalal.ai/${currentStem}_back.wav`,
                                        back_track_size: 100,
                                    },
                                },
                            },
                        },
                    };
                },
            },
            {
                url: "https://cdn.lalal.ai/",
                response: () => ({ status: 200, body: "audio-data" }),
            },
        ]);

        try {
            const splitter = new LalalSplitter({ apiKey: "key-456", outputDir: TEST_DIR });
            const result = await splitter.split(DUMMY_AUDIO, stems);

            assert.strictEqual(result.stems.length, 2);
            assert.strictEqual(result.stems[0]!.stem, "drum");
            assert.strictEqual(result.stems[0]!.path, path.join(TEST_DIR, "input_drum.wav"));
            assert.strictEqual(result.stems[1]!.stem, "bass");
            assert.strictEqual(result.stems[1]!.path, path.join(TEST_DIR, "input_bass.wav"));

            // Should have called split once per stem
            assert.strictEqual(splitCallCount, 2, "Split endpoint should be called once per stem");
        } finally {
            restoreFetch();
        }
    });

    await test("should poll until processing is complete", async () => {
        const fileId = "file-poll-789";
        let checkCallCount = 0;

        mockFetch([
            {
                url: "/api/upload/",
                response: () => ({ status: 200, body: { status: "success", id: fileId } }),
            },
            {
                url: "/api/split/",
                response: () => ({ status: 200, body: { status: "success" } }),
            },
            {
                url: "/api/check/",
                response: () => {
                    checkCallCount++;
                    // First two calls: still in progress. Third call: done.
                    if (checkCallCount < 3) {
                        return {
                            status: 200,
                            body: {
                                status: "success",
                                result: {
                                    [fileId]: {
                                        status: "success",
                                        task: { state: "progress", progress: checkCallCount * 33 },
                                    },
                                },
                            },
                        };
                    }
                    return {
                        status: 200,
                        body: {
                            status: "success",
                            result: {
                                [fileId]: {
                                    status: "success",
                                    split: {
                                        stem: "piano",
                                        stem_track: "https://cdn.lalal.ai/piano.wav",
                                        stem_track_size: 50,
                                        back_track: "https://cdn.lalal.ai/piano_back.wav",
                                        back_track_size: 50,
                                    },
                                },
                            },
                        },
                    };
                },
            },
            {
                url: "https://cdn.lalal.ai/piano.wav",
                response: () => ({ status: 200, body: "piano-audio" }),
            },
        ]);

        try {
            const splitter = new LalalSplitter({
                apiKey: "key-789",
                outputDir: TEST_DIR,
                pollIntervalMs: 10, // fast polling for tests
            });
            const result = await splitter.split(DUMMY_AUDIO, ["piano"]);

            assert.strictEqual(result.stems.length, 1);
            assert.strictEqual(result.stems[0]!.stem, "piano");
            assert.strictEqual(checkCallCount, 3, "Should have polled 3 times");
        } finally {
            restoreFetch();
        }
    });

    await test("should throw when upload fails", async () => {
        mockFetch([
            {
                url: "/api/upload/",
                response: () => ({ status: 200, body: { status: "error", error: "File too large" } }),
            },
        ]);

        try {
            const splitter = new LalalSplitter({ apiKey: "key", outputDir: TEST_DIR });
            let threw = false;
            try {
                await splitter.split(DUMMY_AUDIO, ["vocals"]);
            } catch (error) {
                threw = true;
                assert.ok(
                    error instanceof Error && error.message.includes("File too large"),
                    "Error should contain the API error message",
                );
            }
            assert.ok(threw, "Should throw on upload error");
        } finally {
            restoreFetch();
        }
    });

    await test("should throw when processing fails", async () => {
        const fileId = "file-err";

        mockFetch([
            {
                url: "/api/upload/",
                response: () => ({ status: 200, body: { status: "success", id: fileId } }),
            },
            {
                url: "/api/split/",
                response: () => ({ status: 200, body: { status: "success" } }),
            },
            {
                url: "/api/check/",
                response: () => ({
                    status: 200,
                    body: {
                        status: "success",
                        result: {
                            [fileId]: {
                                status: "success",
                                task: { state: "error", error: "Corrupt audio" },
                            },
                        },
                    },
                }),
            },
        ]);

        try {
            const splitter = new LalalSplitter({
                apiKey: "key",
                outputDir: TEST_DIR,
                pollIntervalMs: 10,
            });
            let threw = false;
            try {
                await splitter.split(DUMMY_AUDIO, ["vocals"]);
            } catch (error) {
                threw = true;
                assert.ok(
                    error instanceof Error && error.message.includes("Corrupt audio"),
                    "Error should contain the processing error message",
                );
            }
            assert.ok(threw, "Should throw on processing error");
        } finally {
            restoreFetch();
        }
    });

    await test("should throw when processing is cancelled", async () => {
        const fileId = "file-cancel";

        mockFetch([
            {
                url: "/api/upload/",
                response: () => ({ status: 200, body: { status: "success", id: fileId } }),
            },
            {
                url: "/api/split/",
                response: () => ({ status: 200, body: { status: "success" } }),
            },
            {
                url: "/api/check/",
                response: () => ({
                    status: 200,
                    body: {
                        status: "success",
                        result: {
                            [fileId]: {
                                status: "success",
                                task: { state: "cancelled" },
                            },
                        },
                    },
                }),
            },
        ]);

        try {
            const splitter = new LalalSplitter({
                apiKey: "key",
                outputDir: TEST_DIR,
                pollIntervalMs: 10,
            });
            let threw = false;
            try {
                await splitter.split(DUMMY_AUDIO, ["vocals"]);
            } catch (error) {
                threw = true;
                assert.ok(
                    error instanceof Error && error.message.includes("cancelled"),
                    "Error should mention cancellation",
                );
            }
            assert.ok(threw, "Should throw on cancelled processing");
        } finally {
            restoreFetch();
        }
    });

    await test("should throw on HTTP error from upload", async () => {
        mockFetch([
            {
                url: "/api/upload/",
                response: () => ({ status: 500, body: "Internal Server Error" }),
            },
        ]);

        try {
            const splitter = new LalalSplitter({ apiKey: "key", outputDir: TEST_DIR });
            let threw = false;
            try {
                await splitter.split(DUMMY_AUDIO, ["vocals"]);
            } catch (error) {
                threw = true;
                assert.ok(
                    error instanceof Error && error.message.includes("500"),
                    "Error should contain the HTTP status",
                );
            }
            assert.ok(threw, "Should throw on HTTP error");
        } finally {
            restoreFetch();
        }
    });

    // Cleanup
    console.log("\nCleaning up split test fixtures...");
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        // Windows may hold file locks briefly; non-critical if cleanup fails.
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
