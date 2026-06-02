/**
 * Conversion resume / retry.
 *
 * The worker runs in-process and fire-and-forget, so a server restart (or a
 * crash that kills a spawned child process) leaves a conversion stranded —
 * either still marked `in_progress` (the whole process died) or `failed` (a
 * child was killed mid-step). Because the worker is now idempotent and reuses
 * on-disk stems/charts, such a conversion can simply be re-run: completed steps
 * are skipped and it picks up where it stopped.
 *
 * This startup sweep is intentionally for a single active server process. In a
 * horizontally scaled deployment, add a database-backed lease/owner heartbeat
 * before enabling this path so one instance cannot re-run work another instance
 * still owns.
 */

import { startConversion } from "./worker.js";
import {
    dbGetConversion,
    dbGetConversionTaskRecords,
    dbGetFile,
    dbUpdateTask,
    dbUpdateConversionStatus,
    dbListConversionsByStatus,
} from "./db-helpers.js";
import type { TaskRecord } from "./types.js";

/** Statuses that mean a task was running (or queued) when the process stopped. */
const RESUMABLE_TASK_STATUSES = new Set(["failed", "processing", "assigned", "queued"]);

function deriveInstruments(tasks: TaskRecord[]): string[] {
    return tasks
        .filter((t) => t.type === "audio2chart")
        .map((t) => (t.settings as { instrument?: string }).instrument)
        .filter((x): x is string => typeof x === "string" && x.length > 0);
}

function deriveDifficulty(tasks: TaskRecord[]): string {
    const a2c = tasks.find((t) => t.type === "audio2chart");
    const diff = (a2c?.settings as { difficulty?: string } | undefined)?.difficulty;
    return diff ?? "expert";
}

/**
 * Re-launch the pipeline for a single conversion. Resets any non-terminal /
 * failed task back to `pending` and the conversion to `in_progress`, then hands
 * off to the (idempotent) worker. Returns false if the conversion or its input
 * file can no longer be found.
 */
export async function resumeConversion(conversionId: string): Promise<boolean> {
    const conversion = await dbGetConversion(conversionId);
    if (!conversion) return false;

    const tasks = await dbGetConversionTaskRecords(conversionId);
    const inputFile = await dbGetFile(conversion.input_file_id);
    if (!inputFile) {
        console.warn(`[resume] ${conversionId}: input file ${conversion.input_file_id} is gone; cannot resume`);
        return false;
    }

    // Clear stale running/failed state so the run starts clean.
    for (const t of tasks) {
        if (RESUMABLE_TASK_STATUSES.has(t.status)) {
            await dbUpdateTask(t.task_id, { status: "pending", error: null });
            t.status = "pending";
            t.error = null;
        }
    }
    await dbUpdateConversionStatus(conversionId, "in_progress");
    conversion.status = "in_progress";

    startConversion({
        conversion,
        tasks,
        inputFile,
        instruments: deriveInstruments(tasks),
        difficulty: deriveDifficulty(tasks),
        bpm: inputFile.bpm ?? null,
    });
    return true;
}

/**
 * On startup, re-launch any conversion left `in_progress` — these were
 * interrupted, since a clean finish always sets `completed` or `failed`.
 *
 * ISSUE 7: this used to fire every interrupted conversion off simultaneously.
 * `startConversion` now gates on an in-process concurrency semaphore (see
 * worker.ts, WORKER_CONCURRENCY, default 2), so the relaunched conversions
 * enqueue here but only a bounded number actually run the pipeline at once.
 *
 * Horizontal scaling note: this process does not acquire a DB lease before
 * resuming rows. Run this startup sweep on only one server instance.
 */
export async function resumeInterruptedConversions(): Promise<void> {
    let convs;
    try {
        convs = await dbListConversionsByStatus("in_progress");
    } catch (err) {
        console.error("[resume] could not query interrupted conversions:", err);
        return;
    }
    if (convs.length === 0) return;

    console.log(`[resume] resuming ${convs.length} interrupted conversion(s)…`);
    for (const c of convs) {
        try {
            const ok = await resumeConversion(c.conversion_id);
            console.log(`[resume] ${c.conversion_id}: ${ok ? "relaunched" : "skipped"}`);
        } catch (err) {
            console.error(`[resume] ${c.conversion_id} failed to resume:`, err);
        }
    }
}
