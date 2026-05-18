/**
 * In-memory data stores for resources not yet backed by Neon DB.
 * Users and sessions are now stored in Neon PostgreSQL.
 */

import type {
    FileRecord,
    TaskRecord,
    ConversionRecord,
    SlotRecord,
} from "./types.js";

export const files = new Map<string, FileRecord>();            // file_id → FileRecord
export const tasks = new Map<string, TaskRecord>();            // task_id → TaskRecord
export const conversions = new Map<string, ConversionRecord>();// conv_id → ConversionRecord

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
