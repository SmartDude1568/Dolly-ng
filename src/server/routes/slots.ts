import type { Request, Response, NextFunction } from "express";
import { Router } from "express";
import * as crypto from "node:crypto";
import { slots } from "../stores.js";
import { dbGetTask, dbUpdateTask } from "../db-helpers.js";

export const slotsRouter = Router();

// Internal routes — these are intended to be network-isolated in production.
// As defense-in-depth (in case they are ever reachable), every request must
// carry a shared internal secret: header `x-internal-token` must match the
// `INTERNAL_API_TOKEN` env var.
//
// Fail-closed policy: if `INTERNAL_API_TOKEN` is unset, ALL requests are
// rejected (503). We intentionally do NOT fall back to open access — an
// unconfigured secret must never mean "no protection". Local dev / tests that
// need these endpoints simply set INTERNAL_API_TOKEN.

/** Constant-time string compare that is safe for differing lengths. */
function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ab.length !== bb.length) {
        // Still run a comparison to avoid leaking length via early return timing.
        crypto.timingSafeEqual(ab, ab);
        return false;
    }
    return crypto.timingSafeEqual(ab, bb);
}

/** Require a valid shared internal token on every slots request. */
function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
    const expected = process.env.INTERNAL_API_TOKEN;
    if (!expected) {
        // Fail-closed: refuse to serve internal endpoints without a configured secret.
        res.status(503).json({
            error: {
                code: "INTERNAL_AUTH_NOT_CONFIGURED",
                message: "Internal API is not configured (INTERNAL_API_TOKEN unset)",
            },
        });
        return;
    }

    const provided = req.headers["x-internal-token"];
    const token = Array.isArray(provided) ? provided[0] : provided;
    if (!token || !safeEqual(token, expected)) {
        res.status(403).json({
            error: { code: "FORBIDDEN", message: "Invalid or missing internal token" },
        });
        return;
    }

    next();
}

slotsRouter.use(requireInternalToken);

// ── GET /internal/slots ─────────────────────────────────────────────────

slotsRouter.get("/", (_req, res) => {
    res.json({
        slots: [...slots.values()],
    });
});

// ── POST /internal/slots/:slot_id/assign ────────────────────────────────

slotsRouter.post("/:slot_id/assign", async (req, res) => {
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

    const task = await dbGetTask(task_id);
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
    await dbUpdateTask(task_id, { status: "assigned", slot_id: slot.slot_id });

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
