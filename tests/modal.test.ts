/**
 * Unit tests for the Modal audio2chart HTTP client (src/chart/modal.ts).
 *
 * The network is replaced by an in-process fake `fetch`, so nothing leaves the machine.
 *
 * Usage:  npx tsx tests/modal.test.ts
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModalAudio2Chart, type ProgressEvent } from "../src/chart/modal.js";

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "dolly-modal-"));
const AUDIO = path.join(WORK, "My Song.wav");
fs.writeFileSync(AUDIO, Buffer.from("not really audio"));
const OUT = path.join(WORK, "out");

const GENERATE_URL = "https://modal.test/generate";
const STATUS_URL = "https://modal.test/status";
const TOKEN = "s3cret";

interface Call {
    url: string;
    method: string;
    token: string | null;
    body: BodyInit | null | undefined;
}

type Responder = (call: Call, index: number) => Response | Promise<Response>;

/** A fake fetch that records calls and answers from `responder`. */
function fakeFetch(responder: Responder): { fetchFn: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const call: Call = {
            url: String(input),
            method: init?.method ?? "GET",
            token: headers.get("x-audio2chart-token"),
            body: init?.body,
        };
        calls.push(call);
        return responder(call, calls.length - 1);
    }) as typeof fetch;
    return { fetchFn, calls };
}

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(fetchFn: typeof fetch, extra: Partial<ConstructorParameters<typeof ModalAudio2Chart>[0]> = {}) {
    return new ModalAudio2Chart({
        generateUrl: GENERATE_URL,
        statusUrl: STATUS_URL,
        token: TOKEN,
        outputDir: OUT,
        pollIntervalMs: 1,
        fetchFn,
        ...extra,
    });
}

