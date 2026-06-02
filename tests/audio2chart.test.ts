/**
 * Unit tests for the one-shot Modal audio2chart client (src/chart/audio2chart.ts).
 *
 * The client is exercised with an injected `fetchFn` so no network call is made.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";
import { fileURLToPath } from "node:url";
import { Audio2ChartModal } from "../src/chart/audio2chart.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "fixtures", "audio2chart");

const SAMPLE_CHART = `[Song]\n{\n  Name = "x"\n}\n[ExpertSingle]\n{\n  0 = N 0 0\n}`;

async function runTests(): Promise<void> {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const AUDIO = path.join(TEST_DIR, "stem.wav");
    fs.writeFileSync(AUDIO, "fake-audio-bytes");

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

    console.log("Audio2ChartModal");

    await test("should require an endpointUrl", () => {
        assert.throws(() => new Audio2ChartModal({ endpointUrl: "" }), /endpointUrl/);
    });

    await test("should POST the audio + metadata and return chart text", async () => {
        let captured: { url: string; method?: string; headers?: Record<string, string>; form?: FormData } | null = null;
        const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
            captured = {
                url: String(url),
                method: init?.method,
                headers: init?.headers as Record<string, string>,
                form: init?.body as FormData,
            };
            return new Response(SAMPLE_CHART, { status: 200 });
        }) as typeof fetch;

        const client = new Audio2ChartModal({
            endpointUrl: "https://example.modal.run",
            token: "secret-token",
            artist: "Dolly",
            charter: "Dolly",
            bpm: 120,
            fetchFn,
        });

        const text = await client.generateText(AUDIO, { name: "My Song" });
        assert.ok(text.includes("[Song]"));
        assert.ok(captured, "fetch should have been called");
        const c = captured!;
        assert.strictEqual(c.method, "POST");
        assert.strictEqual(c.url, "https://example.modal.run");
        assert.strictEqual(c.headers!["x-audio2chart-token"], "secret-token");
        // FormData carries the audio blob + forwarded metadata fields.
        const form = c.form;
        assert.ok(form instanceof FormData, "body should be FormData");
        assert.ok(form.get("audio"), "audio field should be present");
        assert.strictEqual(form.get("name"), "My Song");
        assert.strictEqual(form.get("artist"), "Dolly");
        assert.strictEqual(form.get("bpm"), "120");
    });

    await test("should NOT send a token header when none is configured", async () => {
        let headers: Record<string, string> = {};
        const fetchFn = (async (_url: unknown, init?: RequestInit) => {
            headers = (init?.headers as Record<string, string>) ?? {};
            return new Response(SAMPLE_CHART, { status: 200 });
        }) as typeof fetch;
        const client = new Audio2ChartModal({ endpointUrl: "https://x", fetchFn });
        await client.generateText(AUDIO);
        assert.ok(!("x-audio2chart-token" in headers), "should omit token header");
    });

    await test("should throw with status on a non-OK response", async () => {
        const fetchFn = (async () => new Response("upstream boom", { status: 503, statusText: "Service Unavailable" })) as typeof fetch;
        const client = new Audio2ChartModal({ endpointUrl: "https://x", fetchFn });
        await assert.rejects(client.generateText(AUDIO), /503/);
    });

    await test("should throw when the payload has no [Song] section", async () => {
        const fetchFn = (async () => new Response("not a chart", { status: 200 })) as typeof fetch;
        const client = new Audio2ChartModal({ endpointUrl: "https://x", fetchFn });
        await assert.rejects(client.generateText(AUDIO), /\[Song\]/);
    });

    await test("should throw when the audio file is missing", async () => {
        const fetchFn = (async () => new Response(SAMPLE_CHART, { status: 200 })) as typeof fetch;
        const client = new Audio2ChartModal({ endpointUrl: "https://x", fetchFn });
        await assert.rejects(client.generateText("/no/such/file.wav"), /not found/i);
    });

    await test("should time out (abort) a slow request", async () => {
        // A fetch that never resolves on its own but rejects when aborted.
        const fetchFn = ((_url: unknown, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                const signal = init?.signal;
                signal?.addEventListener("abort", () =>
                    reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
                );
            })) as typeof fetch;
        const client = new Audio2ChartModal({ endpointUrl: "https://x", fetchFn, timeoutMs: 50 });
        await assert.rejects(client.generateText(AUDIO), /timed out/);
    });

    await test("generate() should write the chart to disk", async () => {
        const fetchFn = (async () => new Response(SAMPLE_CHART, { status: 200 })) as typeof fetch;
        const client = new Audio2ChartModal({ endpointUrl: "https://x", fetchFn });
        const outDir = path.join(TEST_DIR, "out");
        const result = await client.generate(AUDIO, outDir, { name: "Disk Song" });
        assert.ok(fs.existsSync(result.chartPath), "chart file should be written");
        assert.ok(result.chartPath.endsWith(".chart"));
        assert.strictEqual(fs.readFileSync(result.chartPath, "utf8"), SAMPLE_CHART);
    });

    // Cleanup
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        console.log("Warning: could not fully clean up audio2chart test fixtures.");
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
    console.error("Test runner error:", error);
    process.exit(1);
});
