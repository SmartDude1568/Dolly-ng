/**
 * Route tests for /v1/files and /charts.
 *
 * Drives the REAL Express app (createApp) over HTTP with an in-memory pg-mem
 * database (see tests/helpers/harness.ts). The Modal audio2chart service that
 * /charts calls is replaced by a local http server, so nothing leaves the
 * machine. ffmpeg (BPM detection) runs for real via ffmpeg-static.
 *
 * Usage:  npx tsx tests/routes-files-charts.test.ts
 */

import { createHarness, WORK_ROOT, type Harness } from "./helpers/harness.js";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

const CHART_UPLOAD_DIR = path.join(os.tmpdir(), "dolly-chart-uploads");

// Files are stored under UPLOAD_DIR, read by files.ts at module load. Point it (and the
// chart output dir) inside the harness work root so everything is cleaned up on close().
const UPLOAD_DIR = path.join(WORK_ROOT, "uploads");
const CHARTS_OUT = path.join(WORK_ROOT, "charts-out");
process.env.UPLOAD_DIR = UPLOAD_DIR;
process.env.CHARTS_OUTPUT_DIR = CHARTS_OUT;

let passed = 0;
let failed = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (err) {
        console.log(`✗ ${name}`);
        console.log(`    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        failed++;
    }
}

// ── Shapes ──────────────────────────────────────────────────────────────────

interface ApiErr {
    error: { code: string; message: string };
}
interface FileOut {
    file_id: string;
    name: string;
    size_bytes: number;
    mime_type: string;
    bpm: number | null;
    created_at: string;
    kind?: string;
    download_url?: string;
}
interface FileList {
    files: FileOut[];
    total: number;
    page: number;
    per_page: number;
}
interface ChartStatus {
    id: string;
    status: string;
    progress: { stage: string; step: number; total: number } | null;
    chartUrl: string | null;
    error: string | null;
}

// ── Audio fixtures ──────────────────────────────────────────────────────────

/** Mono 16-bit PCM WAV click track at a given BPM. */
function clickTrack(bpm: number, durationSec: number): Buffer {
    const sampleRate = 44100;
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
    const samplesPerBeat = Math.floor((60 / bpm) * sampleRate);
    const clickSamples = Math.floor(0.02 * sampleRate);
    for (let i = 0; i < numSamples; i++) {
        const pos = i % samplesPerBeat;
        let s = 0;
        if (pos < clickSamples) {
            s = 0.8 * Math.sin(2 * Math.PI * 1000 * (i / sampleRate)) * (1 - pos / clickSamples);
        }
        buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
    }
    return buf;
}

function bytesBlob(bytes: Uint8Array, type: string): Blob {
    // Copy into a fresh Uint8Array so the Blob owns its memory.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Blob([copy], { type });
}

function uploadForm(
    bytes: Uint8Array,
    opts: { mime?: string; filename?: string; field?: string; name?: string } = {},
): FormData {
    const form = new FormData();
    if (opts.name !== undefined) form.append("name", opts.name);
    form.append(
        opts.field ?? "file",
        bytesBlob(bytes, opts.mime ?? "audio/wav"),
        opts.filename ?? "song.wav",
    );
    return form;
}

function listDir(dir: string): string[] {
    return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

/** Stream a >500 MiB multipart body so multer's fileSize limit trips. */
function postOversizeUpload(base: string, token: string): Promise<{ status: number; body: string }> {
    const url = new URL(`${base}/v1/files/upload`);
    const boundary = "----dollyoversize";
    const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.wav"\r\n` +
            `Content-Type: audio/wav\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const chunk = Buffer.alloc(1024 * 1024);
    const chunks = 500 + 2; // > 500 MiB of file payload

    return new Promise((resolve, reject) => {
        let resolved = false;
        const req = http.request(
            {
                host: url.hostname,
                port: url.port,
                path: url.pathname,
                method: "POST",
                headers: {
                    authorization: `Bearer ${token}`,
                    "content-type": `multipart/form-data; boundary=${boundary}`,
                    "transfer-encoding": "chunked",
                },
            },
            (res) => {
                let body = "";
                res.setEncoding("utf8");
                res.on("data", (d: string) => (body += d));
                res.on("end", () => {
                    resolved = true;
                    resolve({ status: res.statusCode ?? 0, body });
                });
            },
        );
        // The server may reset the socket once it has replied; the reply is what matters.
        req.on("error", (err) => {
            if (!resolved) setTimeout(() => !resolved && reject(err), 2000);
        });
        req.write(head);
        let i = 0;
        const pump = (): void => {
            while (i < chunks) {
                i++;
                if (!req.write(chunk)) {
                    req.once("drain", pump);
                    return;
                }
            }
            req.end(tail);
        };
        pump();
    });
}

// ── Fake Modal audio2chart server ───────────────────────────────────────────

interface FakeModal {
    url: string;
    calls: Array<{ token: string | undefined; fields: Record<string, string>; audioName: string; audioBytes: number }>;
    /** Next response mode. */
    mode: "ok" | "fail" | "garbage" | "hold";
    release: () => void;
    close: () => Promise<void>;
}

const FAKE_CHART = `[Song]
{
  Name = "Fake"
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
}
[Events]
{
}
[ExpertSingle]
{
  768 = N 0 0
}
`;

async function startFakeModal(): Promise<FakeModal> {
    let hold = Promise.withResolvers<void>();
    const fake: FakeModal = {
        url: "",
        calls: [],
        mode: "ok",
        release: () => hold.resolve(),
        close: async () => {},
    };
    const server = http.createServer((req, res) => {
        void (async () => {
            const token = req.headers["x-audio2chart-token"];
            const request = new Request("http://fake.local/", {
                method: "POST",
                headers: { "content-type": req.headers["content-type"] ?? "" },
                body: req as unknown as BodyInit,
                duplex: "half",
            } as RequestInit);
            const form = await request.formData();
            const fields: Record<string, string> = {};
            let audioName = "";
            let audioBytes = 0;
            for (const [k, v] of form.entries()) {
                if (typeof v === "string") fields[k] = v;
                else if (k === "audio") {
                    audioName = v.name;
                    audioBytes = v.size;
                }
            }
            fake.calls.push({
                token: Array.isArray(token) ? token[0] : token,
                fields,
                audioName,
                audioBytes,
            });
            if (fake.mode === "hold") {
                await hold.promise;
                hold = Promise.withResolvers<void>();
            }
            if (fake.mode === "fail") {
                res.writeHead(500, { "content-type": "text/plain" });
                res.end("model exploded");
            } else if (fake.mode === "garbage") {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end("<html>not a chart</html>");
            } else {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end(FAKE_CHART);
            }
        })();
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => listening.resolve());
    await listening.promise;
    fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/generate`;
    fake.close = () => {
        const closed = Promise.withResolvers<void>();
        server.closeAllConnections();
        server.close(() => closed.resolve());
        return closed.promise;
    };
    return fake;
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
    const start = Date.now();
    for (;;) {
        const v = await fn();
        if (v !== null) return v;
        if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
        await new Promise((r) => setTimeout(r, 25));
    }
}

// ── Test body ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const h: Harness = await createHarness();
    const chartUploadsAtStart = new Set(listDir(CHART_UPLOAD_DIR));
    const fake = await startFakeModal();
    const { metrics } = await import("../src/metrics.js");
    const { setSqlExecutor } = await import("../src/server/db.js");

    try {
        const A = await h.registerAndLogin();
        const B = await h.registerAndLogin();

        const upload = (token: string | undefined, form: FormData) =>
            h.request<FileOut & ApiErr>("/v1/files/upload", { method: "POST", token, form });

        async function seedFile(
            userId: string,
            fields: { id: string; name?: string; size?: number; createdAt?: string; kind?: string; bpm?: number | null; localPath?: string },
        ): Promise<void> {
            await h.sql`
                INSERT INTO files (file_id, user_id, name, size_bytes, mime_type, local_path, bpm, kind, created_at)
                VALUES (${fields.id}, ${userId}, ${fields.name ?? fields.id}, ${fields.size ?? 1}, ${"audio/wav"},
                        ${fields.localPath ?? path.join(WORK_ROOT, "nonexistent.wav")}, ${fields.bpm ?? null},
                        ${fields.kind ?? "source"}, ${fields.createdAt ?? new Date().toISOString()})
            `;
        }
        async function seedTask(userId: string, fileId: string, status: string): Promise<string> {
            const id = `task_${Math.random().toString(36).slice(2)}`;
            await h.sql`
                INSERT INTO tasks (task_id, user_id, type, status, input_file_id)
                VALUES (${id}, ${userId}, ${"split_stems"}, ${status}, ${fileId})
            `;
            return id;
        }
        async function dbFile(fileId: string): Promise<Record<string, unknown> | undefined> {
            return (await h.sql`SELECT * FROM files WHERE file_id = ${fileId}`)[0];
        }

        const wav120 = clickTrack(120, 8);
        let fileA = ""; // a real, uploaded song owned by A
        let fileAPath = "";

        // ═══════════════════════════════════════════════════════════════════
        // /v1/files
        // ═══════════════════════════════════════════════════════════════════

        await step("files: every endpoint rejects a missing or unknown bearer token with 401", async () => {
            const calls: Array<[string, string]> = [
                ["POST", "/v1/files/upload"],
                ["GET", "/v1/files"],
                ["GET", "/v1/files/file_x"],
                ["PATCH", "/v1/files/file_x"],
                ["DELETE", "/v1/files/file_x"],
                ["GET", "/v1/files/file_x/download"],
            ];
            for (const [method, p] of calls) {
                const none = await h.request<ApiErr>(p, { method });
                assert.strictEqual(none.status, 401, `${method} ${p} without token`);
                assert.strictEqual(none.json.error.code, "UNAUTHORIZED");
                const bad = await h.request<ApiErr>(p, { method, token: "not-a-real-token" });
                assert.strictEqual(bad.status, 401, `${method} ${p} with bad token`);
            }
        });

        await step("files: an expired session is rejected with 401 and purged", async () => {
            const c = await h.registerAndLogin();
            await h.sql`UPDATE sessions SET expires_at = ${new Date(Date.now() - 60_000).toISOString()} WHERE user_id = ${c.userId}`;
            const res = await h.request<ApiErr>("/v1/files", { token: c.token });
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.json.error.message, "Token has expired");
            const left = await h.sql`SELECT 1 FROM sessions WHERE user_id = ${c.userId}`;
            assert.strictEqual(left.length, 0, "expired session row is deleted");
        });

        await step("upload: stores the file on disk, detects BPM, records an owned DB row", async () => {
            const before = listDir(UPLOAD_DIR);
            const res = await upload(A.token, uploadForm(wav120));
            assert.strictEqual(res.status, 201, res.text);
            fileA = res.json.file_id;
            assert.match(fileA, /^file_[0-9a-f]{8}$/);
            assert.strictEqual(res.json.name, "song.wav", "name defaults to the original filename");
            assert.strictEqual(res.json.size_bytes, wav120.length);
            assert.strictEqual(res.json.mime_type, "audio/wav");
            assert.ok(res.json.bpm !== null && Math.abs(res.json.bpm - 120) <= 2, `bpm≈120, got ${res.json.bpm}`);
            assert.ok(!Number.isNaN(Date.parse(res.json.created_at)));
            assert.ok(!("local_path" in res.json), "internal storage path is not exposed");
            assert.ok(!("user_id" in res.json));

            const row = await dbFile(fileA);
            assert.ok(row, "row inserted");
            assert.strictEqual(row.user_id, A.userId);
            assert.strictEqual(row.kind, "source");
            fileAPath = row.local_path as string;
            assert.strictEqual(path.dirname(fileAPath), UPLOAD_DIR);
            assert.strictEqual(path.extname(fileAPath), ".wav", "extension preserved on disk");
            assert.ok(fs.readFileSync(fileAPath).equals(wav120), "bytes persisted verbatim");
            assert.strictEqual(listDir(UPLOAD_DIR).length, before.length + 1);
        });

        await step("upload: an explicit `name` field overrides the original filename", async () => {
            const res = await upload(A.token, uploadForm(clickTrack(100, 4), { name: "My Custom Title", filename: "orig.wav" }));
            assert.strictEqual(res.status, 201, res.text);
            assert.strictEqual(res.json.name, "My Custom Title");
            const row = await dbFile(res.json.file_id);
            assert.strictEqual(row?.name, "My Custom Title");
        });

        await step("upload: accepted audio MIME types and application/octet-stream", async () => {
            for (const mime of ["audio/x-wav", "audio/mpeg", "audio/mp3", "audio/flac", "audio/ogg", "application/octet-stream"]) {
                const res = await upload(A.token, uploadForm(clickTrack(90, 2), { mime, filename: "t.wav" }));
                assert.strictEqual(res.status, 201, `${mime}: ${res.text}`);
                assert.strictEqual(res.json.mime_type, mime);
            }
        });

        await step("upload: no file part → 400 BAD_REQUEST and nothing stored", async () => {
            const before = listDir(UPLOAD_DIR);
            const form = new FormData();
            form.append("name", "no file here");
            const res = await upload(A.token, form);
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.json.error.code, "BAD_REQUEST");
            assert.match(res.json.error.message, /file/);
            assert.deepStrictEqual(listDir(UPLOAD_DIR), before);
        });

        await step("upload: unsupported MIME type → 400 and nothing written to disk or DB", async () => {
            const before = listDir(UPLOAD_DIR);
            const countBefore = (await h.sql`SELECT COUNT(*)::int AS n FROM files`)[0]!.n;
            for (const mime of ["text/plain", "image/png", "video/mp4"]) {
                const res = await upload(A.token, uploadForm(Buffer.from("hello"), { mime, filename: "x.txt" }));
                assert.strictEqual(res.status, 400, mime);
                assert.strictEqual(res.json.error.code, "BAD_REQUEST");
                assert.match(res.json.error.message, new RegExp(`Unsupported MIME type: ${mime}`));
            }
            assert.deepStrictEqual(listDir(UPLOAD_DIR), before);
            assert.strictEqual((await h.sql`SELECT COUNT(*)::int AS n FROM files`)[0]!.n, countBefore);
        });

        await step("upload: file under an unexpected field name → 400 from multer", async () => {
            const before = listDir(UPLOAD_DIR);
            const res = await upload(A.token, uploadForm(wav120, { field: "audio" }));
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.json.error.code, "BAD_REQUEST");
            assert.match(res.json.error.message, /unexpected/i);
            assert.deepStrictEqual(listDir(UPLOAD_DIR), before);
        });

        await step("upload: undecodable audio still succeeds with bpm=null and records a bpm error metric", async () => {
            const errsBefore = metrics.snapshot().errors.by_module.find((m) => m.module === "bpm")?.count ?? 0;
            const res = await upload(
                A.token,
                uploadForm(Buffer.from("this is definitely not audio"), { mime: "application/octet-stream", filename: "junk.bin" }),
            );
            assert.strictEqual(res.status, 201, res.text);
            assert.strictEqual(res.json.bpm, null);
            const row = await dbFile(res.json.file_id);
            assert.strictEqual(row?.bpm, null);
            const errsAfter = metrics.snapshot().errors.by_module.find((m) => m.module === "bpm")?.count ?? 0;
            assert.strictEqual(errsAfter, errsBefore + 1, "bpm module error recorded");
        });

        await step("upload: decodable audio records the audio-length metric", async () => {
            const before = metrics.snapshot().audio_length_sec.count;
            const res = await upload(A.token, uploadForm(clickTrack(120, 3)));
            assert.strictEqual(res.status, 201, res.text);
            const snap = metrics.snapshot().audio_length_sec;
            assert.strictEqual(snap.count, before + 1);
            assert.ok(snap.last !== null && Math.abs(snap.last - 3) < 0.1, `last length≈3s, got ${snap.last}`);
        });

        await step("upload: uploading identical bytes twice yields two independent files (no dedupe)", async () => {
            const [one, two] = [
                await upload(B.token, uploadForm(clickTrack(110, 2), { filename: "same.wav" })),
                await upload(B.token, uploadForm(clickTrack(110, 2), { filename: "same.wav" })),
            ];
            assert.strictEqual(one.status, 201);
            assert.strictEqual(two.status, 201);
            assert.notStrictEqual(one.json.file_id, two.json.file_id);
            const rowOne = await dbFile(one.json.file_id);
            const rowTwo = await dbFile(two.json.file_id);
            assert.notStrictEqual(rowOne?.local_path, rowTwo?.local_path, "separate storage paths");
            assert.ok(fs.existsSync(rowOne!.local_path as string));
            assert.ok(fs.existsSync(rowTwo!.local_path as string));
            // Deleting one must not take the other's bytes with it.
            const del = await h.request(`/v1/files/${one.json.file_id}`, { method: "DELETE", token: B.token });
            assert.strictEqual(del.status, 204);
            assert.ok(fs.existsSync(rowTwo!.local_path as string), "twin file untouched");
            assert.strictEqual((await h.request(`/v1/files/${two.json.file_id}`, { token: B.token })).status, 200);
        });

        await step("upload: more concurrent uploads than the BPM-detection limit all complete", async () => {
            const results = await Promise.all(
                Array.from({ length: 6 }, (_, i) =>
                    upload(A.token, uploadForm(clickTrack(100 + i * 5, 3), { filename: `c${i}.wav` })),
                ),
            );
            for (const r of results) assert.strictEqual(r.status, 201, r.text);
            assert.strictEqual(new Set(results.map((r) => r.json.file_id)).size, 6);
            for (const r of results) assert.ok(r.json.bpm !== null, "every queued detection ran");
        });

        await step("upload: a DB failure after storing the file removes the orphaned upload", async () => {
            const before = listDir(UPLOAD_DIR);
            const countBefore = (await h.sql`SELECT COUNT(*)::int AS n FROM files`)[0]!.n;
            const errSpy = console.error;
            console.error = () => {}; // the app logs the unhandled error; keep test output clean
            setSqlExecutor((strings, ...values) =>
                strings[0]!.includes("INSERT INTO files")
                    ? Promise.reject(new Error("simulated insert failure"))
                    : h.sql(strings, ...values),
            );
            try {
                const res = await upload(A.token, uploadForm(clickTrack(120, 2)));
                assert.strictEqual(res.status, 500);
                assert.strictEqual(res.json.error.code, "INTERNAL_ERROR");
            } finally {
                setSqlExecutor(h.sql);
                console.error = errSpy;
            }
            assert.deepStrictEqual(listDir(UPLOAD_DIR), before, "orphaned upload deleted");
            assert.strictEqual((await h.sql`SELECT COUNT(*)::int AS n FROM files`)[0]!.n, countBefore);
        });

        await step("upload: if the orphan cleanup itself fails, the request still reports the original DB error and logs a warning", async () => {
            const before = new Set(listDir(UPLOAD_DIR));
            const warnings: string[] = [];
            const origErr = console.error;
            const origWarn = console.warn;
            console.error = () => {};
            console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
            setSqlExecutor((strings, ...values) => {
                if (!strings[0]!.includes("INSERT INTO files")) return h.sql(strings, ...values);
                // Remove the stored upload just before failing so the route's unlink hits ENOENT.
                for (const f of listDir(UPLOAD_DIR)) if (!before.has(f)) fs.rmSync(path.join(UPLOAD_DIR, f));
                return Promise.reject(new Error("simulated insert failure"));
            });
            try {
                const res = await upload(A.token, uploadForm(clickTrack(120, 2)));
                assert.strictEqual(res.status, 500);
                assert.strictEqual(res.json.error.code, "INTERNAL_ERROR");
            } finally {
                setSqlExecutor(h.sql);
                console.error = origErr;
                console.warn = origWarn;
            }
            assert.ok(warnings.some((w) => /Failed to clean up uploaded file/.test(w)), `warnings: ${warnings.join(" | ")}`);
        });

        await step("upload: a file larger than 500 MB → 413 PAYLOAD_TOO_LARGE, partial file discarded", async () => {
            const before = listDir(UPLOAD_DIR);
            const countBefore = (await h.sql`SELECT COUNT(*)::int AS n FROM files`)[0]!.n;
            const res = await postOversizeUpload(h.base, A.token);
            assert.strictEqual(res.status, 413, res.body);
            const body = JSON.parse(res.body) as ApiErr;
            assert.strictEqual(body.error.code, "PAYLOAD_TOO_LARGE");
            // multer removes the partial file asynchronously after aborting the stream.
            await waitFor(async () => (JSON.stringify(listDir(UPLOAD_DIR)) === JSON.stringify(before) ? true : null), 5000);
            assert.strictEqual((await h.sql`SELECT COUNT(*)::int AS n FROM files`)[0]!.n, countBefore);
        });

        // ── GET /v1/files/:id ───────────────────────────────────────────────

        await step("get: returns the full file shape with kind and download_url", async () => {
            const res = await h.request<FileOut & ApiErr>(`/v1/files/${fileA}`, { token: A.token });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json.file_id, fileA);
            assert.strictEqual(res.json.name, "song.wav");
            assert.strictEqual(res.json.size_bytes, wav120.length);
            assert.strictEqual(res.json.kind, "source");
            assert.strictEqual(res.json.download_url, `/v1/files/${fileA}/download`);
            assert.ok(res.json.bpm !== null);
        });

        await step("get: unknown id and another user's id are indistinguishable 404s", async () => {
            const missing = await h.request<ApiErr>("/v1/files/file_deadbeef", { token: A.token });
            const foreign = await h.request<ApiErr>(`/v1/files/${fileA}`, { token: B.token });
            assert.strictEqual(missing.status, 404);
            assert.strictEqual(foreign.status, 404);
            assert.strictEqual(missing.json.error.code, "NOT_FOUND");
            assert.deepStrictEqual(foreign.json, missing.json, "no existence leak");
        });

        await step("get: an output-kind file is fetchable by id and reports kind=output", async () => {
            await seedFile(A.userId, { id: "file_out00001", kind: "output", name: "pack.sng" });
            const res = await h.request<FileOut>("/v1/files/file_out00001", { token: A.token });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json.kind, "output");
            assert.strictEqual(res.json.bpm, null);
        });

        // ── PATCH /v1/files/:id ─────────────────────────────────────────────

        const patch = (token: string | undefined, id: string, json?: unknown) =>
            h.request<FileOut & ApiErr>(`/v1/files/${id}`, { method: "PATCH", token, ...(json !== undefined ? { json } : {}) });

        await step("patch: confirms a BPM, persists it, and the file reads back with it", async () => {
            const res = await patch(A.token, fileA, { bpm: 128.5 });
            assert.strictEqual(res.status, 200, res.text);
            assert.strictEqual(res.json.bpm, 128.5);
            assert.strictEqual(res.json.file_id, fileA);
            assert.strictEqual(res.json.name, "song.wav");
            assert.strictEqual((await dbFile(fileA))?.bpm, 128.5);
            const got = await h.request<FileOut>(`/v1/files/${fileA}`, { token: A.token });
            assert.strictEqual(got.json.bpm, 128.5);
        });

        await step("patch: fractional BPM is rounded to 2 decimals; numeric strings are accepted", async () => {
            const rounded = await patch(A.token, fileA, { bpm: 120.456 });
            assert.strictEqual(rounded.status, 200);
            assert.strictEqual(rounded.json.bpm, 120.46);
            const str = await patch(A.token, fileA, { bpm: "98.5" });
            assert.strictEqual(str.status, 200);
            assert.strictEqual(str.json.bpm, 98.5);
        });

        await step("patch: BPM bounds — 400 is allowed, >400, 0, negatives, NaN and non-numeric are 400", async () => {
            assert.strictEqual((await patch(A.token, fileA, { bpm: 400 })).json.bpm, 400);
            assert.strictEqual((await patch(A.token, fileA, { bpm: 0.5 })).status, 200);
            assert.strictEqual((await patch(A.token, fileA, { bpm: 100 })).status, 200);
            for (const bad of [400.01, 401, 0, -1, -120, "abc", "", [], {}, "Infinity", 1e9]) {
                const res = await patch(A.token, fileA, { bpm: bad });
                assert.strictEqual(res.status, 400, `bpm=${JSON.stringify(bad)} should be rejected`);
                assert.strictEqual(res.json.error.code, "BAD_REQUEST");
                assert.match(res.json.error.message, /between 1 and 400|bpm/);
            }
            assert.strictEqual((await dbFile(fileA))?.bpm, 100, "rejected values never reach the DB");
        });

        await step("patch: bpm=null clears the tempo", async () => {
            const res = await patch(A.token, fileA, { bpm: null });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json.bpm, null);
            assert.strictEqual((await dbFile(fileA))?.bpm, null);
        });

        await step("patch: body without `bpm` → 400 'Nothing to update'", async () => {
            const res = await patch(A.token, fileA, { name: "renamed" });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.json.error.code, "BAD_REQUEST");
            assert.match(res.json.error.message, /Nothing to update/);
            assert.strictEqual((await dbFile(fileA))?.name, "song.wav", "name is not patchable");
        });

        await step("patch: unknown file and another user's file → 404 with the DB untouched", async () => {
            await patch(A.token, fileA, { bpm: 111 });
            const foreign = await patch(B.token, fileA, { bpm: 222 });
            assert.strictEqual(foreign.status, 404);
            assert.strictEqual(foreign.json.error.code, "NOT_FOUND");
            assert.strictEqual((await dbFile(fileA))?.bpm, 111, "B cannot change A's BPM");
            assert.strictEqual((await patch(A.token, "file_nope", { bpm: 100 })).status, 404);
            // Ownership is checked before payload validation: B learns nothing from a 400 vs 404.
            assert.strictEqual((await patch(B.token, fileA, { bpm: "abc" })).status, 404);
        });

        // ── GET /v1/files (list) ────────────────────────────────────────────

        const C = await h.registerAndLogin();
        const t0 = Date.parse("2024-01-01T00:00:00Z");
        const at = (i: number) => new Date(t0 + i * 60_000).toISOString();
        await seedFile(C.userId, { id: "file_c_a", name: "bravo", size: 300, createdAt: at(1) });
        await seedFile(C.userId, { id: "file_c_b", name: "alpha", size: 100, createdAt: at(2), bpm: 140 });
        await seedFile(C.userId, { id: "file_c_c", name: "charlie", size: 200, createdAt: at(3) });
        await seedFile(C.userId, { id: "file_c_d", name: "delta", size: 400, createdAt: at(4) });
        await seedFile(C.userId, { id: "file_c_out", name: "zzz-output.sng", kind: "output", createdAt: at(5) });
        const list = (token: string | undefined, qs = "") => h.request<FileList & ApiErr>(`/v1/files${qs}`, { token });
        const ids = (r: { json: FileList }) => r.json.files.map((f) => f.file_id);

        await step("list: defaults to newest first, 20 per page, source files only", async () => {
            const res = await list(C.token);
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(ids(res), ["file_c_d", "file_c_c", "file_c_b", "file_c_a"]);
            assert.strictEqual(res.json.total, 4, "output-kind files are not counted as songs");
            assert.strictEqual(res.json.page, 1);
            assert.strictEqual(res.json.per_page, 20);
            const b = res.json.files.find((f) => f.file_id === "file_c_b")!;
            assert.deepStrictEqual(
                { name: b.name, size_bytes: b.size_bytes, bpm: b.bpm, kind: b.kind, mime_type: b.mime_type },
                { name: "alpha", size_bytes: 100, bpm: 140, kind: "source", mime_type: "audio/wav" },
            );
            assert.ok(!("local_path" in b) && !("user_id" in b));
        });

        await step("list: order=asc and sort=name|size_bytes|created_at", async () => {
            assert.deepStrictEqual(ids(await list(C.token, "?order=asc")), ["file_c_a", "file_c_b", "file_c_c", "file_c_d"]);
            assert.deepStrictEqual(ids(await list(C.token, "?sort=name&order=asc")), ["file_c_b", "file_c_a", "file_c_c", "file_c_d"]);
            assert.deepStrictEqual(ids(await list(C.token, "?sort=name&order=desc")), ["file_c_d", "file_c_c", "file_c_a", "file_c_b"]);
            assert.deepStrictEqual(ids(await list(C.token, "?sort=size_bytes&order=asc")), ["file_c_b", "file_c_c", "file_c_a", "file_c_d"]);
            assert.deepStrictEqual(ids(await list(C.token, "?sort=size_bytes")), ["file_c_d", "file_c_a", "file_c_c", "file_c_b"]);
            assert.deepStrictEqual(ids(await list(C.token, "?sort=created_at&order=asc")), ["file_c_a", "file_c_b", "file_c_c", "file_c_d"]);
            // anything other than "asc" falls back to descending
            assert.deepStrictEqual(ids(await list(C.token, "?order=sideways")), ["file_c_d", "file_c_c", "file_c_b", "file_c_a"]);
        });

        await step("list: unknown or malicious sort column falls back to created_at without touching the DB", async () => {
            const res = await list(C.token, `?sort=${encodeURIComponent("name; DROP TABLE files; --")}&order=asc`);
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(ids(res), ["file_c_a", "file_c_b", "file_c_c", "file_c_d"]);
            assert.strictEqual((await list(C.token, "?sort=user_id")).status, 200);
            assert.ok((await h.sql`SELECT COUNT(*)::int AS n FROM files`)[0]!.n as number > 0, "files table intact");
        });

        await step("list: pagination slices pages and reports the true total", async () => {
            const p1 = await list(C.token, "?per_page=3");
            assert.deepStrictEqual(ids(p1), ["file_c_d", "file_c_c", "file_c_b"]);
            assert.strictEqual(p1.json.total, 4);
            assert.strictEqual(p1.json.per_page, 3);
            const p2 = await list(C.token, "?per_page=3&page=2");
            assert.deepStrictEqual(ids(p2), ["file_c_a"]);
            assert.strictEqual(p2.json.page, 2);
            const beyond = await list(C.token, "?per_page=3&page=9");
            assert.deepStrictEqual(ids(beyond), []);
            assert.strictEqual(beyond.json.total, 4);
        });

        await step("list: page/per_page are clamped (page>=1, per_page 1..100, junk → defaults)", async () => {
            const huge = await list(C.token, "?per_page=100000");
            assert.strictEqual(huge.json.per_page, 100);
            const negative = await list(C.token, "?per_page=-5&page=-3");
            assert.strictEqual(negative.json.per_page, 1);
            assert.strictEqual(negative.json.page, 1);
            assert.strictEqual(negative.json.files.length, 1);
            const zero = await list(C.token, "?per_page=0&page=0");
            assert.strictEqual(zero.json.per_page, 20, "0 is not a valid size → default");
            assert.strictEqual(zero.json.page, 1);
            const junk = await list(C.token, "?per_page=abc&page=xyz");
            assert.strictEqual(junk.json.per_page, 20);
            assert.strictEqual(junk.json.page, 1);
        });

        await step("list: users only see their own files; a fresh user gets an empty page", async () => {
            const fresh = await h.registerAndLogin();
            const res = await list(fresh.token);
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(res.json.files, []);
            assert.strictEqual(res.json.total, 0);
            const a = await list(A.token, "?per_page=100");
            assert.ok(a.json.files.some((f) => f.file_id === fileA));
            assert.ok(!a.json.files.some((f) => f.file_id.startsWith("file_c_")), "C's files do not leak to A");
            const b = await list(B.token, "?per_page=100");
            assert.ok(!b.json.files.some((f) => f.file_id === fileA), "A's files do not leak to B");
        });

        // ── GET /v1/files/:id/download ──────────────────────────────────────

        await step("download: streams the stored bytes with the display name as filename", async () => {
            await patch(A.token, fileA, { bpm: 120 });
            const res = await fetch(`${h.base}/v1/files/${fileA}/download`, { headers: { authorization: `Bearer ${A.token}` } });
            assert.strictEqual(res.status, 200);
            assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename=song\.wav/);
            assert.strictEqual(res.headers.get("content-type"), "audio/wav");
            const body = Buffer.from(await res.arrayBuffer());
            assert.ok(body.equals(wav120), "downloaded bytes match the upload");
        });

        await step("download: unknown id and another user's file → 404", async () => {
            const foreign = await h.request<ApiErr>(`/v1/files/${fileA}/download`, { token: B.token });
            assert.strictEqual(foreign.status, 404);
            assert.strictEqual(foreign.json.error.message, "File not found");
            assert.strictEqual((await h.request(`/v1/files/file_missing/download`, { token: A.token })).status, 404);
        });

        await step("download: DB row whose bytes are gone from disk → 404 'File data missing from storage'", async () => {
            const res = await h.request<ApiErr>("/v1/files/file_c_a/download", { token: C.token });
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.json.error.code, "NOT_FOUND");
            assert.match(res.json.error.message, /missing from storage/);
        });

        // ── DELETE /v1/files/:id ────────────────────────────────────────────

        await step("delete: removes DB row and bytes (204), after which every route 404s", async () => {
            const up = await upload(A.token, uploadForm(clickTrack(120, 2), { filename: "del.wav" }));
            const id = up.json.file_id;
            const filePath = (await dbFile(id))!.local_path as string;
            assert.ok(fs.existsSync(filePath));
            const res = await h.request(`/v1/files/${id}`, { method: "DELETE", token: A.token });
            assert.strictEqual(res.status, 204);
            assert.strictEqual(res.text, "");
            assert.ok(!fs.existsSync(filePath), "bytes removed from disk");
            assert.strictEqual(await dbFile(id), undefined, "row removed");
            assert.strictEqual((await h.request(`/v1/files/${id}`, { token: A.token })).status, 404);
            assert.strictEqual((await h.request(`/v1/files/${id}/download`, { token: A.token })).status, 404);
            assert.strictEqual((await h.request(`/v1/files/${id}`, { method: "DELETE", token: A.token })).status, 404, "second delete");
        });

        await step("delete: another user cannot delete the file — row and bytes survive", async () => {
            const res = await h.request<ApiErr>(`/v1/files/${fileA}`, { method: "DELETE", token: B.token });
            assert.strictEqual(res.status, 404);
            assert.ok(await dbFile(fileA));
            assert.ok(fs.existsSync(fileAPath));
        });

        await step("delete: refused with 409 while a pending/queued/assigned/processing task uses the file", async () => {
            const up = await upload(A.token, uploadForm(clickTrack(120, 2), { filename: "busy.wav" }));
            const id = up.json.file_id;
            const filePath = (await dbFile(id))!.local_path as string;
            for (const status of ["pending", "queued", "assigned", "processing"]) {
                const taskId = await seedTask(A.userId, id, status);
                const res = await h.request<ApiErr>(`/v1/files/${id}`, { method: "DELETE", token: A.token });
                assert.strictEqual(res.status, 409, status);
                assert.strictEqual(res.json.error.code, "CONFLICT");
                assert.ok(await dbFile(id), "row kept");
                assert.ok(fs.existsSync(filePath), "bytes kept");
                await h.sql`UPDATE tasks SET status = ${"completed"} WHERE task_id = ${taskId}`;
            }
            // Only terminal tasks reference it now → deletable.
            await seedTask(A.userId, id, "failed");
            await seedTask(A.userId, id, "cancelled");
            const ok = await h.request(`/v1/files/${id}`, { method: "DELETE", token: A.token });
            assert.strictEqual(ok.status, 204);
            assert.ok(!fs.existsSync(filePath));
        });

        await step("delete: succeeds even when the bytes are already gone from disk", async () => {
            const res = await h.request("/v1/files/file_c_b", { method: "DELETE", token: C.token });
            assert.strictEqual(res.status, 204);
            assert.strictEqual(await dbFile("file_c_b"), undefined);
            assert.strictEqual((await list(C.token)).json.total, 3);
        });

        // ═══════════════════════════════════════════════════════════════════
        // /charts   (Modal service replaced by `fake`)
        // ═══════════════════════════════════════════════════════════════════

        process.env.MODAL_GENERATE_URL = fake.url;
        delete process.env.AUDIO2CHART_TOKEN;

        const postChart = (token: string | undefined, form: FormData) =>
            h.request<{ jobId: string; error?: string }>("/charts", { method: "POST", token, form });
        const getJob = (token: string | undefined, id: string) => h.request<ChartStatus & { error: string | null }>(`/charts/${id}`, { token });
        const audioForm = (opts: { opts?: string; mime?: string; field?: string; filename?: string } = {}) => {
            const form = new FormData();
            if (opts.opts !== undefined) form.append("opts", opts.opts);
            form.append(
                opts.field ?? "audio",
                bytesBlob(Buffer.from("fake-audio-bytes"), opts.mime ?? "audio/mpeg"),
                opts.filename ?? "track.mp3",
            );
            return form;
        };
        const settle = (token: string, id: string) =>
            waitFor(async () => {
                const r = await getJob(token, id);
                return r.json.status === "pending" || r.json.status === "processing" ? null : r;
            });

        await step("charts: every endpoint requires auth (401)", async () => {
            assert.strictEqual((await h.request("/charts", { method: "POST", form: audioForm() })).status, 401);
            assert.strictEqual((await h.request("/charts/abc")).status, 401);
            assert.strictEqual((await h.request("/charts/abc/file")).status, 401);
            assert.strictEqual((await h.request("/charts/abc", { token: "bogus" })).status, 401);
            assert.strictEqual(fake.calls.length, 0, "unauthenticated requests never reach the paid backend");
        });

        await step("charts: POST validation — missing audio, bad MIME, bad opts JSON, wrong field", async () => {
            const noAudio = new FormData();
            noAudio.append("opts", "{}");
            const r1 = await postChart(A.token, noAudio);
            assert.strictEqual(r1.status, 400);
            assert.match(r1.json.error ?? "", /Missing required field: audio/);

            const r2 = await h.request<ApiErr>("/charts", { method: "POST", token: A.token, form: audioForm({ mime: "text/plain", filename: "a.txt" }) });
            assert.strictEqual(r2.status, 400);
            assert.strictEqual(r2.json.error.code, "BAD_REQUEST");
            assert.match(r2.json.error.message, /Unsupported MIME type: text\/plain/);

            const r3 = await postChart(A.token, audioForm({ opts: "{not json" }));
            assert.strictEqual(r3.status, 400);
            assert.match(r3.json.error ?? "", /Invalid 'opts' JSON/);

            const r4 = await h.request<ApiErr>("/charts", { method: "POST", token: A.token, form: audioForm({ field: "file" }) });
            assert.strictEqual(r4.status, 400);
            assert.match(r4.json.error.message, /unexpected/i);

            assert.strictEqual(fake.calls.length, 0, "no rejected request reached Modal");
        });

        await step("charts: happy path → 202 jobId, completes, status exposes chartUrl, file downloads", async () => {
            fake.mode = "ok";
            process.env.AUDIO2CHART_TOKEN = "s3cret-token";
            const res = await postChart(
                A.token,
                audioForm({
                    opts: JSON.stringify({
                        model_name: "m1", temperature: 0.7, top_k: 20, name: "Cool Song", artist: "Band",
                        album: "LP", genre: "rock", charter: "me", bpm: 133, resolution: 480,
                    }),
                }),
            );
            assert.strictEqual(res.status, 202, res.text);
            assert.match(res.json.jobId, /^[0-9a-f-]{36}$/);

            const done = await settle(A.token, res.json.jobId);
            assert.strictEqual(done.status, 200);
            assert.strictEqual(done.json.status, "complete");
            assert.strictEqual(done.json.id, res.json.jobId);
            assert.strictEqual(done.json.chartUrl, `/charts/${res.json.jobId}/file`);
            assert.strictEqual(done.json.error, null);

            // The route forwarded the audio, the token and every option to the model service.
            const call = fake.calls.at(-1)!;
            assert.strictEqual(call.token, "s3cret-token");
            assert.strictEqual(call.audioName.endsWith(".mp3"), true);
            assert.strictEqual(call.audioBytes, "fake-audio-bytes".length);
            assert.deepStrictEqual(call.fields, {
                model_name: "m1", temperature: "0.7", top_k: "20", bpm: "133", resolution: "480",
                name: "Cool Song", artist: "Band", album: "LP", genre: "rock", charter: "me",
            });

            const file = await fetch(`${h.base}${done.json.chartUrl}`, { headers: { authorization: `Bearer ${A.token}` } });
            assert.strictEqual(file.status, 200);
            assert.match(file.headers.get("content-disposition") ?? "", /filename="Cool Song\.chart"/);
            assert.strictEqual(await file.text(), FAKE_CHART);
            assert.ok(fs.existsSync(path.join(CHARTS_OUT, "Cool Song.chart")), "chart written under CHARTS_OUTPUT_DIR");
            delete process.env.AUDIO2CHART_TOKEN;
        });

        await step("charts: no opts → generation uses defaults; no token header when AUDIO2CHART_TOKEN unset", async () => {
            const n = fake.calls.length;
            const res = await postChart(A.token, audioForm({ filename: "my track!.mp3" }));
            assert.strictEqual(res.status, 202);
            const done = await settle(A.token, res.json.jobId);
            assert.strictEqual(done.json.status, "complete");
            const call = fake.calls[n]!;
            assert.strictEqual(call.token, undefined);
            assert.deepStrictEqual(call.fields, {}, "only audio was forwarded");
            // Chart name falls back to the uploaded (uuid-named) file's basename.
            const file = await h.request(`/charts/${res.json.jobId}/file`, { token: A.token });
            assert.strictEqual(file.status, 200);
            assert.strictEqual(file.text, FAKE_CHART);
        });

        await step("charts: a hostile opts.name cannot escape CHARTS_OUTPUT_DIR (path separators sanitized)", async () => {
            const res = await postChart(A.token, audioForm({ opts: JSON.stringify({ name: "../../evil/../x" }) }));
            assert.strictEqual(res.status, 202);
            const done = await settle(A.token, res.json.jobId);
            assert.strictEqual(done.json.status, "complete");
            const files = listDir(CHARTS_OUT);
            assert.ok(files.includes(".._.._evil_.._x.chart"), `sanitized name present: ${files.join(",")}`);
            assert.ok(!fs.existsSync(path.join(WORK_ROOT, "evil")), "nothing created outside the output dir");
        });

        await step("charts: backend HTTP error → job ends in status=error with the message; /file is 409", async () => {
            fake.mode = "fail";
            const res = await postChart(A.token, audioForm());
            assert.strictEqual(res.status, 202, "request is accepted; failure is reported via the job");
            const done = await settle(A.token, res.json.jobId);
            assert.strictEqual(done.json.status, "error");
            assert.match(done.json.error ?? "", /audio2chart failed: 500/);
            assert.match(done.json.error ?? "", /model exploded/);
            assert.strictEqual(done.json.chartUrl, null);
            const file = await h.request<{ error: string }>(`/charts/${res.json.jobId}/file`, { token: A.token });
            assert.strictEqual(file.status, 409);
            assert.match(file.json.error, /Job not complete \(status=error\)/);
        });

        await step("charts: a 200 that is not a .chart payload is treated as a failure", async () => {
            fake.mode = "garbage";
            const res = await postChart(A.token, audioForm());
            const done = await settle(A.token, res.json.jobId);
            assert.strictEqual(done.json.status, "error");
            assert.match(done.json.error ?? "", /unexpected payload/);
        });

        await step("charts: unreachable backend → job error (not a crashed server)", async () => {
            const saved = process.env.MODAL_GENERATE_URL;
            process.env.MODAL_GENERATE_URL = "http://127.0.0.1:1/never";
            try {
                const res = await postChart(A.token, audioForm());
                assert.strictEqual(res.status, 202);
                const done = await settle(A.token, res.json.jobId);
                assert.strictEqual(done.json.status, "error");
                assert.ok((done.json.error ?? "").length > 0);
            } finally {
                process.env.MODAL_GENERATE_URL = saved;
            }
            assert.strictEqual((await h.request("/health")).status, 200);
        });

        await step("charts: in-flight job reports processing + progress, /file is 409 until it completes", async () => {
            fake.mode = "hold";
            const n = fake.calls.length;
            const res = await postChart(A.token, audioForm({ opts: JSON.stringify({ name: "Held" }) }));
            assert.strictEqual(res.status, 202);
            await waitFor(async () => (fake.calls.length > n ? true : null));
            const mid = await getJob(A.token, res.json.jobId);
            assert.strictEqual(mid.status, 200);
            assert.strictEqual(mid.json.status, "processing");
            assert.deepStrictEqual(mid.json.progress, { stage: "generating", step: 0, total: 0 });
            assert.strictEqual(mid.json.chartUrl, null);
            const early = await h.request<{ error: string }>(`/charts/${res.json.jobId}/file`, { token: A.token });
            assert.strictEqual(early.status, 409);
            assert.match(early.json.error, /Job not complete \(status=processing\)/);

            fake.mode = "ok";
            fake.release();
            const done = await settle(A.token, res.json.jobId);
            assert.strictEqual(done.json.status, "complete");
            assert.strictEqual((await h.request(`/charts/${res.json.jobId}/file`, { token: A.token })).status, 200);
        });

        await step("charts: the uploaded audio is deleted from temp storage once the job finishes", async () => {
            const chartUploads = CHART_UPLOAD_DIR;
            fake.mode = "ok";
            const before = listDir(chartUploads);
            const res = await postChart(A.token, audioForm());
            await settle(A.token, res.json.jobId);
            // unlink runs in a `finally` right after the job settles; give it a tick.
            await waitFor(async () => (JSON.stringify(listDir(chartUploads)) === JSON.stringify(before) ? true : null), 3000);
        });

        await step("charts: unknown job id → 404 on both status and file endpoints", async () => {
            const s = await h.request<{ error: string }>("/charts/does-not-exist", { token: A.token });
            assert.strictEqual(s.status, 404);
            assert.strictEqual(s.json.error, "Job not found");
            const f = await h.request<{ error: string }>("/charts/does-not-exist/file", { token: A.token });
            assert.strictEqual(f.status, 404);
            assert.strictEqual(f.json.error, "Job not found");
        });

        await step("charts: jobs older than the 24h TTL are evicted on the next request", async () => {
            const res = await postChart(A.token, audioForm());
            await settle(A.token, res.json.jobId);
            assert.strictEqual((await getJob(A.token, res.json.jobId)).status, 200);
            const realNow = Date.now;
            Date.now = () => realNow() + 25 * 60 * 60 * 1000;
            try {
                assert.strictEqual((await getJob(A.token, res.json.jobId)).status, 404, "expired job evicted");
                assert.strictEqual((await h.request(`/charts/${res.json.jobId}/file`, { token: A.token })).status, 404);
            } finally {
                Date.now = realNow;
            }
        });
    } finally {
        await fake.close();
        // /charts stores uploads under os.tmpdir() (not configurable); remove any a rejected
        // request left behind so repeated runs do not accumulate files there.
        for (const f of listDir(CHART_UPLOAD_DIR)) {
            if (!chartUploadsAtStart.has(f)) fs.rmSync(path.join(CHART_UPLOAD_DIR, f), { force: true });
        }
        await h.close();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
