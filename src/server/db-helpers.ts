/**
 * Database helper functions for Dolly resources (files, tasks, conversions).
 * Uses the Neon serverless SQL driver from db.ts.
 */

import { sql } from "./db.js";
import type {
    FileRecord,
    TaskRecord,
    TaskType,
    TaskStatus,
    TaskError,
    ConversionRecord,
    ConversionTaskSummary,
    ConversionStatus,
} from "./types.js";

// ── Files ─────────────────────────────────────────────────────────────────

export async function dbInsertFile(record: FileRecord): Promise<void> {
    await sql`
        INSERT INTO files (file_id, user_id, name, size_bytes, mime_type, local_path, created_at)
        VALUES (
            ${record.file_id}, ${record.user_id}, ${record.name},
            ${record.size_bytes}, ${record.mime_type}, ${record.local_path},
            ${record.created_at}
        )
    `;
}

export async function dbGetFile(fileId: string): Promise<FileRecord | null> {
    const rows = await sql`SELECT * FROM files WHERE file_id = ${fileId}`;
    return rows[0] ? rowToFile(rows[0]) : null;
}

export async function dbListFiles(
    userId: string,
    page: number,
    perPage: number,
    sort: string,
    order: string,
): Promise<{ files: FileRecord[]; total: number }> {
    const offset = (page - 1) * perPage;
    const asc = order !== "desc";

    // Whitelist sort columns to prevent SQL injection
    const col = ["name", "size_bytes", "created_at"].includes(sort) ? sort : "created_at";

    const rows = await (asc
        ? col === "name"
            ? sql`SELECT * FROM files WHERE user_id = ${userId} ORDER BY name ASC LIMIT ${perPage} OFFSET ${offset}`
            : col === "size_bytes"
            ? sql`SELECT * FROM files WHERE user_id = ${userId} ORDER BY size_bytes ASC LIMIT ${perPage} OFFSET ${offset}`
            : sql`SELECT * FROM files WHERE user_id = ${userId} ORDER BY created_at ASC LIMIT ${perPage} OFFSET ${offset}`
        : col === "name"
        ? sql`SELECT * FROM files WHERE user_id = ${userId} ORDER BY name DESC LIMIT ${perPage} OFFSET ${offset}`
        : col === "size_bytes"
        ? sql`SELECT * FROM files WHERE user_id = ${userId} ORDER BY size_bytes DESC LIMIT ${perPage} OFFSET ${offset}`
        : sql`SELECT * FROM files WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${perPage} OFFSET ${offset}`);

    const countRows = await sql`SELECT COUNT(*)::int AS total FROM files WHERE user_id = ${userId}`;
    return {
        files: rows.map(rowToFile),
        total: (countRows[0]?.total as number) ?? 0,
    };
}

export async function dbDeleteFile(fileId: string): Promise<void> {
    await sql`DELETE FROM files WHERE file_id = ${fileId}`;
}

export async function dbIsFileInUse(fileId: string): Promise<boolean> {
    const rows = await sql`
        SELECT 1 FROM tasks
        WHERE input_file_id = ${fileId}
          AND status NOT IN ('completed', 'failed', 'cancelled')
        LIMIT 1
    `;
    return rows.length > 0;
}

function rowToFile(row: Record<string, unknown>): FileRecord {
    return {
        file_id: row.file_id as string,
        user_id: row.user_id as string,
        name: row.name as string,
        size_bytes: Number(row.size_bytes),
        mime_type: row.mime_type as string,
        local_path: row.local_path as string,
        created_at: toIso(row.created_at),
    };
}

// ── Tasks ─────────────────────────────────────────────────────────────────

