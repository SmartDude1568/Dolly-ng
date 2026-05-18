import { Router } from "express";
import * as crypto from "node:crypto";
import { requireAuth } from "../middleware.js";
import {
    dbGetFile,
    dbInsertTask,
    dbInsertConversion,
    dbGetConversion,
    dbListConversions,
} from "../db-helpers.js";
import type { ConversionRecord, TaskRecord, TaskType } from "../types.js";

export const conversionsRouter = Router();

conversionsRouter.use(requireAuth);

// ── POST /conversions ───────────────────────────────────────────────────

conversionsRouter.post("/", async (req, res) => {
    const {
        input_file_id,
        instruments = ["guitar", "bass", "drums"],
        difficulty = "expert",
    } = req.body as {
        input_file_id?: string;
        instruments?: string[];
        difficulty?: string;
    };

    if (!input_file_id) {
        res.status(400).json({
            error: { code: "BAD_REQUEST", message: "input_file_id is required" },
        });
        return;
    }

    const file = await dbGetFile(input_file_id);
    if (!file || file.user_id !== req.auth!.user_id) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "Input file not found" },
        });
        return;
    }

    const userId = req.auth!.user_id;
    const now = new Date().toISOString();

    const taskRecords: TaskRecord[] = [];

    // 1. split_stems task
    taskRecords.push(makeTask(userId, "split_stems", input_file_id, { stems: 4, model: "orion" }, now));

    // 2. One audio2chart task per instrument
    for (const instrument of instruments) {
        taskRecords.push(makeTask(userId, "audio2chart", input_file_id, { difficulty, instrument }, now));
    }

    // 3. upload_s3 task
    taskRecords.push(makeTask(userId, "upload_s3", input_file_id, {}, now));

    // Persist all tasks
    for (const t of taskRecords) {
        await dbInsertTask(t);
    }

    const record: ConversionRecord = {
        conversion_id: `conv_${crypto.randomUUID().slice(0, 8)}`,
        user_id: userId,
        status: "in_progress",
        input_file_id,
        tasks: taskRecords.map((t) => ({ task_id: t.task_id, type: t.type, status: t.status })),
        created_at: now,
    };

    await dbInsertConversion(record, taskRecords.map((t) => t.task_id));

    res.status(201).json(publicConversion(record));
});

// ── GET /conversions/:conversion_id ─────────────────────────────────────

conversionsRouter.get("/:conversion_id", async (req, res) => {
    const record = await dbGetConversion(req.params.conversion_id);
    if (!record || record.user_id !== req.auth!.user_id) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "Conversion not found" },
        });
        return;
    }

    res.json(publicConversion(record));
});

// ── GET /conversions ────────────────────────────────────────────────────

conversionsRouter.get("/", async (req, res) => {
    const userId = req.auth!.user_id;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string, 10) || 20));

    const { conversions, total } = await dbListConversions(userId, page, perPage);

    res.json({
        conversions: conversions.map(publicConversion),
        total,
        page,
        per_page: perPage,
    });
});

// ── Helpers ─────────────────────────────────────────────────────────────

function makeTask(
    userId: string,
    type: TaskType,
    inputFileId: string,
    settings: Record<string, unknown>,
    now: string,
): TaskRecord {
    return {
        task_id: `task_${crypto.randomUUID().slice(0, 8)}`,
        user_id: userId,
        type,
        status: "pending",
        progress: 0,
        input_file_id: inputFileId,
        settings,
        created_at: now,
        started_at: null,
        completed_at: null,
        output_file_id: null,
        slot_id: null,
        error: null,
    };
}

function publicConversion(c: ConversionRecord) {
    return {
        conversion_id: c.conversion_id,
        status: c.status,
        input_file_id: c.input_file_id,
        tasks: c.tasks,
        created_at: c.created_at,
    };
}