async function main(): Promise<void> {
    let passed = 0;
    let failed = 0;
    async function step(name: string, fn: () => Promise<void>): Promise<void> {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (error) {
            console.log(`✗ ${name}`);
            console.log(`    Error: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
            failed++;
        }
    }

    try {
        await step("generate uploads the audio with the token, polls until done and writes the chart", async () => {
            const { fetchFn, calls } = fakeFetch((call, i) => {
                if (call.method === "POST") return json({ call_id: "c1", modal_call_id: "m1" });
                return i < 3 ? json({ status: "running" }) : json({ status: "done", chart: "[Song]\n{\n}\n" });
            });
            const result = await client(fetchFn, { name: "Custom Name" }).generate(AUDIO);

            assert.strictEqual(calls[0]!.url, GENERATE_URL);
            assert.strictEqual(calls[0]!.method, "POST");
            assert.strictEqual(calls[0]!.token, TOKEN);
            const form = calls[0]!.body as FormData;
            const file = form.get("file") as File;
            assert.strictEqual(file.name, "My Song.wav");
            assert.strictEqual(await file.text(), "not really audio");

            // Two "running" polls, then "done": 1 POST + 3 GETs.
            assert.strictEqual(calls.length, 4);
            for (const c of calls.slice(1)) {
                assert.strictEqual(c.method, "GET");
                assert.strictEqual(c.token, TOKEN);
                assert.strictEqual(c.url, `${STATUS_URL}?call_id=c1&modal_call_id=m1`);
            }

            assert.strictEqual(path.basename(result.chartPath), "Custom Name.chart");
            assert.strictEqual(fs.readFileSync(result.chartPath, "utf8"), "[Song]\n{\n}\n");
            assert.strictEqual(result.sourcePath, path.resolve(AUDIO));
        });

        await step("the chart file is named after the audio when no song name is given", async () => {
            const { fetchFn } = fakeFetch((call) =>
                call.method === "POST" ? json({ call_id: "c", modal_call_id: "m" }) : json({ status: "done", chart: "x" }),
            );
            const result = await client(fetchFn).generate(AUDIO);
            assert.strictEqual(path.basename(result.chartPath), "My Song.chart");
        });

        await step("only the options that were set are forwarded, under their Modal field names", async () => {
            const { fetchFn, calls } = fakeFetch((call) =>
                call.method === "POST" ? json({ call_id: "c", modal_call_id: "m" }) : json({ status: "done", chart: "x" }),
            );
            await client(fetchFn, {
                modelName: "m-1",
                temperature: 0.5,
                topK: 7,
                bpm: 120,
                resolution: 192,
                artist: "A",
                charter: "me",
            }).generate(AUDIO);
            const opts = JSON.parse((calls[0]!.body as FormData).get("opts") as string) as Record<string, unknown>;
            assert.deepStrictEqual(opts, {
                model_name: "m-1",
                temperature: 0.5,
                top_k: 7,
                bpm: 120,
                resolution: 192,
                artist: "A",
                charter: "me",
            });

            const bare = fakeFetch((call) =>
                call.method === "POST" ? json({ call_id: "c", modal_call_id: "m" }) : json({ status: "done", chart: "x" }),
            );
            await client(bare.fetchFn).generate(AUDIO);
            assert.strictEqual((bare.calls[0]!.body as FormData).get("opts"), "{}");
        });

        await step("progress events from the status endpoint reach the callback", async () => {
            const seen: ProgressEvent[] = [];
            const { fetchFn } = fakeFetch((call, i) => {
                if (call.method === "POST") return json({ call_id: "c", modal_call_id: "m" });
                if (i === 1) return json({ status: "running", progress: { stage: "tokens", step: 1, total: 3 } });
                if (i === 2) return json({ status: "running" });
                return json({ status: "done", chart: "x", progress: { stage: "write", step: 3, total: 3 } });
            });
            await client(fetchFn, { onProgress: (e) => seen.push(e) }).generate(AUDIO);
            assert.deepStrictEqual(seen, [
                { stage: "tokens", step: 1, total: 3 },
                { stage: "write", step: 3, total: 3 },
            ]);
        });

        await step("a missing audio file fails before any request is made", async () => {
            const { fetchFn, calls } = fakeFetch(() => json({}));
            await assert.rejects(client(fetchFn).generate(path.join(WORK, "nope.wav")), /Audio file not found/);
            assert.strictEqual(calls.length, 0);
        });

        await step("a rejected upload surfaces the status and body", async () => {
            const { fetchFn } = fakeFetch(() => new Response("bad token", { status: 401, statusText: "Unauthorized" }));
            await assert.rejects(client(fetchFn).generate(AUDIO), /http_generate failed: 401 Unauthorized bad token/);
        });

        await step("an upload response without call ids is rejected", async () => {
            const { fetchFn } = fakeFetch(() => json({ call_id: "only-one" }));
            await assert.rejects(client(fetchFn).generate(AUDIO), /unexpected payload/);
        });

        await step("a failed generation reports Modal's error message", async () => {
            const { fetchFn } = fakeFetch((call) =>
                call.method === "POST"
                    ? json({ call_id: "c", modal_call_id: "m" })
                    : json({ status: "error", error: "CUDA out of memory" }),
            );
            await assert.rejects(client(fetchFn).generate(AUDIO), /generation failed: CUDA out of memory/);
        });

        await step("a failed generation without a message still fails clearly", async () => {
            const { fetchFn } = fakeFetch((call) =>
                call.method === "POST" ? json({ call_id: "c", modal_call_id: "m" }) : json({ status: "error" }),
            );
            await assert.rejects(client(fetchFn).generate(AUDIO), /generation failed: unknown error/);
        });

        await step("'done' without chart text is an error, not an empty chart", async () => {
            const { fetchFn } = fakeFetch((call) =>
                call.method === "POST" ? json({ call_id: "c", modal_call_id: "m" }) : json({ status: "done" }),
            );
            await assert.rejects(client(fetchFn).generate(AUDIO), /done but no chart text/);
        });

        await step("a non-OK status response (other than 410) aborts with its body", async () => {
            const { fetchFn } = fakeFetch((call) =>
                call.method === "POST"
                    ? json({ call_id: "c", modal_call_id: "m" })
                    : new Response("upstream down", { status: 502, statusText: "Bad Gateway" }),
            );
            await assert.rejects(client(fetchFn).generate(AUDIO), /http_status failed: 502 Bad Gateway upstream down/);
        });

        await step("a 410 status response is still parsed (the job result is read from the body)", async () => {
            const { fetchFn } = fakeFetch((call) =>
                call.method === "POST"
                    ? json({ call_id: "c", modal_call_id: "m" })
                    : json({ status: "done", chart: "from-410" }, 410),
            );
            const result = await client(fetchFn).generate(AUDIO);
            assert.strictEqual(fs.readFileSync(result.chartPath, "utf8"), "from-410");
        });

        await step("polling gives up after the timeout instead of waiting forever", async () => {
            const { fetchFn, calls } = fakeFetch((call) =>
                call.method === "POST" ? json({ call_id: "c9", modal_call_id: "m" }) : json({ status: "running" }),
            );
            await assert.rejects(
                client(fetchFn, { timeoutMs: 30, pollIntervalMs: 5 }).generate(AUDIO),
                /timed out after 30ms \(call_id=c9\)/,
            );
            assert.ok(calls.length > 2, "should have polled at least a couple of times before giving up");
        });

        await step("call ids are URL-encoded into the status query", async () => {
            const { fetchFn, calls } = fakeFetch((call) =>
                call.method === "POST"
                    ? json({ call_id: "a b&c", modal_call_id: "x/y" })
                    : json({ status: "done", chart: "x" }),
            );
            await client(fetchFn).generate(AUDIO);
            assert.strictEqual(calls[1]!.url, `${STATUS_URL}?call_id=a%20b%26c&modal_call_id=x%2Fy`);
        });
    } finally {
        fs.rmSync(WORK, { recursive: true, force: true });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error("Test runner error:", error);
    process.exit(1);
});
