/**
 * Tests for conversion resume (src/server/resume.ts) and the Express app
 * wiring in src/server/app.ts (health, splitters, error handler, legacy
 * /split + /jobs endpoints, rate limiting).
 *
 * Drives the REAL app and REAL worker through the shared hermetic harness
 * (in-memory pg-mem DB). LALAL and Modal are replaced by in-process fakes via
 * setWorkerExternals(); the legacy /split path only ever uses the DummySplitter.
 *
 * Usage:  npx tsx tests/resume-and-app.test.ts
 */

import { createHarness, writeSilentWav } from "./helpers/harness.js";
import * as assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface ApiError {
    error: { code: string; message: string };
}
interface ConversionBody {
    conversion_id: string;
    status: string;
    tasks: { task_id: string; type: string; status: string }[];
}
interface SplitAccepted {
    jobId: string;
}
interface JobBody {
    id: string;
    status: string;
    stems: { stem: string; path: string }[] | null;
    error: string | null;
}
interface LegacyError {
    error: string;
}

const FAKE_CHART = `[Song]
{
  Name = "Fake"
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 90000
}
[Events]
{
}
[ExpertSingle]
{
  768 = N 0 0
  960 = N 1 0
  1152 = N 2 0
}`;

/** Compact .sng unpacker: returns the (unmasked) files inside the archive. */
function unpackSng(buf: Buffer): Map<string, Buffer> {
    const xorMask = buf.subarray(10, 26);
    let off = 26;
    off += 8 + Number(buf.readBigUInt64LE(off)); // skip the metadata section
    off += 8; // file-index length
    const fileCount = Number(buf.readBigUInt64LE(off));
    off += 8;
    const index: { name: string; len: number; abs: number }[] = [];
    for (let i = 0; i < fileCount; i++) {
        const nameLen = buf.readUInt8(off);
        off += 1;
        const name = buf.toString("utf8", off, off + nameLen);
        off += nameLen;
        const len = Number(buf.readBigUInt64LE(off));
        off += 8;
        const abs = Number(buf.readBigUInt64LE(off));
        off += 8;
        index.push({ name, len, abs });
    }
    const files = new Map<string, Buffer>();
    for (const { name, len, abs } of index) {
        const masked = buf.subarray(abs, abs + len);
        const data = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) data[i] = masked[i]! ^ (xorMask[i % 16]! ^ (i & 0xff));
        files.set(name, data);
    }
    return files;
}

