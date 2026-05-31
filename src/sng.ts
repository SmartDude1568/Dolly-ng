/**
 * SNG file packer — produces Clone Hero .sng archives.
 *
 * The .sng format is a binary container invented by mdsitton / Clone Hero.
 * Specification: https://github.com/mdsitton/SngFileFormat (little-endian).
 *
 * Layout (in order):
 *   Header:
 *     [fileIdentifier: "SNGPKG" (6 B)] [version: uint32 LE] [xorMask: 16 B]
 *   Metadata section:
 *     [metadataLen: uint64 LE]   ← byte count of everything after this field
 *     [metadataCount: uint64 LE]
 *     per pair: [keyLen: int32 LE] [key] [valueLen: int32 LE] [value]
 *   FileIndex section:
 *     [fileMetaLen: uint64 LE]   ← byte count of everything after this field
 *     [fileCount: uint64 LE]
 *     per file: [filenameLen: uint8] [filename]
 *               [contentsLen: uint64 LE]
 *               [contentsIndex: uint64 LE]  ← ABSOLUTE byte offset in the file
 *   FileData section:
 *     [fileDataLen: uint64 LE] [maskedFiles…]
 *
 * File contents are XOR-masked. For each file, using the per-file byte index i:
 *   xorKey   = xorMask[i % 16] ^ (i & 0xFF)
 *   masked[i] = data[i] ^ xorKey   (symmetric — same op unmasks)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface SngEntry {
    /** Path inside the archive (e.g. "notes.chart", "guitar.ogg"). */
    name: string;
    /** Raw file content. */
    data: Buffer;
}

export interface SngMetadata {
    /** Song title. */
    name?: string;
    artist?: string;
    album?: string;
    genre?: string;
    year?: string;
    charter?: string;
    /** Optional playlist / sub-directory hint for Clone Hero. */
    playlist?: string;
    [key: string]: string | undefined;
}

const MAGIC = Buffer.from("SNGPKG", "ascii"); // 6 bytes
const VERSION = 1; // uint32 LE

/**
 * Pack a list of files + metadata into a .sng archive buffer.
 */
