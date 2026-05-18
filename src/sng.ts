/**
 * SNG file packer — produces Clone Hero .sng archives.
 *
 * The .sng format is a binary container invented by mdsitton / Clone Hero.
 * Specification: https://github.com/mdsitton/SngFileFormat
 *
 * Layout:
 *   [magic: "SNGPKG" (6 B)] [version: uint8 = 1] [xor_mask: 8 B]
 *   [file_count: uint64 LE]
 *   For each file:
 *     [data_index: uint64 LE]  ← byte offset within the file-data blob
 *     [name_len: uint16 LE] [name: UTF-8]
 *   [file_data_blob]           ← all file contents concatenated, XOR-masked
 *   [meta_len: uint32 LE] [metadata: JSON UTF-8, XOR-masked]
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
const VERSION = 1; // uint8

/**
 * Pack a list of files + metadata into a .sng archive buffer.
 */
export function packSng(entries: SngEntry[], metadata: SngMetadata = {}): Buffer {
    const xorMask = crypto.randomBytes(8);

    // ── Build the file-data blob (XOR-masked) ────────────────────────────
    const maskedParts: Buffer[] = [];
    const dataIndexes: bigint[] = [];
    let cursor = 0n;

    for (const entry of entries) {
        dataIndexes.push(cursor);
        const masked = xorMaskBuffer(entry.data, xorMask);
        maskedParts.push(masked);
        cursor += BigInt(entry.data.length);
    }

    const fileDataBlob = Buffer.concat(maskedParts);

    // ── Build the file table ─────────────────────────────────────────────
    const fileTableParts: Buffer[] = [];
    for (let i = 0; i < entries.length; i++) {
        const nameBytes = Buffer.from(entries[i]!.name, "utf8");
        const entry = Buffer.alloc(8 + 2 + nameBytes.length);
        entry.writeBigUInt64LE(dataIndexes[i]!, 0);
        entry.writeUInt16LE(nameBytes.length, 8);
        nameBytes.copy(entry, 10);
        fileTableParts.push(entry);
    }

    // ── Build the metadata section ────────────────────────────────────────
    const metaJson = JSON.stringify(metadata);
    const metaBytes = xorMaskBuffer(Buffer.from(metaJson, "utf8"), xorMask);
    const metaLenBuf = Buffer.alloc(4);
    metaLenBuf.writeUInt32LE(metaBytes.length);

    // ── Assemble header ───────────────────────────────────────────────────
    // magic(6) + version(1) + xorMask(8) + file_count(8) = 23 bytes
    const header = Buffer.alloc(23);
    MAGIC.copy(header, 0);
    header[6] = VERSION;
    xorMask.copy(header, 7);
    header.writeBigUInt64LE(BigInt(entries.length), 15);

    return Buffer.concat([
        header,
        ...fileTableParts,
        fileDataBlob,
        metaLenBuf,
        metaBytes,
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

function xorMaskBuffer(data: Buffer, mask: Buffer): Buffer {
    const out = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i++) {
        out[i] = data[i]! ^ mask[i % 8]!;
    }
    return out;
}
