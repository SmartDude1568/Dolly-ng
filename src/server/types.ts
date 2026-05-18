/**
 * Shared types for the Dolly API server, matching the design doc spec.
 */

// ── Auth ────────────────────────────────────────────────────────────────

export interface UserRecord {
    user_id: string;
    email: string;
    password_hash: string;
    display_name?: string;
    created_at: string;
}

export interface AuthContext {
    user_id: string;
    token: string;
    expires_at: string;
}

// ── Files ───────────────────────────────────────────────────────────────

export interface FileRecord {
    file_id: string;
    user_id: string;
    name: string;
    size_bytes: number;
    mime_type: string;
    created_at: string;
    /** Internal: path on disk where the file is stored. */
    local_path: string;
}

// ── Tasks ───────────────────────────────────────────────────────────────

export type TaskType = "split_stems" | "audio2chart" | "upload_s3";

export type TaskStatus =
    | "pending"
    | "queued"
    | "assigned"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled";

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
    "completed",
    "failed",
    "cancelled",
]);

export interface TaskError {
    code: string;
    message: string;
}

export interface TaskRecord {
    task_id: string;
    user_id: string;
    type: TaskType;
    status: TaskStatus;
    progress: number;
    input_file_id: string;
    settings: Record<string, unknown>;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    output_file_id: string | null;
    slot_id: string | null;
    error: TaskError | null;
}

// ── Conversions ─────────────────────────────────────────────────────────

export type ConversionStatus = "in_progress" | "completed" | "failed";

export interface ConversionTaskSummary {
    task_id: string;
    type: TaskType;
    status: TaskStatus;
}

export interface ConversionRecord {
    conversion_id: string;
    user_id: string;
    status: ConversionStatus;
    input_file_id: string;
    tasks: ConversionTaskSummary[];
    created_at: string;
}

// ── Slots (internal) ────────────────────────────────────────────────────

export type SlotStatus = "idle" | "busy";

export interface SlotRecord {
    slot_id: string;
    status: SlotStatus;
    capabilities: TaskType[];
    current_task_id: string | null;
    gpu_server: string | null;
}

// ── API error envelope ──────────────────────────────────────────────────

export interface ApiError {
    error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
    };
}

// ── Pagination ──────────────────────────────────────────────────────────

export interface PaginationParams {
    page: number;
    per_page: number;
    sort?: string;
    order?: "asc" | "desc";
}