/** Poll `check` until it returns true (real wall-clock: the code under test runs in the background). */
async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        const tick = Promise.withResolvers<void>();
        setTimeout(tick.resolve, 100);
        await tick.promise;
    }
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

    const h = await createHarness();
    const { setWorkerExternals } = await import("../src/server/worker.js");
    const { setSqlExecutor } = await import("../src/server/db.js");
    const { resumeConversion, resumeInterruptedConversions } = await import("../src/server/resume.js");

    // ── Controllable fakes for LALAL + Modal ─────────────────────────────
    const fake = {
        splitCalls: [] as { input: string; stems: string[] }[],
        chartCalls: [] as { name: string | undefined }[],
        chartClientBpms: [] as (number | undefined)[],
        gate: null as Promise<void> | null,
        onSplitEntered: null as (() => void) | null,
    };
    setWorkerExternals({
        createSplitter(outputDir: string) {
            return {
                async split(input: string, stems: string[]) {
                    fake.splitCalls.push({ input, stems: [...stems] });
                    fake.onSplitEntered?.();
                    if (fake.gate) await fake.gate;
                    const base = path.basename(input, path.extname(input));
                    fs.mkdirSync(outputDir, { recursive: true });
                    return {
                        stems: stems.map((stem) => {
                            const p = path.join(outputDir, `${base}_${stem}.wav`);
                            fs.copyFileSync(input, p);
                            return { stem: stem as never, path: p };
                        }),
                    };
                },
            };
        },
        createChartClient(opts: { bpm: number | undefined }) {
            fake.chartClientBpms.push(opts.bpm);
            return {
                async generateText(_audioPath: string, overrides?: { name?: string }) {
                    fake.chartCalls.push({ name: overrides?.name });
                    return FAKE_CHART;
                },
            };
        },
    });

    // ── Seeding helpers ──────────────────────────────────────────────────
    const uploadsDir = path.join(h.workRoot, "uploads");
    const wav = path.join(uploadsDir, "resume.wav");
    writeSilentWav(wav, 31);

    let fileCounter = 0;
    async function seedFile(userId: string, opts: { name?: string; bpm?: number | null } = {}): Promise<string> {
        const fileId = `file_res${++fileCounter}`;
        await h.sql`
            INSERT INTO files (file_id, user_id, name, size_bytes, mime_type, local_path, bpm, kind)
            VALUES (${fileId}, ${userId}, ${opts.name ?? "Resume Song.wav"}, ${1000}, ${"audio/wav"}, ${wav}, ${opts.bpm ?? null}, ${"source"})
        `;
        return fileId;
    }

    interface SeedTask {
        id: string;
        type: "split_stems" | "audio2chart" | "upload_s3";
        status: string;
        settings?: Record<string, unknown>;
        error?: { code: string; message: string };
    }
    async function seedConversion(conversionId: string, userId: string, status: string, inputFileId: string, tasks: SeedTask[]): Promise<void> {
        const base = Date.now() - 3_600_000;
        await h.sql`
            INSERT INTO conversions (conversion_id, user_id, status, input_file_id, created_at)
            VALUES (${conversionId}, ${userId}, ${status}, ${inputFileId}, ${new Date(base).toISOString()})
        `;
        for (const [i, t] of tasks.entries()) {
            await h.sql`
                INSERT INTO tasks (task_id, user_id, type, status, input_file_id, settings, error, created_at)
                VALUES (${t.id}, ${userId}, ${t.type}, ${t.status}, ${inputFileId}, ${JSON.stringify(t.settings ?? {})},
                        ${t.error ? JSON.stringify(t.error) : null}, ${new Date(base + i * 1000).toISOString()})
            `;
            await h.sql`INSERT INTO conversion_tasks (conversion_id, task_id) VALUES (${conversionId}, ${t.id})`;
        }
    }

    const convStatus = async (id: string): Promise<string> => {
        const rows = await h.sql`SELECT status FROM conversions WHERE conversion_id = ${id}`;
        return rows[0]!.status as string;
    };
    const taskRows = (conversionId: string) =>
        h.sql`
            SELECT t.task_id, t.type, t.status, t.error FROM tasks t
            JOIN conversion_tasks ct ON ct.task_id = t.task_id
            WHERE ct.conversion_id = ${conversionId} ORDER BY t.created_at`;
    const taskStatuses = async (conversionId: string): Promise<Record<string, string>> =>
        Object.fromEntries((await taskRows(conversionId)).map((r) => [r.task_id as string, r.status as string]));

    const fullPipeline = (prefix: string, instruments: string[], difficulty: string, statuses: string[] = []): SeedTask[] => [
        { id: `${prefix}_split`, type: "split_stems", status: statuses[0] ?? "pending", settings: { stems: 4, model: "orion" } },
        ...instruments.map((instrument, i): SeedTask => ({
            id: `${prefix}_${instrument}`,
            type: "audio2chart",
            status: statuses[i + 1] ?? "pending",
            settings: { difficulty, instrument },
        })),
        { id: `${prefix}_upload`, type: "upload_s3", status: statuses[instruments.length + 1] ?? "pending" },
    ];

    try {
        const owner = await h.registerAndLogin();

        // ════════════════════════════════════════════════════════════════
        // resume.ts
        // ════════════════════════════════════════════════════════════════

        await step("resumeConversion: unknown conversion → false and nothing is launched", async () => {
            const splitsBefore = fake.splitCalls.length;
            assert.strictEqual(await resumeConversion("conv_does_not_exist"), false);
            assert.strictEqual(fake.splitCalls.length, splitsBefore);
        });

        await step("resumeConversion: missing input file → false and the conversion/tasks are left exactly as they were", async () => {
            const file = await seedFile(owner.userId);
            await seedConversion(
                "conv_nofile",
                owner.userId,
                "failed",
                file,
                fullPipeline("nofile", ["guitar"], "expert", ["failed", "processing", "queued"]),
            );
            await h.sql`DELETE FROM files WHERE file_id = ${file}`;
            const splitsBefore = fake.splitCalls.length;

            assert.strictEqual(await resumeConversion("conv_nofile"), false);

            assert.strictEqual(await convStatus("conv_nofile"), "failed", "status not flipped to in_progress");
            assert.deepStrictEqual(await taskStatuses("conv_nofile"), {
                nofile_split: "failed",
                nofile_guitar: "processing",
                nofile_upload: "queued",
            });
            assert.strictEqual(fake.splitCalls.length, splitsBefore);
        });

        await step("resumeConversion: resets failed/processing/assigned/queued tasks, keeps completed/cancelled, derives instruments/difficulty/bpm and finishes", async () => {
            const file = await seedFile(owner.userId, { name: "Resumed Song.wav", bpm: 130 });
            const err = { code: "WORKER_ERROR", message: "crashed mid-run" };
            await seedConversion("conv_reset", owner.userId, "failed", file, [
                { id: "reset_split", type: "split_stems", status: "failed", settings: { stems: 4, model: "orion" }, error: err },
                { id: "reset_guitar", type: "audio2chart", status: "processing", settings: { difficulty: "hard", instrument: "guitar" }, error: err },
                { id: "reset_bass", type: "audio2chart", status: "completed", settings: { difficulty: "hard", instrument: "bass" } },
                { id: "reset_drums", type: "audio2chart", status: "assigned", settings: { difficulty: "hard", instrument: "drums" } },
                { id: "reset_keys", type: "audio2chart", status: "cancelled", settings: { difficulty: "hard", instrument: "keys" } },
                { id: "reset_upload", type: "upload_s3", status: "queued" },
            ]);

            // Hold the worker inside the split so the DB reflects exactly what resume did.
            const gate = Promise.withResolvers<void>();
            const entered = Promise.withResolvers<void>();
            fake.gate = gate.promise;
            fake.onSplitEntered = entered.resolve;
            const splitsBefore = fake.splitCalls.length;
            const chartsBefore = fake.chartCalls.length;
            try {
                assert.strictEqual(await resumeConversion("conv_reset"), true);
                await entered.promise;

                assert.strictEqual(await convStatus("conv_reset"), "in_progress");
                assert.deepStrictEqual(await taskStatuses("conv_reset"), {
                    reset_split: "processing", // reset to pending, then picked up by the relaunched worker
                    reset_guitar: "pending",
                    reset_bass: "completed", // untouched
                    reset_drums: "pending",
                    reset_keys: "cancelled", // untouched
                    reset_upload: "pending",
                });
                const errors = Object.fromEntries((await taskRows("conv_reset")).map((r) => [r.task_id as string, r.error]));
                assert.strictEqual(errors.reset_split, null, "stale error cleared on reset tasks");
                assert.strictEqual(errors.reset_guitar, null);
            } finally {
                gate.resolve();
                fake.gate = null;
                fake.onSplitEntered = null;
            }

            await until(async () => (await convStatus("conv_reset")) !== "in_progress", "resumed conversion to finish");
            assert.strictEqual(await convStatus("conv_reset"), "completed");
            assert.ok(Object.values(await taskStatuses("conv_reset")).every((s) => s === "completed"));

            // Instruments are derived (in task order) from the persisted audio2chart tasks.
            assert.strictEqual(fake.splitCalls.length, splitsBefore + 1);
            assert.deepStrictEqual(fake.splitCalls.at(-1)!.stems, ["electric_guitar", "bass", "drum", "piano"]);
            assert.deepStrictEqual(
                fake.chartCalls.slice(chartsBefore).map((c) => c.name),
                ["Resumed Song (guitar)", "Resumed Song (bass)", "Resumed Song (drums)", "Resumed Song (keys)"],
            );
            assert.strictEqual(fake.chartClientBpms.at(-1), 130, "stored BPM forwarded to the chart client");

            // The difficulty persisted on the tasks ("hard") is what the packaged chart uses.
            const dl = await fetch(`${h.base}/v1/conversions/conv_reset/download`, { headers: { authorization: `Bearer ${owner.token}` } });
            assert.strictEqual(dl.status, 200);
            const chart = unpackSng(Buffer.from(await dl.arrayBuffer())).get("notes.chart")!.toString("utf8");
            for (const section of ["[HardSingle]", "[HardDoubleBass]", "[HardDrums]", "[HardKeyboard]"]) {
                assert.ok(chart.includes(section), `${section} present`);
            }
            assert.ok(!chart.includes("[ExpertSingle]"));
            assert.ok(chart.includes("B 130000") && !chart.includes("B 90000"), "tempo enforced to the stored BPM");
        });

        await step("resumeInterruptedConversions: relaunches only in_progress conversions; others stay untouched; unresumable ones are skipped", async () => {
            const okFile = await seedFile(owner.userId, { name: "Interrupted.wav" });
            const goneFile = await seedFile(owner.userId);

            await seedConversion("conv_int_ok", owner.userId, "in_progress", okFile, fullPipeline("intok", ["guitar"], "expert", ["completed", "processing", "pending"]));
            await seedConversion("conv_int_gone", owner.userId, "in_progress", goneFile, fullPipeline("intgone", ["guitar"], "expert", ["processing"]));
            await h.sql`DELETE FROM files WHERE file_id = ${goneFile}`;
            await seedConversion("conv_int_bare", owner.userId, "in_progress", okFile, []); // no tasks at all
            await seedConversion("conv_int_done", owner.userId, "completed", okFile, fullPipeline("intdone", ["guitar"], "expert", ["completed", "completed", "completed"]));
            await seedConversion("conv_int_failed", owner.userId, "failed", okFile, fullPipeline("intfailed", ["guitar"], "expert", ["failed"]));

            const splitsBefore = fake.splitCalls.length;
            await resumeInterruptedConversions();

            await until(
                async () => (await convStatus("conv_int_ok")) === "completed" && (await convStatus("conv_int_bare")) === "failed",
                "interrupted conversions to settle",
            );
            assert.deepStrictEqual(Object.values(await taskStatuses("conv_int_ok")), ["completed", "completed", "completed"]);

            // The malformed conversion (no split/upload tasks) fails visibly instead of hanging.
            assert.strictEqual(await convStatus("conv_int_bare"), "failed");
            // The conversion whose input vanished was skipped: still in_progress, tasks as seeded.
            assert.strictEqual(await convStatus("conv_int_gone"), "in_progress");
            assert.strictEqual((await taskStatuses("conv_int_gone")).intgone_split, "processing");
            // Terminal conversions were not re-run.
            assert.strictEqual(await convStatus("conv_int_done"), "completed");
            assert.strictEqual(await convStatus("conv_int_failed"), "failed");
            assert.strictEqual((await taskStatuses("conv_int_failed")).intfailed_split, "failed");
            assert.strictEqual(fake.splitCalls.length, splitsBefore + 1, "only the resumable conversion ran a split");
        });

        await step("resumeInterruptedConversions: a failure resuming one conversion is swallowed and the rest still resume", async () => {
            const file = await seedFile(owner.userId, { name: "Second Chance.wav" });
            await seedConversion("conv_sw_bad", owner.userId, "in_progress", file, fullPipeline("swbad", ["guitar"], "expert"));
            await seedConversion("conv_sw_good", owner.userId, "in_progress", file, fullPipeline("swgood", ["guitar"], "expert"));
            // Neutralise the earlier skipped conversion so this scenario is isolated.
            await h.sql`UPDATE conversions SET status = ${"failed"} WHERE conversion_id = ${"conv_int_gone"}`;

            setSqlExecutor((strings, ...values) =>
                strings.join("?").includes("SELECT t.* FROM tasks") && values[0] === "conv_sw_bad"
                    ? Promise.reject(new Error("simulated task lookup failure"))
                    : h.sql(strings, ...values),
            );
            try {
                await resumeInterruptedConversions(); // must not reject
            } finally {
                setSqlExecutor(h.sql);
            }

            await until(async () => (await convStatus("conv_sw_good")) === "completed", "healthy conversion to complete");
            assert.strictEqual(await convStatus("conv_sw_bad"), "in_progress", "failed resume leaves the row for a later sweep");
            assert.deepStrictEqual(await taskStatuses("conv_sw_bad"), { swbad_split: "pending", swbad_guitar: "pending", swbad_upload: "pending" });
        });

        await step("resumeInterruptedConversions: a database error while listing is swallowed and nothing is launched", async () => {
            const splitsBefore = fake.splitCalls.length;
            setSqlExecutor((strings, ...values) =>
                strings.join("?").includes("FROM conversions WHERE status")
                    ? Promise.reject(new Error("simulated connection loss"))
                    : h.sql(strings, ...values),
            );
            try {
                await assert.doesNotReject(resumeInterruptedConversions());
            } finally {
                setSqlExecutor(h.sql);
            }
            assert.strictEqual(fake.splitCalls.length, splitsBefore);
            assert.strictEqual(await convStatus("conv_sw_bad"), "in_progress");
        });

        await step("resumeInterruptedConversions: nothing interrupted → resolves quietly without launching", async () => {
            await h.sql`UPDATE conversions SET status = ${"failed"} WHERE status = ${"in_progress"}`;
            const splitsBefore = fake.splitCalls.length;
            await resumeInterruptedConversions();
            assert.strictEqual(fake.splitCalls.length, splitsBefore);
        });

        // ════════════════════════════════════════════════════════════════
        // app.ts
        // ════════════════════════════════════════════════════════════════

        await step("GET /health → {ok:true} without authentication", async () => {
            const res = await h.request<{ ok: boolean }>("/health");
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(res.json, { ok: true });
        });

        await step("GET /splitters lists the stems each splitter supports", async () => {
            const res = await h.request<{ dummy: string[]; lalal: string[] }>("/splitters");
            assert.strictEqual(res.status, 200);
            assert.ok(res.json.dummy.includes("guitar") && res.json.dummy.includes("drums") && res.json.dummy.includes("vocals"));
            assert.ok(res.json.lalal.includes("electric_guitar") && res.json.lalal.includes("drum"));
            assert.ok(!res.json.lalal.includes("guitar"), "lalal uses its own stem vocabulary");
        });

        await step("static frontend is served and unknown routes/methods are 404", async () => {
            const index = await h.request("/");
            assert.strictEqual(index.status, 200);
            assert.match(index.headers.get("content-type") ?? "", /text\/html/);
            const css = await h.request("/style.css");
            assert.strictEqual(css.status, 200);
            assert.match(css.headers.get("content-type") ?? "", /text\/css/);

            for (const [method, url] of [["GET", "/definitely-not-a-route"], ["GET", "/v1/nope"], ["DELETE", "/health"], ["POST", "/jobs/x"]] as const) {
                const res = await h.request(url, { method });
                assert.strictEqual(res.status, 404, `${method} ${url}`);
            }
        });

        await step("malformed or oversized JSON bodies are answered with the JSON error envelope, no stack leak, and the server stays healthy", async () => {
            const cases: { name: string; body: string }[] = [
                { name: "malformed", body: "{not json" },
                { name: "oversized", body: JSON.stringify({ email: "a@dolly.test", password: "x".repeat(200_000) }) },
            ];
            for (const { name, body } of cases) {
                const res = await fetch(`${h.base}/v1/auth/login`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body,
                });
                const text = await res.text();
                assert.ok(res.status >= 400, `${name}: expected an error status, got ${res.status}`);
                assert.match(res.headers.get("content-type") ?? "", /application\/json/, `${name}: JSON error body`);
                const parsed = JSON.parse(text) as ApiError;
                assert.strictEqual(typeof parsed.error.code, "string");
                assert.strictEqual(typeof parsed.error.message, "string");
                assert.ok(!/\bat \S+\.(js|ts):\d+/.test(text), `${name}: no stack trace leaks`);
            }
            assert.deepStrictEqual((await h.request("/health")).json, { ok: true });
        });

        // ── Legacy /split + /jobs ────────────────────────────────────────
        const tmpUploadDir = path.join(os.tmpdir(), "dolly-uploads");
        const storedWithExt = (ext: string): string[] =>
            fs.existsSync(tmpUploadDir) ? fs.readdirSync(tmpUploadDir).filter((f) => f.endsWith(ext)) : [];
        const uniqueExt = (): string => `.t${crypto.randomBytes(5).toString("hex")}`;

        function splitForm(opts: { field?: string; type?: string; ext: string; bytes?: Buffer; fields?: Record<string, string> }): FormData {
            const form = new FormData();
            if (opts.field !== "") {
                form.append(opts.field ?? "audio", new Blob([opts.bytes ?? Buffer.from("fake audio bytes")], { type: opts.type ?? "audio/wav" }), `song${opts.ext}`);
            }
            for (const [k, v] of Object.entries(opts.fields ?? {})) form.append(k, v);
            return form;
        }

        await step("POST /split requires authentication", async () => {
            const res = await h.request<ApiError>("/split", { method: "POST", form: splitForm({ ext: uniqueExt(), fields: { stems: "guitar" } }) });
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.json.error.code, "UNAUTHORIZED");
        });

        await step("POST /split: upload errors go through the error handler (bad MIME, unexpected field) and store nothing", async () => {
            const badMimeExt = uniqueExt();
            const badMime = await h.request<ApiError>("/split", {
                method: "POST",
                token: owner.token,
                form: splitForm({ type: "text/plain", ext: badMimeExt, fields: { stems: "guitar" } }),
            });
            assert.strictEqual(badMime.status, 400);
            assert.strictEqual(badMime.json.error.code, "BAD_REQUEST");
            assert.match(badMime.json.error.message, /Unsupported MIME type: text\/plain/);
            assert.deepStrictEqual(storedWithExt(badMimeExt), []);

            const wrongFieldExt = uniqueExt();
            const wrongField = await h.request<ApiError>("/split", {
                method: "POST",
                token: owner.token,
                form: splitForm({ field: "file", ext: wrongFieldExt, fields: { stems: "guitar" } }),
            });
            assert.strictEqual(wrongField.status, 400);
            assert.strictEqual(wrongField.json.error.code, "BAD_REQUEST");
            assert.match(wrongField.json.error.message, /unexpected/i);
            assert.deepStrictEqual(storedWithExt(wrongFieldExt), []);
        });

        await step("POST /split: parameter validation → 400 and the uploaded temp file is cleaned up", async () => {
            const savedKey = process.env.LALAL_API_KEY;
            delete process.env.LALAL_API_KEY;
            try {
                const cases: { name: string; fields: Record<string, string>; noAudio?: boolean; message: RegExp }[] = [
                    { name: "no audio part", fields: { stems: "guitar" }, noAudio: true, message: /Missing required field: audio/ },
                    { name: "unknown splitter", fields: { splitter: "magic", stems: "guitar" }, message: /Unknown splitter "magic"/ },
                    { name: "missing stems", fields: {}, message: /Missing required field: stems/ },
                    { name: "blank stems", fields: { stems: " , ,," }, message: /at least one stem/ },
                    { name: "lalal without key", fields: { splitter: "lalal", stems: "drum" }, message: /requires apiKey/ },
                ];
                for (const c of cases) {
                    const ext = uniqueExt();
                    const res = await h.request<LegacyError>("/split", {
                        method: "POST",
                        token: owner.token,
                        form: splitForm({ ext, fields: c.fields, ...(c.noAudio ? { field: "" } : {}) }),
                    });
                    assert.strictEqual(res.status, 400, `${c.name}: ${res.text}`);
                    assert.match(res.json.error, c.message, c.name);
                    await until(() => storedWithExt(ext).length === 0, `${c.name}: temp upload to be removed`, 5000);
                }
            } finally {
                if (savedKey !== undefined) process.env.LALAL_API_KEY = savedKey;
            }
        });

        await step("POST /split + GET /jobs/:id: DummySplitter job completes, result stems are listed, temp upload removed, cache manifest written", async () => {
            const ext = uniqueExt();
            const bytes = Buffer.from("pretend this is a song " + crypto.randomUUID());
            const cacheDir = path.join(h.workRoot, "legacy-cache");
            const res = await h.request<SplitAccepted>("/split", {
                method: "POST",
                token: owner.token,
                form: splitForm({ ext, bytes, fields: { stems: "guitar, drums,,", cacheDir } }),
            });
            assert.strictEqual(res.status, 202, res.text);
            assert.match(res.json.jobId, /^[0-9a-f-]{36}$/);

            let job!: JobBody;
            await until(async () => {
                const r = await h.request<JobBody>(`/jobs/${res.json.jobId}`);
                assert.strictEqual(r.status, 200);
                job = r.json;
                return job.status === "complete" || job.status === "error";
            }, "legacy job to finish", 20_000);

            assert.strictEqual(job.status, "complete", JSON.stringify(job));
            assert.strictEqual(job.id, res.json.jobId);
            assert.strictEqual(job.error, null);
            assert.deepStrictEqual(job.stems!.map((s) => s.stem), ["guitar", "drums"]);
            for (const s of job.stems!) {
                assert.ok(path.isAbsolute(s.path));
                assert.ok(s.path.endsWith(`_${s.stem}.wav`));
                assert.strictEqual(path.dirname(s.path), path.resolve(process.env.OUTPUT_DIR!), "written under OUTPUT_DIR");
            }
            await until(() => storedWithExt(ext).length === 0, "temp upload to be removed after the job", 5000);

            const sha = crypto.createHash("sha256").update(bytes).digest("hex");
            const manifest = JSON.parse(fs.readFileSync(path.join(cacheDir, "cache-manifest.json"), "utf8")) as Record<string, string>;
            assert.deepStrictEqual(Object.keys(manifest).sort(), [`${sha}:dummy:drums`, `${sha}:dummy:guitar`]);
        });

        await step("POST /split: noCache=true skips the cache; a splitter failure is reported on the job", async () => {
            const cacheDir = path.join(h.workRoot, "should-not-exist");
            const res = await h.request<SplitAccepted>("/split", {
                method: "POST",
                token: owner.token,
                form: splitForm({ ext: uniqueExt(), fields: { stems: "kazoo", noCache: "true", cacheDir } }),
            });
            assert.strictEqual(res.status, 202);
            let job!: JobBody;
            await until(async () => {
                job = (await h.request<JobBody>(`/jobs/${res.json.jobId}`)).json;
                return job.status === "complete" || job.status === "error";
            }, "legacy job to fail", 20_000);
            assert.strictEqual(job.status, "error");
            assert.strictEqual(job.error, "Unsupported stems: kazoo");
            assert.strictEqual(job.stems, null);
            assert.ok(!fs.existsSync(cacheDir), "noCache must not create the cache dir");
        });

        await step("GET /jobs/:id: unknown id → 404; jobs expire after 24h", async () => {
            const unknown = await h.request<LegacyError>("/jobs/00000000-0000-0000-0000-000000000000");
            assert.strictEqual(unknown.status, 404);
            assert.strictEqual(unknown.json.error, "Job not found");

            const res = await h.request<SplitAccepted>("/split", {
                method: "POST",
                token: owner.token,
                form: splitForm({ ext: uniqueExt(), fields: { stems: "guitar", noCache: "true" } }),
            });
            assert.strictEqual(res.status, 202);
            assert.strictEqual((await h.request(`/jobs/${res.json.jobId}`)).status, 200);

            const realNow = Date.now;
            Date.now = () => realNow() + 25 * 60 * 60 * 1000;
            try {
                const expired = await h.request<LegacyError>(`/jobs/${res.json.jobId}`);
                assert.strictEqual(expired.status, 404, "job evicted once older than the TTL");
            } finally {
                Date.now = realNow;
            }
        });
    } finally {
        setWorkerExternals(null);
        await h.close();
    }

    // ════════════════════════════════════════════════════════════════════
    // Rate limiting (needs its own app instance with the limiters enabled)
    // ════════════════════════════════════════════════════════════════════
    const limited = await createHarness({ rateLimit: true });
    try {
        await step("rate limit: auth endpoints allow 10 attempts, then 429 RATE_LIMITED (shared by login and register)", async () => {
            const first = await limited.request<ApiError>("/v1/auth/login", { method: "POST", json: {} });
            assert.strictEqual(first.status, 400);
            assert.ok(first.headers.get("ratelimit") ?? first.headers.get("ratelimit-limit"), "standard RateLimit headers sent");
            assert.strictEqual(first.headers.get("x-ratelimit-limit"), null, "legacy headers disabled");

            for (let i = 2; i <= 10; i++) {
                const res = await limited.request("/v1/auth/login", { method: "POST", json: {} });
                assert.strictEqual(res.status, 400, `attempt ${i} still reaches the handler`);
            }
            const blocked = await limited.request<ApiError>("/v1/auth/login", { method: "POST", json: { email: "a@dolly.test", password: "password12345" } });
            assert.strictEqual(blocked.status, 429);
            assert.strictEqual(blocked.json.error.code, "RATE_LIMITED");
            assert.match(blocked.json.error.message, /Too many auth attempts/);
            assert.ok(blocked.headers.get("retry-after"), "Retry-After sent");

            const register = await limited.request<ApiError>("/v1/auth/register", { method: "POST", json: { email: "b@dolly.test", password: "password12345" } });
            assert.strictEqual(register.status, 429, "register shares the auth limiter");
            assert.strictEqual((await limited.sql`SELECT 1 FROM users`).length, 0, "a throttled signup never reaches the database");
        });

        await step("rate limit: general limiter throttles regular routes at 60/min but /health and /splitters stay exempt", async () => {
            // The 12 requests above already count against the general limiter (the auth throttle does not exempt them).
            let firstBlocked = -1;
            for (let i = 1; i <= 70; i++) {
                const res = await limited.request("/v1/files");
                if (res.status === 429) {
                    firstBlocked = i;
                    break;
                }
                assert.strictEqual(res.status, 401, "unauthenticated but not throttled");
            }
            assert.ok(firstBlocked > 1 && firstBlocked <= 49, `expected throttling within the 60-request budget, first 429 at ${firstBlocked}`);

            for (let i = 0; i < 70; i++) {
                const health = await limited.request<{ ok: boolean }>("/health");
                assert.strictEqual(health.status, 200, `/health request ${i} must never be throttled`);
            }
            assert.strictEqual((await limited.request("/splitters")).status, 200);
            assert.strictEqual((await limited.request("/v1/files")).status, 429, "regular routes remain throttled");
        });
    } finally {
        await limited.close();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error("Runner error:", error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
});
