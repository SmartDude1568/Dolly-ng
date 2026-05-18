/**
 * In-memory stores for resources whose state is transient (not persisted to DB).
 * Files, tasks, and conversions have been migrated to Neon PostgreSQL.
 * Slots represent live compute resources and remain in-memory.
 */

import type { SlotRecord } from "./types.js";

// Pre-seed a few slots so the internal API has something to return.
export const slots = new Map<string, SlotRecord>([
    [
        "slot_01",
        {
            slot_id: "slot_01",
            status: "idle",
            capabilities: ["split_stems", "upload_s3"],
            current_task_id: null,
            gpu_server: null,
        },
    ],
    [
        "slot_02",
        {
            slot_id: "slot_02",
            status: "idle",
            capabilities: ["audio2chart"],
            current_task_id: null,
            gpu_server: "gpu-01.internal",
        },
    ],
]);