export async function dbInsertTask(record: TaskRecord): Promise<void> {
    await sql`
        INSERT INTO tasks (
            task_id, user_id, type, status, progress, input_file_id,
            settings, slot_id, output_file_id, error,
            created_at, started_at, completed_at
        ) VALUES (
            ${record.task_id}, ${record.user_id}, ${record.type},
            ${record.status}, ${record.progress}, ${record.input_file_id},
            ${JSON.stringify(record.settings)}, ${record.slot_id},
            ${record.output_file_id}, ${record.error ? JSON.stringify(record.error) : null},
            ${record.created_at}, ${record.started_at}, ${record.completed_at}
        )
    `;
}

export async function dbGetTask(taskId: string): Promise<TaskRecord | null> {
    const rows = await sql`SELECT * FROM tasks WHERE task_id = ${taskId}`;
    return rows[0] ? rowToTask(rows[0]) : null;
}

export async function dbUpdateTask(
    taskId: string,
    fields: Partial<Pick<TaskRecord, "status" | "progress" | "slot_id" | "output_file_id" | "error" | "started_at" | "completed_at">>,
): Promise<void> {
    // Build updates only for fields provided
    if (fields.status !== undefined) {
        await sql`UPDATE tasks SET status = ${fields.status} WHERE task_id = ${taskId}`;
    }
    if (fields.progress !== undefined) {
        await sql`UPDATE tasks SET progress = ${fields.progress} WHERE task_id = ${taskId}`;
    }
    if (fields.slot_id !== undefined) {
        await sql`UPDATE tasks SET slot_id = ${fields.slot_id} WHERE task_id = ${taskId}`;
    }
    if (fields.output_file_id !== undefined) {
        await sql`UPDATE tasks SET output_file_id = ${fields.output_file_id} WHERE task_id = ${taskId}`;
    }
    if (fields.error !== undefined) {
        await sql`UPDATE tasks SET error = ${JSON.stringify(fields.error)} WHERE task_id = ${taskId}`;
    }
    if (fields.started_at !== undefined) {
        await sql`UPDATE tasks SET started_at = ${fields.started_at} WHERE task_id = ${taskId}`;
    }
    if (fields.completed_at !== undefined) {
        await sql`UPDATE tasks SET completed_at = ${fields.completed_at} WHERE task_id = ${taskId}`;
    }
}

export async function dbListTasks(
    userId: string,
    statusFilter: string | undefined,
    typeFilter: string | undefined,
    page: number,
    perPage: number,
): Promise<{ tasks: TaskRecord[]; total: number }> {
    const offset = (page - 1) * perPage;

    const rows = await (statusFilter && typeFilter
        ? sql`SELECT * FROM tasks WHERE user_id = ${userId} AND status = ${statusFilter} AND type = ${typeFilter} ORDER BY created_at DESC LIMIT ${perPage} OFFSET ${offset}`
        : statusFilter
        ? sql`SELECT * FROM tasks WHERE user_id = ${userId} AND status = ${statusFilter} ORDER BY created_at DESC LIMIT ${perPage} OFFSET ${offset}`
        : typeFilter
        ? sql`SELECT * FROM tasks WHERE user_id = ${userId} AND type = ${typeFilter} ORDER BY created_at DESC LIMIT ${perPage} OFFSET ${offset}`
        : sql`SELECT * FROM tasks WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${perPage} OFFSET ${offset}`);

    const countRows = await (statusFilter && typeFilter
        ? sql`SELECT COUNT(*)::int AS total FROM tasks WHERE user_id = ${userId} AND status = ${statusFilter} AND type = ${typeFilter}`
        : statusFilter
        ? sql`SELECT COUNT(*)::int AS total FROM tasks WHERE user_id = ${userId} AND status = ${statusFilter}`
        : typeFilter
        ? sql`SELECT COUNT(*)::int AS total FROM tasks WHERE user_id = ${userId} AND type = ${typeFilter}`
        : sql`SELECT COUNT(*)::int AS total FROM tasks WHERE user_id = ${userId}`);

    return {
        tasks: rows.map(rowToTask),
        total: (countRows[0]?.total as number) ?? 0,
    };
}

