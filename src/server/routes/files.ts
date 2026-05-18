import { Router } from "express";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import multer from "multer";
import { requireAuth } from "../middleware.js";
import { files, tasks } from "../stores.js";
import type { FileRecord, PaginationParams } from "../types.js";
import { TERMINAL_STATUSES } from "../types.js";

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

// All file routes require auth
filesRouter.use(requireAuth);

// ── POST /files/upload ──────────────────────────────────────────────────

filesRouter.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) {
        res.status(400).json({
            error: { code: "BAD_REQUEST", message: "Missing required field: file" },
        });
        return;
    }

    const name = (req.body.name as string | undefined) ?? req.file.originalname;

    const record: FileRecord = {
        file_id: `file_${crypto.randomUUID().slice(0, 8)}`,
        user_id: req.auth!.user_id,
        name,
        size_bytes: req.file.size,
        mime_type: req.file.mimetype,
        created_at: new Date().toISOString(),
        local_path: req.file.path,
    };

    files.set(record.file_id, record);

    res.status(201).json({
        file_id: record.file_id,
        name: record.name,
        size_bytes: record.size_bytes,
        mime_type: record.mime_type,
        created_at: record.created_at,
    });
});

// ── GET /files/:file_id ─────────────────────────────────────────────────

filesRouter.get("/:file_id", (req, res) => {
    const record = files.get(req.params.file_id);
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
        created_at: record.created_at,
        download_url: `/v1/files/${record.file_id}/download`,
    });
});

// ── GET /files/:file_id/download ────────────────────────────────────────

filesRouter.get("/:file_id/download", (req, res) => {
    const record = files.get(req.params.file_id);
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

filesRouter.get("/", (req, res) => {
    const userId = req.auth!.user_id;

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string, 10) || 20));
    const sort = (req.query.sort as string) ?? "created_at";
    const order = (req.query.order as string) === "asc" ? "asc" : "desc";

    let userFiles = [...files.values()].filter((f) => f.user_id === userId);

    // Sort
    userFiles.sort((a, b) => {
        const aRec: Record<string, unknown> = { ...a };
        const bRec: Record<string, unknown> = { ...b };
        const aVal = aRec[sort] as string | number;
        const bVal = bRec[sort] as string | number;
        if (aVal < bVal) return order === "asc" ? -1 : 1;
        if (aVal > bVal) return order === "asc" ? 1 : -1;
        return 0;
    });

    const total = userFiles.length;
    const start = (page - 1) * perPage;
    const paged = userFiles.slice(start, start + perPage);

    res.json({
        files: paged.map((f) => ({
            file_id: f.file_id,
            name: f.name,
            size_bytes: f.size_bytes,
            mime_type: f.mime_type,
            created_at: f.created_at,
        })),
        total,
        page,
        per_page: perPage,
    });
});

// ── DELETE /files/:file_id ──────────────────────────────────────────────

filesRouter.delete("/:file_id", (req, res) => {
    const record = files.get(req.params.file_id);
    if (!record || record.user_id !== req.auth!.user_id) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "File not found" },
        });
        return;
    }

    // Check if any active task references this file
    for (const task of tasks.values()) {
        if (
            task.input_file_id === record.file_id &&
            !TERMINAL_STATUSES.has(task.status)
        ) {
            res.status(409).json({
                error: { code: "CONFLICT", message: "File is in use by an active task" },
            });
            return;
        }
    }

    // Remove from disk (best-effort)
    try {
        fs.unlinkSync(record.local_path);
    } catch { /* ignore */ }

    files.delete(record.file_id);
    res.status(204).end();
});
