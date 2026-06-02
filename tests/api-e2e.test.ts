/**
 * End-to-end test of the Dolly HTTP API.
 *
 * Drives the REAL Express app (createApp) and the REAL conversion worker
 * (split → audio2chart → merge → enforce tempo → transcode → pack .sng) through
 * the full user journey:
 *
 *   register → login → upload song → PATCH confirmed BPM
 *   → start conversion → poll until complete → download the .sng
 *
 * It is fully hermetic — no live services or secrets:
 *   • Postgres is an in-memory pg-mem instance injected via setSqlExecutor().
 *   • LALAL.ai and the Modal audio2chart endpoint are replaced by in-process
 *     fakes via setWorkerExternals(): the splitter copies the input WAV to per-
 *     stem files and the chart client returns a canned [ExpertSingle] chart.
 *   • ffmpeg (duration probe + Opus transcode) runs for real via ffmpeg-static.
 *
 * The downloaded .sng is unpacked and its notes.chart asserted, proving the
 * whole pipeline — including the drum-lane remap and SyncTrack tempo enforcement
 * — ran end to end.
 *
 * Usage:  npx tsx tests/api-e2e.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as assert from "node:assert";
import type { AddressInfo } from "node:net";

// ── Isolate on-disk artifacts BEFORE importing server modules ───────────────
// worker.ts reads OUTPUT_DIR at module-load time, so set it first, then import
// the server modules dynamically.
const WORK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dolly-e2e-"));
process.env.OUTPUT_DIR = path.join(WORK_ROOT, "output");
// Ensure db.ts never tries to reach a real Neon instance.
delete process.env.DATABASE_URL;

// ── Minimal Postgres schema for the in-memory DB ────────────────────────────
const SCHEMA = `
CREATE TABLE users (
    user_id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE files (
    file_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    mime_type TEXT NOT NULL,
    local_path TEXT NOT NULL,
    bpm REAL,
    kind TEXT NOT NULL DEFAULT 'source',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    progress REAL NOT NULL DEFAULT 0,
    input_file_id TEXT,
    settings JSONB NOT NULL DEFAULT '{}',
    slot_id TEXT,
    output_file_id TEXT,
    error JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE TABLE conversions (
    conversion_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress',
    input_file_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE conversion_tasks (
    conversion_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    PRIMARY KEY (conversion_id, task_id)
);
`;

// ── A canned .chart the fake audio2chart client returns ─────────────────────
// Includes a guitar open note (7) so the drum-lane remap (7 → 0 kick) is
// exercised, and an extra B tempo event so enforceTempo's replacement is too.
const FAKE_CHART = `[Song]
{
  Name = "Fake"
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 90000
  768 = B 100000
}
[Events]
{
  768 = E "section Intro"
}
[ExpertSingle]
{
  768 = N 0 0
  768 = N 7 0
  960 = N 1 0
  1152 = N 2 0
  1344 = N 3 0
  1536 = N 4 0
}`;

// ── Write a mono 16-bit PCM WAV of silence (seconds long) ───────────────────
function writeSilentWav(filePath: string, durationSec: number, sampleRate = 8000): void {
    const numSamples = Math.floor(sampleRate * durationSec);
    const dataSize = numSamples * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(dataSize, 40);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buf);
}

// ── Compact .sng unpacker (magic + file index + per-file unmask) ─────────────
function unpackSng(buf: Buffer): { magic: string; files: Map<string, Buffer> } {
    const magic = buf.toString("ascii", 0, 6);
    const xorMask = buf.subarray(10, 26);
    let off = 26;
    const metaLen = Number(buf.readBigUInt64LE(off)); off += 8 + metaLen; // skip metadata
    const fileMetaLen = Number(buf.readBigUInt64LE(off)); off += 8;
    const indexEnd = off + fileMetaLen;
    const fileCount = Number(buf.readBigUInt64LE(off)); off += 8;
    const index: { name: string; len: number; abs: number }[] = [];
    for (let i = 0; i < fileCount; i++) {
        const nameLen = buf.readUInt8(off); off += 1;
        const name = buf.toString("utf8", off, off + nameLen); off += nameLen;
        const len = Number(buf.readBigUInt64LE(off)); off += 8;
        const abs = Number(buf.readBigUInt64LE(off)); off += 8;
        index.push({ name, len, abs });
    }
    off = indexEnd + 8; // skip fileDataLen
    const files = new Map<string, Buffer>();
    for (const { name, len, abs } of index) {
        const masked = buf.subarray(abs, abs + len);
        const data = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) data[i] = masked[i]! ^ (xorMask[i % 16]! ^ (i & 0xff));
        files.set(name, data);
    }
    return { magic, files };
}

async function main(): Promise<void> {
    let passed = 0;
    let failed = 0;
    async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
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

    // Read a response body exactly once (consuming it twice throws "Body is
    // unusable"). Returns the parsed JSON (or raw text if not JSON).
    async function readBody(res: Response): Promise<{ status: number; json: any; text: string }> {
        const text = await res.text();
        let json: any = null;
        try {
            json = JSON.parse(text);
        } catch { /* not JSON */ }
        return { status: res.status, json, text };
    }

    // ── Wire up the in-memory DB ─────────────────────────────────────────
    const { newDb } = await import("pg-mem");
    const mem = newDb();
    const { Client } = mem.adapters.createPg();
    const client = new Client();
    await client.connect();
    await client.query(SCHEMA);

    // Serialize queries through the single pg-mem client to avoid re-entrancy.
    let chain: Promise<unknown> = Promise.resolve();
    const sqlExecutor = (strings: TemplateStringsArray, ...values: unknown[]) => {
        let text = strings[0]!;
        for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1];
        const run = chain.then(() => client.query(text, values).then((r: { rows: Record<string, unknown>[] }) => r.rows));
        chain = run.catch(() => {});
        return run as Promise<Record<string, unknown>[]>;
    };

    const { setSqlExecutor } = await import("../src/server/db.js");
    setSqlExecutor(sqlExecutor);

    // ── Inject fake external services into the worker ────────────────────
    const { setWorkerExternals } = await import("../src/server/worker.js");
    setWorkerExternals({
        createSplitter(outputDir: string) {
            return {
                async split(input: string, stems: string[]) {
                    const base = path.basename(input, path.extname(input));
                    fs.mkdirSync(outputDir, { recursive: true });
                    return {
                        stems: stems.map((stem) => {
                            const p = path.join(outputDir, `${base}_${stem}.wav`);
                            fs.copyFileSync(input, p); // a real, transcodable WAV
                            return { stem: stem as never, path: p };
                        }),
                    };
                },
            };
        },
        createChartClient() {
            return {
                async generateText() {
                    return FAKE_CHART;
                },
            };
        },
    });

    // ── Build + start the real app ───────────────────────────────────────
    const { createApp } = await import("../src/server/app.js");
    const app = createApp({ rateLimit: false });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const email = `e2e_${Date.now()}@dolly.test`;
    const password = "password12345";
    let token = "";
    let fileId = "";
    let conversionId = "";

    try {
        await step("POST /v1/auth/register creates an account", async () => {
            const res = await fetch(`${base}/v1/auth/register`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, password, display_name: "E2E" }),
            });
            const { status, json } = await readBody(res);
            assert.strictEqual(status, 201, JSON.stringify(json));
            assert.strictEqual(json.status, "ok");
            assert.strictEqual(json.user_id, undefined);
            assert.strictEqual(json.email, undefined);
        });

        await step("POST /v1/auth/register returns a uniform response for duplicate email", async () => {
            const res = await fetch(`${base}/v1/auth/register`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, password }),
            });
            const { status, json } = await readBody(res);
            assert.strictEqual(status, 201, JSON.stringify(json));
            assert.strictEqual(json.status, "ok");
            assert.strictEqual(json.user_id, undefined);
            assert.strictEqual(json.email, undefined);
        });

        await step("POST /v1/auth/login returns a bearer token", async () => {
            const res = await fetch(`${base}/v1/auth/login`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ email, password }),
            });
            const { status, json } = await readBody(res);
            assert.strictEqual(status, 200, JSON.stringify(json));
            assert.ok(json.token, "token returned");
            token = json.token;
        });

        await step("protected routes reject a missing token", async () => {
            const res = await fetch(`${base}/v1/files`);
            assert.strictEqual(res.status, 401);
        });

        await step("POST /v1/files/upload stores the uploaded song", async () => {
            const wavPath = path.join(WORK_ROOT, "song.wav");
            writeSilentWav(wavPath, 31); // > 30s so the duration gate passes
            const form = new FormData();
            const bytes = fs.readFileSync(wavPath);
            form.append("file", new Blob([bytes], { type: "audio/wav" }), "song.wav");
            form.append("name", "My E2E Song.wav");
            const res = await fetch(`${base}/v1/files/upload`, {
                method: "POST",
                headers: { authorization: `Bearer ${token}` },
                body: form,
            });
            const { status, json } = await readBody(res);
            assert.strictEqual(status, 201, JSON.stringify(json));
            assert.ok(json.file_id, "file_id returned");
            fileId = json.file_id;
        });

        await step("PATCH /v1/files/:id confirms the BPM", async () => {
            const res = await fetch(`${base}/v1/files/${fileId}`, {
                method: "PATCH",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({ bpm: 120 }),
            });
            const { status, json } = await readBody(res);
            assert.strictEqual(status, 200, JSON.stringify(json));
            assert.strictEqual(json.bpm, 120);
        });

        await step("POST /v1/conversions rejects invalid request options before task creation", async () => {
            const cases = [
                {},
                { instruments: [] },
                { instruments: "guitar" },
                { instruments: ["guitar", "vocals"] },
                { instruments: ["guitar"], difficulty: "nightmare" },
            ];

            for (const body of cases) {
                const res = await fetch(`${base}/v1/conversions`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                    body: JSON.stringify({ input_file_id: fileId, ...body }),
                });
                const { status, json } = await readBody(res);
                assert.strictEqual(status, 422, JSON.stringify(json));
                assert.strictEqual(json.error.code, "INVALID_INPUT");
            }

            const tasksRes = await fetch(`${base}/v1/tasks`, {
                headers: { authorization: `Bearer ${token}` },
            });
            const { status, json } = await readBody(tasksRes);
            assert.strictEqual(status, 200, JSON.stringify(json));
            assert.strictEqual(json.total, 0, "invalid conversion requests should not create tasks");
        });

        await step("POST /v1/conversions normalizes aliases and starts chart generation", async () => {
            const res = await fetch(`${base}/v1/conversions`, {
                method: "POST",
                headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                body: JSON.stringify({
                    input_file_id: fileId,
                    instruments: [" Guitar ", "drum", "drums", "bass", "keyboard", "piano"],
                    difficulty: "Expert",
                }),
            });
            const { status, json } = await readBody(res);
            assert.strictEqual(status, 201, JSON.stringify(json));
            assert.ok(json.conversion_id, "conversion_id returned");
            assert.strictEqual(json.status, "in_progress");
            // One split + four unique audio2chart instruments + one upload task.
            assert.strictEqual(json.tasks.length, 6);
            conversionId = json.conversion_id;
        });

        await step("GET /v1/conversions/:id polls to completion", async () => {
            const deadline = Date.now() + 120_000;
            let status = "in_progress";
            let lastTasks = "";
            while (Date.now() < deadline) {
                const res = await fetch(`${base}/v1/conversions/${conversionId}`, {
                    headers: { authorization: `Bearer ${token}` },
                });
                const { status: code, json: body } = await readBody(res);
                assert.strictEqual(code, 200, JSON.stringify(body));
                status = body.status;
                const summary = body.tasks.map((t: { type: string; status: string }) => `${t.type}:${t.status}`).join(" ");
                if (summary !== lastTasks) {
                    console.log(`    [poll] ${status} — ${summary}`);
                    lastTasks = summary;
                }
                if (status === "completed" || status === "failed") break;
                await new Promise((r) => setTimeout(r, 1000));
            }
            assert.strictEqual(status, "completed", "conversion should complete");
        });

        await step("GET /v1/conversions/:id/download returns a valid .sng", async () => {
            const res = await fetch(`${base}/v1/conversions/${conversionId}/download`, {
                headers: { authorization: `Bearer ${token}` },
            });
            if (res.status !== 200) assert.fail(`download failed: ${res.status} ${await res.text()}`);
            const buf = Buffer.from(await res.arrayBuffer());
            assert.ok(buf.length > 0, "downloaded a non-empty file");

            const { magic, files } = unpackSng(buf);
            assert.strictEqual(magic, "SNGPKG", "downloaded file is a real .sng archive");
            assert.ok(files.has("notes.chart"), ".sng contains notes.chart");
            assert.ok(files.has("song.opus"), ".sng contains the Opus mix");

            const chart = files.get("notes.chart")!.toString("utf8");
            // The three instruments landed on their Clone Hero tracks.
            assert.ok(chart.includes("[ExpertSingle]"), "guitar → ExpertSingle");
            assert.ok(chart.includes("[ExpertDoubleBass]"), "bass → ExpertDoubleBass");
            assert.ok(chart.includes("[ExpertDrums]"), "drums → ExpertDrums");
            // Tempo was forced to the confirmed 120 BPM (milli-BPM) and the
            // model's extra B event was dropped.
            assert.ok(chart.includes("B 120000"), "SyncTrack enforced to 120 BPM");
            assert.ok(!chart.includes("B 90000") && !chart.includes("B 100000"), "model tempo events replaced");

            // Drum lanes must be legal CH drum lanes (0-4): the guitar open
            // note 7 should have been remapped to the kick (0), never left as 7.
            const drumsBody = chart.split("[ExpertDrums]")[1] ?? "";
            const drumsSection = drumsBody.split("}")[0] ?? "";
            for (const m of drumsSection.matchAll(/=\s*N\s+(\d+)/g)) {
                const lane = Number(m[1]);
                assert.ok(lane >= 0 && lane <= 4, `illegal drum lane ${lane} in [ExpertDrums]`);
            }
        });

        await step("downloaded conversion is also listed via GET /v1/conversions", async () => {
            const res = await fetch(`${base}/v1/conversions`, {
                headers: { authorization: `Bearer ${token}` },
            });
            const { status, json: body } = await readBody(res);
            assert.strictEqual(status, 200, JSON.stringify(body));
            const found = body.conversions.find((c: { conversion_id: string }) => c.conversion_id === conversionId);
            assert.ok(found, "conversion appears in the list");
            assert.strictEqual(found.status, "completed");
            assert.ok(found.download_url, "completed conversion exposes a download_url");
        });
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        setWorkerExternals(null);
        setSqlExecutor(null);
        try {
            await client.end();
        } catch { /* ignore */ }
        try {
            fs.rmSync(WORK_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch {
            console.log("Warning: could not fully clean up e2e work dir.");
        }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error("E2E runner error:", error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
});
