import { Router } from "express";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import multer from "multer";
import { requireAuth } from "../middleware.js";
import {
    dbInsertFile,
    dbGetFile,
    dbListFiles,
    dbDeleteFile,
    dbIsFileInUse,
    dbUpdateFileBpm,
} from "../db-helpers.js";
import { detectBpm } from "../../bpm.js";
import type { FileRecord } from "../types.js";

export const filesRouter = Router();

// ── Multer setup ────────────────────────────────────────────────────────

const uploadDir = path.join(os.tmpdir(), "dolly-files");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${crypto.randomUUID()}${ext}`);
    },
});

const SUPPORTED_MIMES = new Set([
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp3",
    "audio/flac",
    "audio/ogg",
    "application/octet-stream",
]);

const upload = multer({
    storage,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
    fileFilter: (_req, file, cb) => {
        if (SUPPORTED_MIMES.has(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported MIME type: ${file.mimetype}`));
        }
    },
});

filesRouter.use(requireAuth);

// ── POST /files/upload ──────────────────────────────────────────────────

filesRouter.post("/upload", upload.single("file"), async (req, res) => {
    if (!req.file) {
        res.status(400).json({
            error: { code: "BAD_REQUEST", message: "Missing required field: file" },
        });
        return;
    }

    const name = (req.body.name as string | undefined) ?? req.file.originalname;

    // Detect the tempo up front so the dashboard can seed its metronome the
    // moment the upload returns. A detection failure must not fail the upload —
    // the user can still set the BPM by hand via PATCH.
    let bpm: number | null = null;
    try {
        const result = await detectBpm(req.file.path);
        bpm = result.bpm;
    } catch (err) {
        console.warn(
            `[files] BPM detection failed for ${req.file.originalname}:`,
            err instanceof Error ? err.message : err,
        );
    }

    const record: FileRecord = {
        file_id: `file_${crypto.randomUUID().slice(0, 8)}`,
        user_id: req.auth!.user_id,
        name,
        size_bytes: req.file.size,
        mime_type: req.file.mimetype,
        created_at: new Date().toISOString(),
        bpm,
        local_path: req.file.path,
    };

    await dbInsertFile(record);

    res.status(201).json({
        file_id: record.file_id,
        name: record.name,
        size_bytes: record.size_bytes,
        mime_type: record.mime_type,
        bpm: record.bpm,
        created_at: record.created_at,
    });
});

// ── PATCH /files/:file_id ───────────────────────────────────────────────
// Update the confirmed tempo after the user verifies it against the metronome.

filesRouter.patch("/:file_id", async (req, res) => {
    const record = await dbGetFile(req.params.file_id);
    if (!record || record.user_id !== req.auth!.user_id) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "File not found" },
        });
        return;
    }

    const { bpm } = req.body as { bpm?: unknown };
    if (bpm === undefined) {
        res.status(400).json({
            error: { code: "BAD_REQUEST", message: "Nothing to update (expected: bpm)" },
        });
        return;
    }

    let value: number | null;
    if (bpm === null) {
        value = null;
    } else {
        const n = Number(bpm);
        if (!Number.isFinite(n) || n <= 0 || n > 400) {
            res.status(400).json({
                error: { code: "BAD_REQUEST", message: "bpm must be a number between 1 and 400, or null" },
            });
            return;
        }
        // Allow fractional BPM but keep it tidy.
        value = Math.round(n * 100) / 100;
    }

    await dbUpdateFileBpm(record.file_id, value);

    res.json({
        file_id: record.file_id,
        name: record.name,
        size_bytes: record.size_bytes,
        mime_type: record.mime_type,
        bpm: value,
        created_at: record.created_at,
    });
});

// ── GET /files/:file_id ─────────────────────────────────────────────────

filesRouter.get("/:file_id", async (req, res) => {
    const record = await dbGetFile(req.params.file_id);
    if (!record || record.user_id !== req.auth!.user_id) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "File not found" },
        });
        return;
    }

    res.json({
        file_id: record.file_id,
        name: record.name,
        size_bytes: record.size_bytes,
        mime_type: record.mime_type,
        bpm: record.bpm ?? null,
        kind: record.kind ?? "source",
        created_at: record.created_at,
        download_url: `/v1/files/${record.file_id}/download`,
    });
});

// ── GET /files/:file_id/download ────────────────────────────────────────

filesRouter.get("/:file_id/download", async (req, res) => {
    const record = await dbGetFile(req.params.file_id);
    if (!record || record.user_id !== req.auth!.user_id) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "File not found" },
        });
        return;
    }

    if (!fs.existsSync(record.local_path)) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "File data missing from storage" },
        });
        return;
    }

    res.download(record.local_path, record.name);
});

// ── GET /files ──────────────────────────────────────────────────────────

filesRouter.get("/", async (req, res) => {
    const userId = req.auth!.user_id;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string, 10) || 20));
    const sort = (req.query.sort as string) ?? "created_at";
    const order = (req.query.order as string) === "asc" ? "asc" : "desc";

    const { files, total } = await dbListFiles(userId, page, perPage, sort, order);

    res.json({
        files: files.map((f) => ({
            file_id: f.file_id,
            name: f.name,
            size_bytes: f.size_bytes,
            mime_type: f.mime_type,
            bpm: f.bpm ?? null,
            kind: f.kind ?? "source",
            created_at: f.created_at,
        })),
        total,
        page,
        per_page: perPage,
    });
});

// ── DELETE /files/:file_id ──────────────────────────────────────────────

filesRouter.delete("/:file_id", async (req, res) => {
    const record = await dbGetFile(req.params.file_id);
    if (!record || record.user_id !== req.auth!.user_id) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "File not found" },
        });
        return;
    }

    if (await dbIsFileInUse(record.file_id)) {
        res.status(409).json({
            error: { code: "CONFLICT", message: "File is in use by an active task" },
        });
        return;
    }

    try {
        fs.unlinkSync(record.local_path);
    } catch { /* ignore */ }

    await dbDeleteFile(record.file_id);
    res.status(204).end();
});