export async function dbDeleteTask(taskId: string): Promise<void> {
    await sql`DELETE FROM tasks WHERE task_id = ${taskId}`;
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
    return {
        task_id: row.task_id as string,
        user_id: row.user_id as string,
        type: row.type as TaskType,
        status: row.status as TaskStatus,
        progress: Number(row.progress),
        input_file_id: row.input_file_id as string,
        settings: (row.settings as Record<string, unknown>) ?? {},
        slot_id: (row.slot_id as string | null) ?? null,
        output_file_id: (row.output_file_id as string | null) ?? null,
        error: (row.error as TaskError | null) ?? null,
        created_at: toIso(row.created_at),
        started_at: row.started_at ? toIso(row.started_at) : null,
        completed_at: row.completed_at ? toIso(row.completed_at) : null,
    };
}

// ── Conversions ───────────────────────────────────────────────────────────

export async function dbInsertConversion(
    record: ConversionRecord,
    taskIds: string[],
): Promise<void> {
    await sql`
        INSERT INTO conversions (conversion_id, user_id, status, input_file_id, created_at)
        VALUES (${record.conversion_id}, ${record.user_id}, ${record.status},
                ${record.input_file_id}, ${record.created_at})
    `;
    for (const taskId of taskIds) {
        await sql`
            INSERT INTO conversion_tasks (conversion_id, task_id)
            VALUES (${record.conversion_id}, ${taskId})
        `;
    }
}

export async function dbGetConversion(conversionId: string): Promise<ConversionRecord | null> {
    const rows = await sql`SELECT * FROM conversions WHERE conversion_id = ${conversionId}`;
    if (!rows[0]) return null;
    const conv = rowToConversion(rows[0]);
    conv.tasks = await dbGetConversionTasks(conversionId);
    return conv;
}

export async function dbGetConversionTasks(conversionId: string): Promise<ConversionTaskSummary[]> {
    const rows = await sql`
        SELECT t.task_id, t.type, t.status
        FROM tasks t
        JOIN conversion_tasks ct ON ct.task_id = t.task_id
        WHERE ct.conversion_id = ${conversionId}
        ORDER BY t.created_at
    `;
    return rows.map((r) => ({
        task_id: r.task_id as string,
        type: r.type as TaskType,
        status: r.status as TaskStatus,
    }));
}

export async function dbUpdateConversionStatus(
    conversionId: string,
    status: ConversionStatus,
): Promise<void> {
    await sql`UPDATE conversions SET status = ${status} WHERE conversion_id = ${conversionId}`;
}

export async function dbListConversions(
    userId: string,
    page: number,
    perPage: number,
): Promise<{ conversions: ConversionRecord[]; total: number }> {
    const offset = (page - 1) * perPage;
    const rows = await sql`
        SELECT * FROM conversions WHERE user_id = ${userId}
        ORDER BY created_at DESC LIMIT ${perPage} OFFSET ${offset}
    `;
    const countRows = await sql`SELECT COUNT(*)::int AS total FROM conversions WHERE user_id = ${userId}`;

    const convs: ConversionRecord[] = [];
    for (const row of rows) {
        const conv = rowToConversion(row);
        conv.tasks = await dbGetConversionTasks(conv.conversion_id);
        convs.push(conv);
    }

    return {
        conversions: convs,
        total: (countRows[0]?.total as number) ?? 0,
    };
}

function rowToConversion(row: Record<string, unknown>): ConversionRecord {
    return {
        conversion_id: row.conversion_id as string,
        user_id: row.user_id as string,
        status: row.status as ConversionStatus,
        input_file_id: row.input_file_id as string,
        tasks: [],
        created_at: toIso(row.created_at),
    };
}

// ── Utility ───────────────────────────────────────────────────────────────

function toIso(val: unknown): string {
    if (val instanceof Date) return val.toISOString();
    return String(val);
}
