import { Router } from "express";
import * as crypto from "node:crypto";
import { requireAuth } from "../middleware.js";
import { files, tasks, conversions } from "../stores.js";
import type {
    ConversionRecord,
    ConversionTaskSummary,
    TaskRecord,
    TaskType,
} from "../types.js";

export const conversionsRouter = Router();

conversionsRouter.use(requireAuth);

// ── POST /conversions ───────────────────────────────────────────────────

conversionsRouter.post("/", (req, res) => {
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

    const file = files.get(input_file_id);
    if (!file || file.user_id !== req.auth!.user_id) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "Input file not found" },
        });
        return;
    }

    const userId = req.auth!.user_id;
    const now = new Date().toISOString();

    // Create the constituent tasks (all as stubs in "pending")
    const taskSummaries: ConversionTaskSummary[] = [];

    // 1. split_stems task
    const splitTask = createStubTask(userId, "split_stems", input_file_id, { stems: 4, model: "orion" }, now);
    taskSummaries.push({ task_id: splitTask.task_id, type: splitTask.type, status: splitTask.status });

    // 2. One audio2chart task per instrument
    for (const instrument of instruments) {
        const a2cTask = createStubTask(userId, "audio2chart", input_file_id, { difficulty, instrument }, now);
        taskSummaries.push({ task_id: a2cTask.task_id, type: a2cTask.type, status: a2cTask.status });
    }

    // 3. upload_s3 task
    const uploadTask = createStubTask(userId, "upload_s3", input_file_id, {}, now);
    taskSummaries.push({ task_id: uploadTask.task_id, type: uploadTask.type, status: uploadTask.status });

    const record: ConversionRecord = {
        conversion_id: `conv_${crypto.randomUUID().slice(0, 8)}`,
        user_id: userId,
        status: "in_progress",
        input_file_id,
        tasks: taskSummaries,
        created_at: now,
    };

    conversions.set(record.conversion_id, record);

    res.status(201).json(publicConversion(record));
});

// ── GET /conversions/:conversion_id ─────────────────────────────────────

conversionsRouter.get("/:conversion_id", (req, res) => {
    const record = conversions.get(req.params.conversion_id);
    if (!record || record.user_id !== req.auth!.user_id) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "Conversion not found" },
        });
        return;
    }

    // Refresh task statuses from the task store
    for (const summary of record.tasks) {
        const task = tasks.get(summary.task_id);
        if (task) {
            summary.status = task.status;
        }
    }

    res.json(publicConversion(record));
});

// ── GET /conversions ────────────────────────────────────────────────────

conversionsRouter.get("/", (req, res) => {
    const userId = req.auth!.user_id;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string, 10) || 20));

    const userConversions = [...conversions.values()].filter((c) => c.user_id === userId);
    const total = userConversions.length;
    const start = (page - 1) * perPage;
    const paged = userConversions.slice(start, start + perPage);

    res.json({
        conversions: paged.map(publicConversion),
        total,
        page,
        per_page: perPage,
    });
});

// ── Helpers ─────────────────────────────────────────────────────────────

function createStubTask(
    userId: string,
    type: TaskType,
    inputFileId: string,
    settings: Record<string, unknown>,
    now: string,
): TaskRecord {
    const record: TaskRecord = {
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
    tasks.set(record.task_id, record);
    return record;
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
