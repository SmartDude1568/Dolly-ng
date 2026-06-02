/**
 * Unit tests for the SNG archive packer (src/sng.ts).
 *
 * Verifies the mdsitton .sng binary layout: the SNGPKG header, the metadata
 * section, the file index with ABSOLUTE content offsets, and the per-file XOR
 * masking. A small in-test unpacker reads the produced archive back and asserts
 * the round-tripped bytes match the originals.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";
import { fileURLToPath } from "node:url";
import { packSng, packSngFromDir, writeSngFromDir, type SngEntry } from "../src/sng.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "fixtures", "sng");

// ── In-test SNG unpacker ────────────────────────────────────────────────────

interface UnpackedSng {
    version: number;
    metadata: Record<string, string>;
    files: Map<string, Buffer>;
}

/** Reverse the packer: parse header + sections and unmask each file. */
function unpackSng(buf: Buffer): UnpackedSng {
    assert.strictEqual(buf.toString("ascii", 0, 6), "SNGPKG", "bad magic");
    const version = buf.readUInt32LE(6);
    const xorMask = buf.subarray(10, 26);

    let off = 26;
    // Metadata section
    const metaLen = buf.readBigUInt64LE(off); off += 8;
    const metaEnd = off + Number(metaLen);
    const metaCount = Number(buf.readBigUInt64LE(off)); off += 8;
    const metadata: Record<string, string> = {};
    for (let i = 0; i < metaCount; i++) {
        const kLen = buf.readInt32LE(off); off += 4;
        const key = buf.toString("utf8", off, off + kLen); off += kLen;
        const vLen = buf.readInt32LE(off); off += 4;
        const val = buf.toString("utf8", off, off + vLen); off += vLen;
        metadata[key] = val;
    }
    assert.strictEqual(off, metaEnd, "metadata length mismatch");

    // FileIndex section
    const fileMetaLen = buf.readBigUInt64LE(off); off += 8;
    const indexEnd = off + Number(fileMetaLen);
    const fileCount = Number(buf.readBigUInt64LE(off)); off += 8;
    const index: { name: string; len: number; abs: number }[] = [];
    for (let i = 0; i < fileCount; i++) {
        const nameLen = buf.readUInt8(off); off += 1;
        const name = buf.toString("utf8", off, off + nameLen); off += nameLen;
        const len = Number(buf.readBigUInt64LE(off)); off += 8;
        const abs = Number(buf.readBigUInt64LE(off)); off += 8;
        index.push({ name, len, abs });
    }
    assert.strictEqual(off, indexEnd, "file index length mismatch");

    // FileData section
    const fileDataLen = Number(buf.readBigUInt64LE(off)); off += 8;
    const blobStart = off;

    const files = new Map<string, Buffer>();
    for (const { name, len, abs } of index) {
        assert.ok(abs >= blobStart, `contentsIndex for ${name} should be absolute (>= blobStart)`);
        const masked = buf.subarray(abs, abs + len);
        const data = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) {
            const xorKey = xorMask[i % 16]! ^ (i & 0xff);
            data[i] = masked[i]! ^ xorKey;
        }
        files.set(name, data);
    }
    // The blob should cover exactly fileDataLen bytes.
    assert.strictEqual(buf.length - blobStart, fileDataLen, "file data length mismatch");

    return { version, metadata, files };
}

