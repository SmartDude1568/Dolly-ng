import { Router } from "express";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { requireAuth } from "../middleware.js";
import {
    dbGetFile,
    dbInsertTask,
    dbInsertConversion,
    dbGetConversion,
    dbListConversions,
    dbGetTask,
} from "../db-helpers.js";
import { startConversion } from "../worker.js";
import { resumeConversion } from "../resume.js";
import { getAudioDurationSec, MIN_AUDIO_DURATION_SEC } from "../../audio-duration.js";
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

    // Reject too-short audio up front — the audio2chart model requires >= 30s
    // and would otherwise fail mid-pipeline, after a paid LALAL split. If the
    // probe itself fails, fall through and let the pipeline run.
    if (file.local_path && fs.existsSync(file.local_path)) {
        try {
            const durationSec = await getAudioDurationSec(file.local_path);
            if (durationSec < MIN_AUDIO_DURATION_SEC) {
                res.status(422).json({
                    error: {
                        code: "AUDIO_TOO_SHORT",
                        message: `Audio is too short to chart: ${durationSec.toFixed(2)}s (minimum ${MIN_AUDIO_DURATION_SEC}s)`,
                    },
                });
                return;
            }
        } catch (err) {
            console.warn(
                `[conversions] duration probe failed for ${input_file_id}:`,
                err instanceof Error ? err.message : err,
            );
        }
    }

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

    // Kick off the pipeline in the background.
    startConversion({
        conversion: record,
        tasks: taskRecords,
        inputFile: file,
        instruments,
        difficulty,
    });

    res.status(201).json(publicConversion(record));
});

// ── POST /conversions/:conversion_id/retry ──────────────────────────────

conversionsRouter.post("/:conversion_id/retry", async (req, res) => {
    const record = await dbGetConversion(req.params.conversion_id);
    if (!record || record.user_id !== req.auth!.user_id) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "Conversion not found" },
        });
        return;
    }

    if (record.status === "completed") {
        res.status(409).json({
            error: { code: "CONFLICT", message: "Conversion already completed" },
        });
        return;
    }
    if (record.status === "in_progress") {
        res.status(409).json({
            error: { code: "CONFLICT", message: "Conversion is already running" },
        });
        return;
    }

    const ok = await resumeConversion(record.conversion_id);
    if (!ok) {
        res.status(422).json({
            error: { code: "CANNOT_RESUME", message: "Conversion cannot be resumed (input file missing)" },
        });
        return;
    }

    const updated = await dbGetConversion(record.conversion_id);
    res.status(202).json(publicConversion(updated ?? record));
});

// ── GET /conversions/:conversion_id/download ────────────────────────────

conversionsRouter.get("/:conversion_id/download", async (req, res) => {
    const record = await dbGetConversion(req.params.conversion_id);
    if (!record || record.user_id !== req.auth!.user_id) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "Conversion not found" },
        });
        return;
    }

    if (record.status !== "completed") {
        res.status(409).json({
            error: { code: "CONFLICT", message: `Conversion is ${record.status}, not completed` },
        });
        return;
    }

    const uploadSummary = record.tasks.find((t) => t.type === "upload_s3");
    const uploadTask = uploadSummary ? await dbGetTask(uploadSummary.task_id) : null;
    const outputFileId = uploadTask?.output_file_id;
    const outputFile = outputFileId ? await dbGetFile(outputFileId) : null;

    if (!outputFile || !fs.existsSync(outputFile.local_path)) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "Conversion output not available" },
        });
        return;
    }

    res.download(outputFile.local_path, outputFile.name);
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
        download_url:
            c.status === "completed" ? `/v1/conversions/${c.conversion_id}/download` : null,
    };
}
