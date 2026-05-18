import { Router } from "express";
import { slots, tasks } from "../stores.js";

export const slotsRouter = Router();

// Internal routes — no auth required (would be network-isolated in production)

// ── GET /internal/slots ─────────────────────────────────────────────────

slotsRouter.get("/", (_req, res) => {
    res.json({
        slots: [...slots.values()],
    });
});

// ── POST /internal/slots/:slot_id/assign ────────────────────────────────

slotsRouter.post("/:slot_id/assign", (req, res) => {
    const slot = slots.get(req.params.slot_id);
    if (!slot) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "Slot not found" },
        });
        return;
    }

    const { task_id } = req.body as { task_id?: string };
    if (!task_id) {
        res.status(400).json({
            error: { code: "BAD_REQUEST", message: "task_id is required" },
        });
        return;
    }

    const task = tasks.get(task_id);
    if (!task) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "Task not found" },
        });
        return;
    }

    if (slot.status === "busy") {
        res.status(409).json({
            error: { code: "CONFLICT", message: "Slot is already busy" },
        });
        return;
    }

    if (!slot.capabilities.includes(task.type)) {
        res.status(400).json({
            error: {
                code: "BAD_REQUEST",
                message: `Slot does not have capability "${task.type}"`,
            },
        });
        return;
    }

    slot.status = "busy";
    slot.current_task_id = task_id;
    task.status = "assigned";
    task.slot_id = slot.slot_id;

    res.json({ ok: true });
});

// ── POST /internal/slots/:slot_id/release ───────────────────────────────

slotsRouter.post("/:slot_id/release", (req, res) => {
    const slot = slots.get(req.params.slot_id);
    if (!slot) {
        res.status(404).json({
            error: { code: "NOT_FOUND", message: "Slot not found" },
        });
        return;
    }

    slot.status = "idle";
    slot.current_task_id = null;

    res.json({ ok: true });
});
