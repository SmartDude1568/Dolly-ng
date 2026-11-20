/**
 * End-to-end tests for song identification inside a conversion.
 *
 * Drives the REAL Express app + REAL conversion worker through the hermetic harness. LALAL,
 * Modal and Shazam are replaced by in-process fakes via setWorkerExternals() (`identifySong`
 * is the Shazam seam); ffmpeg runs for real. Checks what actually ends up in the downloaded
 * .sng: its metadata, the notes.chart [Song] section and the album cover file.
 *
 * Usage:  npx tsx tests/identify-worker.test.ts
 */

import { createHarness, writeSilentWav } from "./helpers/harness.js";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SongIdentity } from "../src/identify.js";

interface ApiError {
    error: { code: string; message: string };
}
interface ConversionBody {
    conversion_id: string;
    status: string;
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

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake-cover-bytes")]);

interface Sng {
    meta: Map<string, string>;
    files: Map<string, Buffer>;
}

/** Unpack a .sng: its metadata pairs and (unmasked) files. */
function unpackSng(buf: Buffer): Sng {
    const xorMask = buf.subarray(10, 26);
    let off = 26;
    off += 8; // metadata section length
    const metaCount = Number(buf.readBigUInt64LE(off));
    off += 8;
    const meta = new Map<string, string>();
    for (let i = 0; i < metaCount; i++) {
        const kl = buf.readInt32LE(off);
        off += 4;
        const key = buf.toString("utf8", off, off + kl);
        off += kl;
        const vl = buf.readInt32LE(off);
        off += 4;
        meta.set(key, buf.toString("utf8", off, off + vl));
        off += vl;
    }
    off += 8; // file index section length
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
    return { meta, files };
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

    // What the fake Shazam returns next; `undefined` = leave identifySong off the externals.
    const shazam = {
        calls: [] as string[],
        result: null as SongIdentity | null,
        throwError: null as Error | null,
        wired: true,
    };
    const externals = {
        createSplitter(outputDir: string) {
            return {
                async split(input: string, stems: string[]) {
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
        createChartClient() {
            return {
                async generateText() {
                    return FAKE_CHART;
                },
            };
        },
        async identifySong(audioPath: string) {
            shazam.calls.push(audioPath);
            if (shazam.throwError) throw shazam.throwError;
            return shazam.result;
        },
    };
    const { identifySong: _unused, ...withoutIdentify } = externals;
    void _unused;
    const install = (): void => setWorkerExternals(shazam.wired ? externals : withoutIdentify);
    install();

    const wav = path.join(h.workRoot, "uploads", "mystery_track01.wav");
    writeSilentWav(wav, 31);
    const alice = await h.registerAndLogin();
    let fileCounter = 0;
    async function seedFile(): Promise<string> {
        const fileId = `file_id${++fileCounter}`;
        await h.sql`
            INSERT INTO files (file_id, user_id, name, size_bytes, mime_type, local_path, kind)
            VALUES (${fileId}, ${alice.userId}, ${"mystery_track01.wav"}, ${1000}, ${"audio/wav"}, ${wav}, ${"source"})`;
        return fileId;
    }

    /**
     * Poll the HTTP API until the conversion reaches `want`. Real polling on purpose: the
     * worker runs in the background and its progress is only observable through the API.
     */
    async function waitForStatus(id: string, want: "completed" | "failed", timeoutMs = 120_000): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const s = await h.request<ConversionBody>(`/v1/conversions/${id}`, { token: alice.token });
            if (s.json.status === want) return;
            if (want === "completed") assert.notStrictEqual(s.json.status, "failed", `conversion failed: ${s.text}`);
            if (Date.now() > deadline) assert.fail(`conversion ${id} still ${s.json.status}, wanted ${want}`);
            const tick = Promise.withResolvers<void>();
            setTimeout(tick.resolve, 200);
            await tick.promise;
        }
    }

    async function convert(extra: Record<string, unknown> = {}): Promise<{ id: string; sng: Sng; chart: string }> {
        const created = await h.request<ConversionBody>("/v1/conversions", {
            method: "POST",
            token: alice.token,
            json: { input_file_id: await seedFile(), instruments: ["guitar"], ...extra },
        });
        assert.strictEqual(created.status, 201, created.text);
        const id = created.json.conversion_id;
        await waitForStatus(id, "completed");
        const dl = await fetch(`${h.base}/v1/conversions/${id}/download`, { headers: { authorization: `Bearer ${alice.token}` } });
        assert.strictEqual(dl.status, 200);
        const sng = unpackSng(Buffer.from(await dl.arrayBuffer()));
        return { id, sng, chart: sng.files.get("notes.chart")!.toString("utf8") };
    }

    const heatWaves: SongIdentity = {
        title: "Heat Waves",
        artist: "Glass Animals",
        album: "Dreamland",
        genre: "Alternative",
        year: "2020",
        cover: { name: "album.jpg", data: JPEG },
    };

    try {
        await step("identified song: title/artist/album/genre/year land in both the .sng metadata and notes.chart, and the cover ships as album.jpg", async () => {
            shazam.calls.length = 0;
            shazam.result = heatWaves;
            shazam.throwError = null;
            const { sng, chart } = await convert();

            assert.strictEqual(shazam.calls.length, 1, "Shazam asked once");
            assert.ok(shazam.calls[0]!.endsWith("mystery_track01.wav"), "asked about the uploaded audio, not a stem");
            assert.strictEqual(sng.meta.get("name"), "Heat Waves");
            assert.strictEqual(sng.meta.get("artist"), "Glass Animals");
            assert.strictEqual(sng.meta.get("album"), "Dreamland");
            assert.strictEqual(sng.meta.get("genre"), "Alternative");
            assert.strictEqual(sng.meta.get("year"), "2020");
            for (const line of [`Name = "Heat Waves"`, `Artist = "Glass Animals"`, `Album = "Dreamland"`, `Genre = "Alternative"`, `Year = ", 2020"`]) {
                assert.ok(chart.includes(line), `notes.chart has ${line}`);
            }
            assert.ok(sng.files.get("album.jpg")?.equals(JPEG), "cover bytes shipped unchanged");
            assert.ok(sng.files.has("notes.chart") && sng.files.has("song.opus"));
        });

        await step("identified song without a cover: everything else is filled, no album file is packed", async () => {
            shazam.result = { title: "Heat Waves", artist: "Glass Animals" };
            const { sng, chart } = await convert();
            assert.strictEqual(sng.meta.get("name"), "Heat Waves");
            assert.strictEqual(sng.meta.get("album"), "audio2chart", "album falls back to the old default");
            assert.strictEqual(sng.meta.get("genre"), "Rock");
            assert.ok(!sng.meta.has("year"), "no year invented");
            assert.ok(!chart.includes("Year ="));
            assert.ok(![...sng.files.keys()].some((n) => n.startsWith("album.")));
        });

        await step("PNG cover ships as album.png", async () => {
            const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png")]);
            shazam.result = { ...heatWaves, cover: { name: "album.png", data: png } };
            const { sng } = await convert();
            assert.ok(sng.files.get("album.png")?.equals(png));
            assert.ok(!sng.files.has("album.jpg"));
        });

        await step("user-typed metadata wins per field; blanks are filled from the match; the cover still ships", async () => {
            shazam.result = heatWaves;
            const { sng, chart } = await convert({ metadata: { title: "My Cover Version", genre: "Pop", artist: "" } });
            assert.strictEqual(sng.meta.get("name"), "My Cover Version");
            assert.strictEqual(sng.meta.get("genre"), "Pop");
            assert.strictEqual(sng.meta.get("artist"), "Glass Animals");
            assert.strictEqual(sng.meta.get("album"), "Dreamland");
            assert.ok(chart.includes(`Name = "My Cover Version"`));
            assert.ok(chart.includes(`Genre = "Pop"`));
            assert.ok(sng.files.has("album.jpg"));
        });

        await step("typed metadata without any Shazam match is still used; the rest keeps the old defaults", async () => {
            shazam.result = null;
            const { sng } = await convert({ metadata: { title: "Typed Title", year: "1999" } });
            assert.strictEqual(sng.meta.get("name"), "Typed Title");
            assert.strictEqual(sng.meta.get("year"), "1999");
            assert.strictEqual(sng.meta.get("artist"), "Dolly");
            assert.strictEqual(sng.meta.get("album"), "audio2chart");
        });

        await step("no match: behaves exactly as before identification existed (file name as title, Dolly/audio2chart/Rock)", async () => {
            shazam.result = null;
            const { sng, chart } = await convert();
            assert.strictEqual(sng.meta.get("name"), "mystery_track01");
            assert.strictEqual(sng.meta.get("artist"), "Dolly");
            assert.strictEqual(sng.meta.get("album"), "audio2chart");
            assert.strictEqual(sng.meta.get("genre"), "Rock");
            assert.ok(chart.includes(`Artist = "Dolly"`));
            assert.ok(![...sng.files.keys()].some((n) => n.startsWith("album.")));
        });

        await step("Shazam blowing up (python missing, network down…) never fails the conversion", async () => {
            shazam.result = heatWaves;
            shazam.throwError = new Error("ModuleNotFoundError: shazamio");
            const { sng } = await convert();
            assert.strictEqual(sng.meta.get("name"), "mystery_track01");
            assert.strictEqual(sng.meta.get("artist"), "Dolly");
            shazam.throwError = null;
        });

        await step("worker externals without identifySong skip identification entirely (hermetic default)", async () => {
            shazam.calls.length = 0;
            shazam.wired = false;
            install();
            try {
                const { sng } = await convert();
                assert.strictEqual(shazam.calls.length, 0);
                assert.strictEqual(sng.meta.get("artist"), "Dolly");
            } finally {
                shazam.wired = true;
                install();
            }
        });

        await step("retry reuses the first lookup: a failed conversion that is retried does not ask Shazam again", async () => {
            shazam.calls.length = 0;
            shazam.result = heatWaves;
            let failOnce = true;
            setWorkerExternals({
                ...externals,
                createChartClient() {
                    return {
                        async generateText() {
                            if (failOnce) {
                                failOnce = false;
                                throw new Error("chart boom");
                            }
                            return FAKE_CHART;
                        },
                    };
                },
            });
            try {
                const created = await h.request<ConversionBody>("/v1/conversions", {
                    method: "POST",
                    token: alice.token,
                    json: { input_file_id: await seedFile(), instruments: ["guitar"] },
                });
                const id = created.json.conversion_id;
                await waitForStatus(id, "failed");
                assert.strictEqual(shazam.calls.length, 1);
                const retry = await h.request(`/v1/conversions/${id}/retry`, { method: "POST", token: alice.token });
                assert.strictEqual(retry.status, 202, retry.text);
                await waitForStatus(id, "completed");
                assert.strictEqual(shazam.calls.length, 1, "second run used the cached identity");
                const dl = await fetch(`${h.base}/v1/conversions/${id}/download`, { headers: { authorization: `Bearer ${alice.token}` } });
                const sng = unpackSng(Buffer.from(await dl.arrayBuffer()));
                assert.strictEqual(sng.meta.get("name"), "Heat Waves");
                assert.ok(sng.files.get("album.jpg")?.equals(JPEG), "cached cover is packed after the retry");
            } finally {
                install();
            }
        });

        await step("POST /v1/conversions rejects malformed metadata with 422 and creates nothing", async () => {
            const before = (await h.sql`SELECT COUNT(*)::int AS n FROM conversions`)[0]!.n;
            const inputId = await seedFile();
            const bad: unknown[] = ["title", [], { title: 5 }, { bogus: "x" }, { year: "MCMXCIX" }, { artist: "x".repeat(201) }];
            for (const metadata of bad) {
                const res = await h.request<ApiError>("/v1/conversions", {
                    method: "POST",
                    token: alice.token,
                    json: { input_file_id: inputId, instruments: ["guitar"], metadata },
                });
                assert.strictEqual(res.status, 422, `${JSON.stringify(metadata)} → ${res.text}`);
                assert.strictEqual(res.json.error.code, "INVALID_INPUT");
                assert.match(res.json.error.message, /metadata/);
            }
            assert.strictEqual((await h.sql`SELECT COUNT(*)::int AS n FROM conversions`)[0]!.n, before);
        });

        await step("typed metadata is persisted on the upload task (so retries/resumes keep it); none typed leaves settings empty", async () => {
            const withMeta = await h.request<ConversionBody>("/v1/conversions", {
                method: "POST",
                token: alice.token,
                json: { input_file_id: await seedFile(), instruments: ["guitar"], metadata: { title: " Trim Me ", album: "" } },
            });
            const without = await h.request<ConversionBody>("/v1/conversions", {
                method: "POST",
                token: alice.token,
                json: { input_file_id: await seedFile(), instruments: ["guitar"] },
            });
            const settingsOf = async (id: string): Promise<unknown> =>
                (await h.sql`
                    SELECT t.settings FROM tasks t JOIN conversion_tasks ct ON ct.task_id = t.task_id
                    WHERE ct.conversion_id = ${id} AND t.type = 'upload_s3'`)[0]!.settings;
            assert.deepStrictEqual(await settingsOf(withMeta.json.conversion_id), { metadata: { title: "Trim Me" } });
            assert.deepStrictEqual(await settingsOf(without.json.conversion_id), {});
            // Let both background conversions finish before the harness removes their work dir.
            await waitForStatus(withMeta.json.conversion_id, "completed");
            await waitForStatus(without.json.conversion_id, "completed");
        });
    } finally {
        setWorkerExternals(null);
        await h.close();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error("Runner error:", error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
});
