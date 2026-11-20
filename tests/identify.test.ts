/**
 * Unit tests for song identification (src/identify.ts).
 *
 * Hermetic: ffmpeg runs for real on a generated WAV, the Python/ShazamIO script is replaced
 * by a tiny Node stub, and cover downloads go through an injected fetch. Nothing touches
 * Shazam or the network.
 *
 * Usage:  npx tsx tests/identify.test.ts
 */

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    cleanText,
    enlargeCoverUrl,
    fetchCoverArt,
    identifySong,
    identifyWithCache,
    parseMatch,
    resolveSongMetadata,
    validateUserSongMetadata,
    type SongIdentity,
} from "../src/identify.js";
import { WORK_ROOT, writeSilentWav } from "./helpers/harness.js";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);

function respond(body: Buffer | string, init: ResponseInit = {}): Response {
    return new Response(typeof body === "string" ? body : new Uint8Array(body), init);
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

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dolly-identify-"));
    const noLog = (): void => {};

    try {
        // ── parseMatch ──────────────────────────────────────────────────
        await step("parseMatch: full payload maps every field", () => {
            assert.deepStrictEqual(
                parseMatch({ title: "Heat Waves", artist: "Glass Animals", album: "Dreamland", genre: "Alternative", year: "2020", cover_url: "https://x/y.jpg" }),
                { title: "Heat Waves", artist: "Glass Animals", album: "Dreamland", genre: "Alternative", year: "2020", coverUrl: "https://x/y.jpg" },
            );
        });

        await step("parseMatch: null (no match) and payloads without title+artist are rejected", () => {
            for (const bad of [null, undefined, "x", 7, [], {}, { title: "T" }, { artist: "A" }, { title: " ", artist: "A" }, { title: "T", artist: 3 }]) {
                assert.strictEqual(parseMatch(bad), null, JSON.stringify(bad));
            }
        });

        await step("parseMatch: optional fields are dropped when blank or malformed; year must be 4 digits", () => {
            const m = parseMatch({ title: "T", artist: "A", album: "  ", genre: 5, year: "20x0", cover_url: "" })!;
            assert.deepStrictEqual(m, { title: "T", artist: "A", album: undefined, genre: undefined, year: undefined, coverUrl: undefined });
        });

        // ── resolveSongMetadata ─────────────────────────────────────────
        const identity: SongIdentity = { title: "Heat Waves", artist: "Glass Animals", album: "Dreamland", genre: "Alternative", year: "2020" };

        await step("resolve: identified values fill every field when the user typed nothing", () => {
            assert.deepStrictEqual(resolveSongMetadata(undefined, identity, "file name"), {
                title: "Heat Waves", artist: "Glass Animals", album: "Dreamland", genre: "Alternative", year: "2020",
            });
        });

        await step("resolve: user-typed values win per field; blanks are filled from the match", () => {
            const r = resolveSongMetadata({ title: "My Title", genre: "Pop", artist: "  " }, identity, "file name");
            assert.strictEqual(r.title, "My Title");
            assert.strictEqual(r.genre, "Pop");
            assert.strictEqual(r.artist, "Glass Animals");
            assert.strictEqual(r.album, "Dreamland");
            assert.strictEqual(r.year, "2020");
        });

        await step("resolve: no match keeps Dolly's old defaults and the file name as title; no year invented", () => {
            assert.deepStrictEqual(resolveSongMetadata(undefined, null, "my_upload"), {
                title: "my_upload", artist: "Dolly", album: "audio2chart", genre: "Rock", year: undefined,
            });
        });

        await step("resolve: a match without album/genre/year falls back per field", () => {
            const r = resolveSongMetadata(undefined, { title: "T", artist: "A" }, "f");
            assert.deepStrictEqual(r, { title: "T", artist: "A", album: "audio2chart", genre: "Rock", year: undefined });
        });

        // ── validateUserSongMetadata ────────────────────────────────────
        await step("validate metadata: absent → nothing; valid fields trimmed; blank fields dropped", () => {
            assert.deepStrictEqual(validateUserSongMetadata(undefined), { ok: true, value: undefined });
            assert.deepStrictEqual(validateUserSongMetadata(null), { ok: true, value: undefined });
            assert.deepStrictEqual(validateUserSongMetadata({ title: " Hi ", artist: "", year: "1999" }), {
                ok: true,
                value: { title: "Hi", year: "1999" },
            });
            assert.deepStrictEqual(validateUserSongMetadata({ album: "   " }), { ok: true, value: undefined });
        });

        await step("validate metadata: wrong shapes, unknown keys, bad year and over-long values are rejected", () => {
            const bad: unknown[] = ["str", 3, [], { title: 5 }, { nope: "x" }, { year: "99" }, { year: "20201" }, { title: "x".repeat(201) }];
            for (const raw of bad) {
                const r = validateUserSongMetadata(raw);
                assert.strictEqual(r.ok, false, JSON.stringify(raw));
            }
            assert.deepStrictEqual(validateUserSongMetadata({ title: "x".repeat(200) }).ok, true);
        });

        await step("quotes and newlines are neutralised in every source: Shazam, typed values and the file name", () => {
            assert.strictEqual(cleanText('  Don\'t Stop "Believin\'"\n\t(Live)  '), "Don't Stop 'Believin'' (Live)");
            const m = parseMatch({ title: '"Heroes"', artist: 'A\r\nB', album: 'x "y"' })!;
            assert.deepStrictEqual([m.title, m.artist, m.album], ["'Heroes'", "A B", "x 'y'"]);
            const v = validateUserSongMetadata({ title: 'Say "Hi"\nthere' });
            assert.deepStrictEqual(v, { ok: true, value: { title: "Say 'Hi' there" } });
            const r = resolveSongMetadata(undefined, { title: 'T "1"', artist: "A\nB" }, 'my "file"');
            assert.deepStrictEqual([r.title, r.artist], ["T '1'", "A B"]);
            assert.strictEqual(resolveSongMetadata(undefined, null, 'my "file"').title, "my 'file'");
            assert.strictEqual(resolveSongMetadata(undefined, null, '""').title, "''");
            assert.strictEqual(resolveSongMetadata(undefined, null, "  ").title, "Dolly Song");
        });

        // ── cover art ───────────────────────────────────────────────────
        await step("enlargeCoverUrl: swaps the size segment of Apple image URLs and leaves others alone", () => {
            assert.strictEqual(enlargeCoverUrl("https://is1.mzstatic.com/a/b/400x400cc.jpg"), "https://is1.mzstatic.com/a/b/1000x1000cc.jpg");
            assert.strictEqual(enlargeCoverUrl("https://cdn.example/cover.jpg"), "https://cdn.example/cover.jpg");
        });

        await step("fetchCoverArt: asks for the large rendition first and returns a JPEG as album.jpg", async () => {
            const urls: string[] = [];
            const cover = await fetchCoverArt("https://img.test/x/400x400cc.jpg", async (u) => {
                urls.push(String(u));
                return respond(JPEG);
            });
            assert.deepStrictEqual(urls, ["https://img.test/x/1000x1000cc.jpg"]);
            assert.strictEqual(cover?.name, "album.jpg");
            assert.ok(cover!.data.equals(JPEG));
        });

        await step("fetchCoverArt: PNG is named album.png", async () => {
            const cover = await fetchCoverArt("https://img.test/cover.png", async () => respond(PNG));
            assert.strictEqual(cover?.name, "album.png");
        });

        await step("fetchCoverArt: falls back to the original URL when the large rendition fails", async () => {
            const urls: string[] = [];
            const cover = await fetchCoverArt("https://img.test/x/400x400cc.jpg", async (u) => {
                urls.push(String(u));
                return String(u).includes("1000x1000") ? respond("nope", { status: 404 }) : respond(JPEG);
            });
            assert.deepStrictEqual(urls, ["https://img.test/x/1000x1000cc.jpg", "https://img.test/x/400x400cc.jpg"]);
            assert.strictEqual(cover?.name, "album.jpg");
        });

        await step("fetchCoverArt: non-https, HTTP errors, network errors, HTML bodies and oversized images yield null", async () => {
            let calls = 0;
            assert.strictEqual(await fetchCoverArt("http://img.test/a.jpg", async () => { calls++; return respond(JPEG); }), null);
            assert.strictEqual(calls, 0, "plain http is never requested");
            assert.strictEqual(await fetchCoverArt("https://img.test/a.jpg", async () => respond("x", { status: 500 })), null);
            assert.strictEqual(await fetchCoverArt("https://img.test/a.jpg", async () => { throw new Error("offline"); }), null);
            assert.strictEqual(await fetchCoverArt("https://img.test/a.jpg", async () => respond("<html>blocked</html>")), null);
            const huge = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]);
            assert.strictEqual(await fetchCoverArt("https://img.test/a.jpg", async () => respond(huge)), null);
            assert.strictEqual(
                await fetchCoverArt("https://img.test/a.jpg", async () => respond(JPEG, { headers: { "content-length": String(50 * 1024 * 1024) } })),
                null,
            );
        });

        // ── identifySong end to end with a stub "python" ────────────────
        const song = path.join(tmp, "song.wav");
        writeSilentWav(song, 40);
        const stubDir = path.join(tmp, "stub");
        fs.mkdirSync(stubDir);
        // The stub gets the snippet path as argv[2], like identify_song.py does. It records
        // what it was given so the test can check the snippet really is a mono 44.1k WAV.
        const stub = (name: string, body: string): string => {
            const p = path.join(stubDir, name);
            fs.writeFileSync(p, body);
            return p;
        };
        const okStub = stub(
            "ok.cjs",
            `const fs=require("fs");const b=fs.readFileSync(process.argv[2]);
fs.writeFileSync(process.argv[2]+".seen",JSON.stringify({riff:b.toString("ascii",0,4),channels:b.readUInt16LE(22),rate:b.readUInt32LE(24),bytes:b.length}));
console.log(JSON.stringify({title:"Heat Waves",artist:"Glass Animals",album:"Dreamland",genre:"Alternative",year:"2020",cover_url:"https://img.test/x/400x400cc.jpg"}));`,
        );
        const nullStub = stub("null.cjs", `console.log("null");`);
        const failStub = stub("fail.cjs", `console.error("ModuleNotFoundError: shazamio");process.exit(1);`);
        const junkStub = stub("junk.cjs", `console.log("not json");`);

        await step("identifySong: cuts a mono 44.1 kHz WAV snippet, parses the match and attaches the cover; snippet is cleaned up", async () => {
            const work = path.join(tmp, "w1");
            let seen: { riff: string; channels: number; rate: number; bytes: number } | undefined;
            const result = await identifySong(song, {
                workDir: work,
                pythonBin: process.execPath,
                scriptPath: okStub,
                fetchFn: async () => respond(JPEG),
            });
            seen = JSON.parse(fs.readFileSync(path.join(work, "identify_snippet.wav.seen"), "utf8"));
            assert.strictEqual(seen!.riff, "RIFF");
            assert.strictEqual(seen!.channels, 1);
            assert.strictEqual(seen!.rate, 44100);
            assert.ok(seen!.bytes > 44100 * 2 * 10, "about 12 s of audio was cut");
            assert.strictEqual(result?.title, "Heat Waves");
            assert.strictEqual(result?.artist, "Glass Animals");
            assert.strictEqual(result?.year, "2020");
            assert.strictEqual(result?.cover?.name, "album.jpg");
            assert.ok(!fs.existsSync(path.join(work, "identify_snippet.wav")), "snippet removed");
        });

        await step("identifySong: a match with an unusable cover still returns the match, without cover", async () => {
            const result = await identifySong(song, {
                workDir: path.join(tmp, "w2"),
                pythonBin: process.execPath,
                scriptPath: okStub,
                fetchFn: async () => respond("<html/>"),
            });
            assert.strictEqual(result?.title, "Heat Waves");
            assert.strictEqual(result?.cover, undefined);
        });

        await step("identifySong: Shazam 'no match' → null", async () => {
            const result = await identifySong(song, { workDir: path.join(tmp, "w3"), pythonBin: process.execPath, scriptPath: nullStub });
            assert.strictEqual(result, null);
        });

        await step("identifySong: script failure, non-JSON output, missing interpreter and undecodable audio all throw (caller degrades)", async () => {
            const base = { pythonBin: process.execPath };
            await assert.rejects(identifySong(song, { ...base, workDir: path.join(tmp, "w4"), scriptPath: failStub }), /ModuleNotFoundError: shazamio/, "the script's stderr is the error message");
            await assert.rejects(identifySong(song, { ...base, workDir: path.join(tmp, "w5"), scriptPath: junkStub }));
            await assert.rejects(identifySong(song, { workDir: path.join(tmp, "w6"), pythonBin: path.join(tmp, "no-such-python"), scriptPath: okStub }));
            const garbage = path.join(tmp, "garbage.mp3");
            fs.writeFileSync(garbage, "not audio at all");
            await assert.rejects(identifySong(garbage, { ...base, workDir: path.join(tmp, "w7"), scriptPath: okStub }));
            assert.ok(!fs.existsSync(path.join(tmp, "w4", "identify_snippet.wav")), "snippet removed even on failure");
        });

        await step("identifySong: SONG_IDENTIFY=off skips everything (no ffmpeg, no script)", async () => {
            process.env.SONG_IDENTIFY = "off";
            try {
                const result = await identifySong(path.join(tmp, "does-not-exist.wav"), { workDir: path.join(tmp, "w8"), pythonBin: "/nope", scriptPath: "/nope" });
                assert.strictEqual(result, null);
            } finally {
                delete process.env.SONG_IDENTIFY;
            }
        });

        // ── identifyWithCache ───────────────────────────────────────────
        await step("identifyWithCache: a match (with cover) is looked up once and reused byte-for-byte", async () => {
            const dir = path.join(tmp, "c1");
            let lookups = 0;
            const lookup = async (): Promise<SongIdentity | null> => {
                lookups++;
                return { ...identity, cover: { name: "album.jpg", data: JPEG } };
            };
            const first = await identifyWithCache(lookup, dir, noLog);
            const second = await identifyWithCache(lookup, dir, noLog);
            assert.strictEqual(lookups, 1);
            assert.deepStrictEqual({ ...second, cover: undefined }, { ...first, cover: undefined });
            assert.strictEqual(second?.cover?.name, "album.jpg");
            assert.ok(second!.cover!.data.equals(JPEG));
        });

        await step("identifyWithCache: 'no match' is cached too", async () => {
            const dir = path.join(tmp, "c2");
            let lookups = 0;
            const lookup = async (): Promise<SongIdentity | null> => { lookups++; return null; };
            assert.strictEqual(await identifyWithCache(lookup, dir, noLog), null);
            assert.strictEqual(await identifyWithCache(lookup, dir, noLog), null);
            assert.strictEqual(lookups, 1);
        });

        await step("identifyWithCache: a failed lookup yields null, is NOT cached, and a later retry can succeed", async () => {
            const dir = path.join(tmp, "c3");
            const logs: string[] = [];
            const failed = await identifyWithCache(async () => { throw new Error("network down\nstack…"); }, dir, (m) => logs.push(m));
            assert.strictEqual(failed, null);
            assert.ok(logs.some((l) => l.includes("network down")), "reason is logged");
            const retry = await identifyWithCache(async () => identity, dir, noLog);
            assert.strictEqual(retry?.title, "Heat Waves");
        });

        await step("identifyWithCache: a corrupt cache file is ignored and replaced; an unwritable cache dir does not fail the lookup", async () => {
            const dir = path.join(tmp, "c4");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "song_identity.json"), "{ not json");
            const r = await identifyWithCache(async () => identity, dir, noLog);
            assert.strictEqual(r?.title, "Heat Waves");

            const blocked = path.join(tmp, "c5-is-a-file");
            fs.writeFileSync(blocked, "x");
            const r2 = await identifyWithCache(async () => identity, blocked, noLog);
            assert.strictEqual(r2?.title, "Heat Waves");
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(WORK_ROOT, { recursive: true, force: true }); // created by the harness import
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error("Runner error:", error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
});