// ── Test runner ─────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
    fs.mkdirSync(TEST_DIR, { recursive: true });

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

    console.log("packSng");

    await test("should produce a valid SNGPKG header", () => {
        const buf = packSng([{ name: "notes.chart", data: Buffer.from("[Song]\n") }]);
        assert.strictEqual(buf.toString("ascii", 0, 6), "SNGPKG");
        assert.strictEqual(buf.readUInt32LE(6), 1, "version should be 1");
    });

    await test("should round-trip a single file's bytes through XOR masking", () => {
        const data = Buffer.from("hello clone hero", "utf8");
        const buf = packSng([{ name: "notes.chart", data }]);
        const out = unpackSng(buf);
        assert.ok(out.files.has("notes.chart"));
        assert.deepStrictEqual(out.files.get("notes.chart"), data);
    });

    await test("should round-trip multiple files independently", () => {
        const entries: SngEntry[] = [
            { name: "notes.chart", data: Buffer.from("[Song]\n{ Name = X }\n") },
            { name: "song.opus", data: crypto_random(5000) },
            { name: "stems/guitar.opus", data: crypto_random(1234) },
        ];
        const buf = packSng(entries);
        const out = unpackSng(buf);
        assert.strictEqual(out.files.size, 3);
        for (const e of entries) {
            assert.deepStrictEqual(out.files.get(e.name), e.data, `mismatch for ${e.name}`);
        }
    });

    await test("should mask the stored bytes (not store plaintext)", () => {
        // A run of identical bytes proves masking is applied: the per-index XOR
        // key varies, so the stored bytes must NOT all be equal.
        const data = Buffer.alloc(64, 0x41); // 64 × 'A'
        const buf = packSng([{ name: "a.bin", data }]);
        // Locate the blob and check it isn't a constant run.
        const out = unpackSng(buf); // also asserts it unmasks back to the original
        assert.deepStrictEqual(out.files.get("a.bin"), data);
        const idx = buf.indexOf(Buffer.from("a.bin")); // filename in index section
        assert.ok(idx >= 0);
        // The masked blob is at the tail; ensure not all 0x41.
        const tail = buf.subarray(buf.length - 64);
        assert.ok(tail.some((b) => b !== 0x41), "stored bytes should be masked, not plaintext");
    });

    await test("should embed metadata key/value pairs", () => {
        const buf = packSng([{ name: "notes.chart", data: Buffer.from("x") }], {
            name: "My Song",
            artist: "Dolly",
            charter: "Dolly (audio2chart)",
        });
        const out = unpackSng(buf);
        assert.strictEqual(out.metadata.name, "My Song");
        assert.strictEqual(out.metadata.artist, "Dolly");
        assert.strictEqual(out.metadata.charter, "Dolly (audio2chart)");
    });

    await test("should skip undefined metadata values", () => {
        const buf = packSng([{ name: "x", data: Buffer.from("y") }], {
            name: "Only Name",
            artist: undefined,
        });
        const out = unpackSng(buf);
        assert.strictEqual(out.metadata.name, "Only Name");
        assert.ok(!("artist" in out.metadata), "undefined value should be omitted");
    });

    await test("should record ABSOLUTE content offsets that point into the blob", () => {
        // unpackSng already asserts abs >= blobStart for every file; this test
        // documents the intent and exercises a multi-file archive.
        const buf = packSng([
            { name: "a", data: Buffer.from("aaaa") },
            { name: "b", data: Buffer.from("bbbbbb") },
        ]);
        const out = unpackSng(buf);
        assert.deepStrictEqual(out.files.get("a"), Buffer.from("aaaa"));
        assert.deepStrictEqual(out.files.get("b"), Buffer.from("bbbbbb"));
    });

    await test("should handle empty file content", () => {
        const buf = packSng([{ name: "empty", data: Buffer.alloc(0) }]);
        const out = unpackSng(buf);
        assert.strictEqual(out.files.get("empty")!.length, 0);
    });

    await test("should throw on a filename longer than 255 bytes", () => {
        const longName = "a".repeat(256);
        assert.throws(
            () => packSng([{ name: longName, data: Buffer.from("x") }]),
            /too long/i,
        );
    });

    console.log("\npackSngFromDir / writeSngFromDir");

    await test("should pack packable files from a directory", () => {
        const dir = path.join(TEST_DIR, "songdir");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "notes.chart"), "[Song]\n");
        fs.writeFileSync(path.join(dir, "guitar.ogg"), Buffer.from([1, 2, 3, 4]));
        fs.writeFileSync(path.join(dir, "ignore.txt"), "nope"); // not a packable ext

        const buf = packSngFromDir(dir, { name: "Dir Song" });
        const out = unpackSng(buf);
        assert.ok(out.files.has("notes.chart"));
        assert.ok(out.files.has("guitar.ogg"));
        assert.ok(!out.files.has("ignore.txt"), "non-packable extensions should be skipped");
        assert.strictEqual(out.metadata.name, "Dir Song");
    });

    await test("should throw when a directory has no packable files", () => {
        const dir = path.join(TEST_DIR, "emptydir");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "readme.txt"), "nothing here");
        assert.throws(() => packSngFromDir(dir), /No packable files/);
    });

    await test("writeSngFromDir should write a valid archive to disk", () => {
        const dir = path.join(TEST_DIR, "writedir");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "notes.chart"), "[Song]\n");
        const outPath = path.join(TEST_DIR, "nested", "out.sng");
        writeSngFromDir(dir, outPath, { name: "Written" });
        assert.ok(fs.existsSync(outPath));
        const out = unpackSng(fs.readFileSync(outPath));
        assert.ok(out.files.has("notes.chart"));
        assert.strictEqual(out.metadata.name, "Written");
    });

    // Cleanup
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        console.log("Warning: could not fully clean up SNG test fixtures.");
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

/** Deterministic-ish pseudo-random buffer (content correctness, not entropy). */
function crypto_random(n: number): Buffer {
    const b = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff;
    return b;
}

runTests().catch((error) => {
    console.error("Test runner error:", error);
    process.exit(1);
});
