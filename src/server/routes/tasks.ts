import { Router } from "express";
import * as crypto from "node:crypto";
import { requireAuth } from "../middleware.js";
import { slots } from "../stores.js";
import {
    dbGetFile,
    dbInsertTask,
    dbGetTask,
    dbListTasks,
    dbUpdateTask,
} from "../db-helpers.js";
import type { TaskRecord, TaskType } from "../types.js";

export const tasksRouter = Router();

tasksRouter.use(requireAuth);

const VALID_TASK_TYPES: ReadonlySet<string> = new Set(["split_stems", "audio2chart", "upload_s3"]);

// ── POST /tasks ─────────────────────────────────────────────────────────

tasksRouter.post("/", async (req, res) => {
    const { type, input_file_id, settings } = req.body as {
        type?: string;
        input_file_id?: string;
        settings?: Record<string, unknown>;
    };

    if (!type || !VALID_TASK_TYPES.has(type)) {
        res.status(400).json({
            error: { code: "BAD_REQUEST", message: "Invalid or missing task type" },
        });
        return;
    }

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

    const record: TaskRecord = {
        task_id: `task_${crypto.randomUUID()}`,
        user_id: req.auth!.user_id,
        type: type as TaskType,
        status: "pending",
        progress: 0,
        input_file_id,
        settings: settings ?? buildDefaultSettings(type as TaskType),
        created_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        output_file_id: null,
        slot_id: null,
        error: null,
    };

    await dbInsertTask(record);

    // Stub scheduling: try to assign an idle slot
    await scheduleTask(record);

    res.status(201).json(publicTask(record));
});

// ── GET /tasks/:task_id ─────────────────────────────────────────────────

tasksRouter.get("/:task_id", async (req, res) => {
    const record = await dbGetTask(req.params.task_id);
    if (!record || record.user_id !== req.auth!.user_id) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "Task not found" },
        });
        return;
    }

    res.json(publicTask(record));
});

// ── GET /tasks ──────────────────────────────────────────────────────────

tasksRouter.get("/", async (req, res) => {
    const userId = req.auth!.user_id;
    const statusFilter = req.query.status as string | undefined;
    const typeFilter = req.query.type as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page as string, 10) || 20));

    const { tasks, total } = await dbListTasks(userId, statusFilter, typeFilter, page, perPage);

    res.json({ tasks: tasks.map(publicTask), total, page, per_page: perPage });
});

// ── DELETE /tasks/:task_id ──────────────────────────────────────────────

tasksRouter.delete("/:task_id", async (req, res) => {
    const record = await dbGetTask(req.params.task_id);
    if (!record || record.user_id !== req.auth!.user_id) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "Task not found" },
        });
        return;
    }

    if (record.status !== "pending" && record.status !== "queued") {
        res.status(409).json({
            error: {
                code: "CONFLICT",
                message: "Task is already processing or has finished and cannot be cancelled",
            },
        });
        return;
    }

    await dbUpdateTask(record.task_id, { status: "cancelled" });
    res.status(204).end();
});

// ── Helpers ─────────────────────────────────────────────────────────────

function buildDefaultSettings(type: TaskType): Record<string, unknown> {
    switch (type) {
        case "split_stems":
            return { stems: 4, model: "orion" };
        case "audio2chart":
            return { difficulty: "expert", instrument: "guitar" };
        case "upload_s3":
            return {};
    }
}

function publicTask(t: TaskRecord) {
    return {
        task_id: t.task_id,
        type: t.type,
        status: t.status,
        progress: t.progress,
        input_file_id: t.input_file_id,
        settings: t.settings,
        created_at: t.created_at,
        started_at: t.started_at,
        completed_at: t.completed_at,
        output_file_id: t.output_file_id,
        slot_id: t.slot_id,
        error: t.error,
    };
}

async function scheduleTask(task: TaskRecord): Promise<void> {
    task.status = "queued";
    await dbUpdateTask(task.task_id, { status: "queued" });

    for (const slot of slots.values()) {
        if (slot.status === "idle" && slot.capabilities.includes(task.type)) {
            slot.status = "busy";
            slot.current_task_id = task.task_id;
            task.status = "assigned";
            task.slot_id = slot.slot_id;
            await dbUpdateTask(task.task_id, { status: "assigned", slot_id: slot.slot_id });
            return;
        }
    }
}