export function packSng(entries: SngEntry[], metadata: SngMetadata = {}): Buffer {
    const xorMask = crypto.randomBytes(16);

    // ── Header ────────────────────────────────────────────────────────────
    const header = Buffer.alloc(6 + 4 + 16);
    MAGIC.copy(header, 0);
    header.writeUInt32LE(VERSION, 6);
    xorMask.copy(header, 10);

    // ── Metadata section ──────────────────────────────────────────────────
    const metaPairs: Buffer[] = [];
    let metaCount = 0n;
    for (const [key, value] of Object.entries(metadata)) {
        if (value === undefined) continue;
        const k = Buffer.from(key, "utf8");
        const v = Buffer.from(String(value), "utf8");
        const pair = Buffer.alloc(4 + k.length + 4 + v.length);
        pair.writeInt32LE(k.length, 0);
        k.copy(pair, 4);
        pair.writeInt32LE(v.length, 4 + k.length);
        v.copy(pair, 4 + k.length + 4);
        metaPairs.push(pair);
        metaCount += 1n;
    }
    const metaPairsBuf = Buffer.concat(metaPairs);
    const metaCountBuf = Buffer.alloc(8);
    metaCountBuf.writeBigUInt64LE(metaCount);
    const metaLenBuf = Buffer.alloc(8);
    metaLenBuf.writeBigUInt64LE(BigInt(8 + metaPairsBuf.length)); // count + pairs

    // Name buffers + fixed-size file-index length (each FileMeta is
    // 1 + nameLen + 8 + 8 bytes), needed to compute where the FileData blob
    // begins. contentsIndex is an ABSOLUTE offset into the .sng file.
    const nameBufs = entries.map((e) => {
        const nb = Buffer.from(e.name, "utf8");
        if (nb.length > 255) throw new Error(`SNG filename too long (>255 bytes): ${e.name}`);
        return nb;
    });
    const fileMetasLen = nameBufs.reduce((s, nb) => s + 1 + nb.length + 8 + 8, 0);

    const headerLen = 6 + 4 + 16; // 26
    const metaSectionLen = 8 /*metaLen*/ + 8 /*count*/ + metaPairsBuf.length;
    const indexSectionLen = 8 /*fileMetaLen*/ + 8 /*count*/ + fileMetasLen;
    const blobStart = headerLen + metaSectionLen + indexSectionLen + 8 /*fileDataLen*/;

    // ── FileData blob (XOR-masked per file) + ABSOLUTE contents indexes ───
    const maskedParts: Buffer[] = [];
    const contentsIndexes: bigint[] = [];
    let cursor = BigInt(blobStart);
    for (const entry of entries) {
        contentsIndexes.push(cursor);
        maskedParts.push(maskBuffer(entry.data, xorMask));
        cursor += BigInt(entry.data.length);
    }
    const fileDataBlob = Buffer.concat(maskedParts);

    // ── FileIndex section ─────────────────────────────────────────────────
    const fileMetas: Buffer[] = [];
    for (let i = 0; i < entries.length; i++) {
        const nameBytes = nameBufs[i]!;
        const meta = Buffer.alloc(1 + nameBytes.length + 8 + 8);
        meta.writeUInt8(nameBytes.length, 0);
        nameBytes.copy(meta, 1);
        meta.writeBigUInt64LE(BigInt(entries[i]!.data.length), 1 + nameBytes.length);
        meta.writeBigUInt64LE(contentsIndexes[i]!, 1 + nameBytes.length + 8);
        fileMetas.push(meta);
    }
    const fileMetasBuf = Buffer.concat(fileMetas);
    const fileCountBuf = Buffer.alloc(8);
    fileCountBuf.writeBigUInt64LE(BigInt(entries.length));
    const fileMetaLenBuf = Buffer.alloc(8);
    fileMetaLenBuf.writeBigUInt64LE(BigInt(8 + fileMetasBuf.length)); // count + metas

    const fileDataLenBuf = Buffer.alloc(8);
    fileDataLenBuf.writeBigUInt64LE(BigInt(fileDataBlob.length));

    return Buffer.concat([
        header,
        metaLenBuf,
        metaCountBuf,
        metaPairsBuf,
        fileMetaLenBuf,
        fileCountBuf,
        fileMetasBuf,
        fileDataLenBuf,
        fileDataBlob,
    ]);
}

/**
 * Build a .sng archive from a song directory.
 *
 * Reads the following files if present:
 *   notes.chart        — required chart file
 *   *.ogg / *.mp3      — audio stems
 *   song.ini           — extra metadata (name, artist, etc.)
 *   album.png / album.jpg — album art
 */
export function packSngFromDir(songDir: string, metadata: SngMetadata = {}): Buffer {
    const entries: SngEntry[] = [];

    const files = fs.readdirSync(songDir);
    for (const filename of files) {
        const ext = path.extname(filename).toLowerCase();
        const allowed = new Set([".chart", ".mid", ".ogg", ".mp3", ".ini", ".png", ".jpg", ".jpeg"]);
        if (!allowed.has(ext)) continue;

        const filePath = path.join(songDir, filename);
        const data = fs.readFileSync(filePath);
        entries.push({ name: filename, data });
    }

    if (entries.length === 0) {
        throw new Error(`No packable files found in directory: ${songDir}`);
    }

    return packSng(entries, metadata);
}

/**
 * Write a .sng archive to disk from a song directory.
 *
 * @param songDir   Directory containing notes.chart and audio stems.
 * @param outputPath  Where to write the .sng file.
 * @param metadata   Optional song metadata to embed.
 */
export function writeSngFromDir(
    songDir: string,
    outputPath: string,
    metadata: SngMetadata = {},
): void {
    const buffer = packSngFromDir(songDir, metadata);
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, buffer);
}

// ── Utilities ─────────────────────────────────────────────────────────────

/**
 * XOR-mask a single file's bytes per the SNG spec. The index `i` is local to
 * the file (resets to 0 per file). Symmetric: the same call unmasks.
 */
function maskBuffer(data: Buffer, mask: Buffer): Buffer {
    const out = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i++) {
        const xorKey = mask[i % 16]! ^ (i & 0xff);
        out[i] = data[i]! ^ xorKey;
    }
    return out;
}
