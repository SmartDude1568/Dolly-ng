/**
 * Tests for src/server/db-helpers.ts, called directly against the in-memory
 * Postgres (pg-mem) wired up by the shared harness. Covers round-trips,
 * partial updates, filtering / sorting / pagination, per-user isolation and
 * the SQL-injection guards (whitelisted sort column, bound parameters).
 *
 * Usage:  npx tsx tests/db-helpers.test.ts
 */

import { createHarness } from "./helpers/harness.js";
import * as assert from "node:assert";
import type { ConversionRecord, FileRecord, TaskRecord } from "../src/server/types.js";

async function main(): Promise<void> {
    let passed = 0;
    let failed = 0;
    async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (error) {
            console.log(`✗ ${name}`);
            console.log(`    Error: ${error instanceof Error ? (error.stack ?? error.message) : error}`);
            failed++;
        }
    }

    const h = await createHarness();
    const db = await import("../src/server/db-helpers.js");

    const iso = (minutes: number): string => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();

    const file = (id: string, userId: string, over: Partial<FileRecord> = {}): FileRecord => ({
        file_id: id,
        user_id: userId,
        name: `${id}.wav`,
        size_bytes: 100,
        mime_type: "audio/wav",
        local_path: `/tmp/${id}.wav`,
        created_at: iso(0),
        ...over,
    });
    const task = (id: string, userId: string, over: Partial<TaskRecord> = {}): TaskRecord => ({
        task_id: id,
        user_id: userId,
        type: "split_stems",
        status: "pending",
        progress: 0,
        input_file_id: "file_in",
        settings: {},
        created_at: iso(0),
        started_at: null,
        completed_at: null,
        output_file_id: null,
        slot_id: null,
        error: null,
        ...over,
    });

    try {
        // ── Files ────────────────────────────────────────────────────────
        await step("dbInsertFile/dbGetFile: round-trips fields, defaults kind to source and bpm to null, missing → null", async () => {
            await db.dbInsertFile(file("f_basic", "u1", { size_bytes: 123456789012, created_at: iso(5) }));
            const got = await db.dbGetFile("f_basic");
            assert.deepStrictEqual(got, {
                file_id: "f_basic",
                user_id: "u1",
                name: "f_basic.wav",
                size_bytes: 123456789012, // BIGINT comes back as a JS number
                mime_type: "audio/wav",
                local_path: "/tmp/f_basic.wav",
                bpm: null,
                kind: "source",
                created_at: iso(5),
            });

            await db.dbInsertFile(file("f_out", "u1", { kind: "output", bpm: 92.5 }));
            const out = await db.dbGetFile("f_out");
            assert.strictEqual(out!.kind, "output");
            assert.strictEqual(out!.bpm, 92.5);

            assert.strictEqual(await db.dbGetFile("f_missing"), null);
        });

        await step("dbUpdateFileBpm: sets then clears the stored tempo; unknown id is a no-op", async () => {
            await db.dbUpdateFileBpm("f_basic", 128);
            assert.strictEqual((await db.dbGetFile("f_basic"))!.bpm, 128);
            await db.dbUpdateFileBpm("f_basic", null);
            assert.strictEqual((await db.dbGetFile("f_basic"))!.bpm, null);
            await assert.doesNotReject(db.dbUpdateFileBpm("f_missing", 100));
        });

        await step("dbListFiles: every sort column/direction, default fallbacks, kind filter, user isolation", async () => {
            const user = "u_list";
            await db.dbInsertFile(file("fl_b", user, { name: "bravo.wav", size_bytes: 300, created_at: iso(10) }));
            await db.dbInsertFile(file("fl_c", user, { name: "charlie.wav", size_bytes: 100, created_at: iso(30) }));
            await db.dbInsertFile(file("fl_a", user, { name: "alpha.wav", size_bytes: 200, created_at: iso(20) }));
            await db.dbInsertFile(file("fl_out", user, { name: "zzz.sng", size_bytes: 1, created_at: iso(40), kind: "output" }));
            await db.dbInsertFile(file("fl_other", "u_other", { name: "aaa.wav", size_bytes: 1, created_at: iso(1) }));

            const ids = async (sort: string, order: string, kind?: "source" | "output") =>
                (await db.dbListFiles(user, 1, 50, sort, order, kind)).files.map((f) => f.file_id);

            assert.deepStrictEqual(await ids("name", "asc"), ["fl_a", "fl_b", "fl_c"]);
            assert.deepStrictEqual(await ids("name", "desc"), ["fl_c", "fl_b", "fl_a"]);
            assert.deepStrictEqual(await ids("size_bytes", "asc"), ["fl_c", "fl_a", "fl_b"]);
            assert.deepStrictEqual(await ids("size_bytes", "desc"), ["fl_b", "fl_a", "fl_c"]);
            assert.deepStrictEqual(await ids("created_at", "asc"), ["fl_b", "fl_a", "fl_c"]);
            assert.deepStrictEqual(await ids("created_at", "desc"), ["fl_c", "fl_a", "fl_b"]);
            // Anything that is not "desc" sorts ascending; an unknown column falls back to created_at.
            assert.deepStrictEqual(await ids("name", "sideways"), ["fl_a", "fl_b", "fl_c"]);
            assert.deepStrictEqual(await ids("bogus", "desc"), ["fl_c", "fl_a", "fl_b"]);
            assert.deepStrictEqual(await ids("bogus", "asc"), ["fl_b", "fl_a", "fl_c"]);
            // The kind filter selects generated outputs, never mixing them with sources.
            assert.deepStrictEqual(await ids("name", "asc", "output"), ["fl_out"]);
        });

        await step("dbListFiles: pagination slices the page while total counts every match; injection in sort is inert", async () => {
            const user = "u_list";
            const p1 = await db.dbListFiles(user, 1, 2, "name", "asc");
            const p2 = await db.dbListFiles(user, 2, 2, "name", "asc");
            const p3 = await db.dbListFiles(user, 3, 2, "name", "asc");
            assert.deepStrictEqual(p1.files.map((f) => f.file_id), ["fl_a", "fl_b"]);
            assert.deepStrictEqual(p2.files.map((f) => f.file_id), ["fl_c"]);
            assert.deepStrictEqual(p3.files, []);
            assert.deepStrictEqual([p1.total, p2.total, p3.total], [3, 3, 3]);

            const hostile = await db.dbListFiles(user, 1, 50, "name; DROP TABLE files; --", "desc");
            assert.strictEqual(hostile.total, 3);
            assert.strictEqual((await h.sql`SELECT COUNT(*)::int AS n FROM files`)[0]!.n > 0, true, "files table still exists");

            const nobody = await db.dbListFiles("u_nobody", 1, 10, "name", "asc");
            assert.deepStrictEqual(nobody, { files: [], total: 0 });
        });

        await step("dbDeleteFile removes only the targeted row", async () => {
            await db.dbDeleteFile("fl_other");
            assert.strictEqual(await db.dbGetFile("fl_other"), null);
            assert.ok(await db.dbGetFile("fl_a"));
            await assert.doesNotReject(db.dbDeleteFile("fl_other"));
        });

        await step("dbIsFileInUse: only non-terminal tasks reference a file as in use", async () => {
            const fileId = "f_inuse";
            assert.strictEqual(await db.dbIsFileInUse(fileId), false, "no tasks");
            let n = 0;
            for (const status of ["completed", "failed", "cancelled"] as const) {
                await db.dbInsertTask(task(`t_term_${n++}`, "u1", { input_file_id: fileId, status }));
            }
            assert.strictEqual(await db.dbIsFileInUse(fileId), false, "only terminal tasks");
            for (const status of ["pending", "queued", "assigned", "processing"] as const) {
                const f = `${fileId}_${status}`;
                await db.dbInsertTask(task(`t_live_${status}`, "u1", { input_file_id: f, status }));
                assert.strictEqual(await db.dbIsFileInUse(f), true, status);
            }
            assert.strictEqual(await db.dbIsFileInUse("f_unrelated"), false);
        });

        // ── Tasks ────────────────────────────────────────────────────────
        await step("dbInsertTask/dbGetTask: round-trips settings, error JSON and timestamps; missing → null", async () => {
            await db.dbInsertTask(
                task("t_full", "u1", {
                    type: "audio2chart",
                    status: "failed",
                    progress: 42.5,
                    settings: { difficulty: "hard", instrument: "guitar", nested: { a: [1, 2] } },
                    slot_id: "slot_1",
                    output_file_id: "f_out",
                    error: { code: "WORKER_ERROR", message: "boom" },
                    created_at: iso(1),
                    started_at: iso(2),
                    completed_at: iso(3),
                }),
            );
            assert.deepStrictEqual(await db.dbGetTask("t_full"), {
                task_id: "t_full",
                user_id: "u1",
                type: "audio2chart",
                status: "failed",
                progress: 42.5,
                input_file_id: "file_in",
                settings: { difficulty: "hard", instrument: "guitar", nested: { a: [1, 2] } },
                slot_id: "slot_1",
                output_file_id: "f_out",
                error: { code: "WORKER_ERROR", message: "boom" },
                created_at: iso(1),
                started_at: iso(2),
                completed_at: iso(3),
            });

            await db.dbInsertTask(task("t_min", "u1"));
            const min = await db.dbGetTask("t_min");
            assert.strictEqual(min!.error, null);
            assert.strictEqual(min!.started_at, null);
            assert.strictEqual(min!.completed_at, null);
            assert.strictEqual(min!.slot_id, null);
            assert.strictEqual(await db.dbGetTask("t_missing"), null);
        });

        await step("dbUpdateTask: updates only the provided columns, can set and clear error, empty update is a no-op", async () => {
            await db.dbInsertTask(task("t_upd", "u1", { settings: { keep: true } }));

            await db.dbUpdateTask("t_upd", {});
            assert.strictEqual((await db.dbGetTask("t_upd"))!.status, "pending");

            await db.dbUpdateTask("t_upd", { status: "processing" });
            let t = (await db.dbGetTask("t_upd"))!;
            assert.strictEqual(t.status, "processing");
            assert.strictEqual(t.progress, 0, "other columns untouched");

            await db.dbUpdateTask("t_upd", { progress: 55, slot_id: "slot_9", started_at: iso(7) });
            t = (await db.dbGetTask("t_upd"))!;
            assert.strictEqual(t.progress, 55);
            assert.strictEqual(t.slot_id, "slot_9");
            assert.strictEqual(t.started_at, iso(7));
            assert.strictEqual(t.status, "processing");

            await db.dbUpdateTask("t_upd", {
                status: "failed",
                error: { code: "X", message: "bad" },
                output_file_id: "f_o",
                completed_at: iso(8),
            });
            t = (await db.dbGetTask("t_upd"))!;
            assert.deepStrictEqual(t.error, { code: "X", message: "bad" });
            assert.strictEqual(t.output_file_id, "f_o");
            assert.strictEqual(t.completed_at, iso(8));

            await db.dbUpdateTask("t_upd", { status: "pending", error: null, slot_id: null });
            t = (await db.dbGetTask("t_upd"))!;
            assert.strictEqual(t.error, null, "null clears the error");
            assert.strictEqual(t.slot_id, null);
            assert.strictEqual(t.status, "pending");
            assert.deepStrictEqual(t.settings, { keep: true });

            await assert.doesNotReject(db.dbUpdateTask("t_ghost", { status: "failed" }));
        });

        await step("dbListTasks: status/type filters (alone and combined), newest first, pagination, user isolation", async () => {
            const user = "u_tasks";
            await db.dbInsertTask(task("tl_1", user, { type: "split_stems", status: "completed", created_at: iso(1) }));
            await db.dbInsertTask(task("tl_2", user, { type: "audio2chart", status: "completed", created_at: iso(2) }));
            await db.dbInsertTask(task("tl_3", user, { type: "audio2chart", status: "failed", created_at: iso(3) }));
            await db.dbInsertTask(task("tl_4", user, { type: "upload_s3", status: "pending", created_at: iso(4) }));
            await db.dbInsertTask(task("tl_other", "u_else", { type: "audio2chart", status: "completed", created_at: iso(5) }));

            const ids = async (status?: string, type?: string, page = 1, perPage = 50) => {
                const r = await db.dbListTasks(user, status, type, page, perPage);
                return { ids: r.tasks.map((t) => t.task_id), total: r.total };
            };

            assert.deepStrictEqual(await ids(), { ids: ["tl_4", "tl_3", "tl_2", "tl_1"], total: 4 });
            assert.deepStrictEqual(await ids("completed"), { ids: ["tl_2", "tl_1"], total: 2 });
            assert.deepStrictEqual(await ids(undefined, "audio2chart"), { ids: ["tl_3", "tl_2"], total: 2 });
            assert.deepStrictEqual(await ids("completed", "audio2chart"), { ids: ["tl_2"], total: 1 });
            assert.deepStrictEqual(await ids("pending", "split_stems"), { ids: [], total: 0 });
            assert.deepStrictEqual(await ids(undefined, undefined, 2, 3), { ids: ["tl_1"], total: 4 });
            assert.deepStrictEqual(await ids(undefined, undefined, 3, 3), { ids: [], total: 4 });

            // Filter values are bound parameters, not SQL text.
            assert.deepStrictEqual(await ids("' OR 1=1 --"), { ids: [], total: 0 });
            assert.deepStrictEqual(await ids(undefined, "audio2chart' OR '1'='1"), { ids: [], total: 0 });
        });

        await step("dbDeleteTask removes only the targeted task", async () => {
            await db.dbDeleteTask("tl_1");
            assert.strictEqual(await db.dbGetTask("tl_1"), null);
            assert.ok(await db.dbGetTask("tl_2"));
            await assert.doesNotReject(db.dbDeleteTask("tl_1"));
        });

        // ── Conversions ──────────────────────────────────────────────────
        const conversion = (id: string, userId: string, over: Partial<ConversionRecord> = {}): ConversionRecord => ({
            conversion_id: id,
            user_id: userId,
            status: "in_progress",
            input_file_id: "file_in",
            tasks: [],
            created_at: iso(0),
            ...over,
        });

        await step("dbInsertConversion/dbGetConversion: links tasks in creation order; missing → null", async () => {
            const user = "u_conv";
            await db.dbInsertTask(task("c1_upload", user, { type: "upload_s3", created_at: iso(3) }));
            await db.dbInsertTask(task("c1_split", user, { type: "split_stems", created_at: iso(1) }));
            await db.dbInsertTask(task("c1_a2c", user, { type: "audio2chart", status: "processing", created_at: iso(2) }));
            await db.dbInsertConversion(conversion("conv_1", user, { created_at: iso(10) }), ["c1_upload", "c1_split", "c1_a2c"]);

            const got = await db.dbGetConversion("conv_1");
            assert.ok(got);
            assert.strictEqual(got.status, "in_progress");
            assert.strictEqual(got.created_at, iso(10));
            assert.deepStrictEqual(got.tasks, [
                { task_id: "c1_split", type: "split_stems", status: "pending" },
                { task_id: "c1_a2c", type: "audio2chart", status: "processing" },
                { task_id: "c1_upload", type: "upload_s3", status: "pending" },
            ]);
            assert.deepStrictEqual(await db.dbGetConversionTasks("conv_1"), got.tasks);

            const records = await db.dbGetConversionTaskRecords("conv_1");
            assert.deepStrictEqual(records.map((t) => t.task_id), ["c1_split", "c1_a2c", "c1_upload"]);
            assert.strictEqual(records[1]!.user_id, user, "full records, not summaries");

            assert.strictEqual(await db.dbGetConversion("conv_missing"), null);
            assert.deepStrictEqual(await db.dbGetConversionTasks("conv_missing"), []);
            assert.deepStrictEqual(await db.dbGetConversionTaskRecords("conv_missing"), []);
        });

        await step("dbUpdateConversionStatus / dbListConversionsByStatus: status changes are visible and listing spans users oldest first", async () => {
            await db.dbInsertConversion(conversion("conv_s_late", "u_x", { created_at: iso(30) }), []);
            await db.dbInsertConversion(conversion("conv_s_early", "u_y", { created_at: iso(20) }), []);
            await db.dbInsertConversion(conversion("conv_s_done", "u_y", { status: "completed", created_at: iso(25) }), []);

            const inProgress = await db.dbListConversionsByStatus("in_progress");
            assert.deepStrictEqual(inProgress.map((c) => c.conversion_id), ["conv_1", "conv_s_early", "conv_s_late"]);
            assert.ok(inProgress.every((c) => c.tasks.length === 0), "listing by status does not load tasks");

            await db.dbUpdateConversionStatus("conv_s_early", "failed");
            assert.strictEqual((await db.dbGetConversion("conv_s_early"))!.status, "failed");
            assert.deepStrictEqual((await db.dbListConversionsByStatus("failed")).map((c) => c.conversion_id), ["conv_s_early"]);
            assert.deepStrictEqual((await db.dbListConversionsByStatus("in_progress")).map((c) => c.conversion_id), ["conv_1", "conv_s_late"]);
            await assert.doesNotReject(db.dbUpdateConversionStatus("conv_ghost", "completed"));
        });

        await step("dbListConversions: newest first with tasks attached, paginated, per-user", async () => {
            const user = "u_page";
            for (let i = 0; i < 3; i++) {
                await db.dbInsertTask(task(`pg_t${i}`, user, { created_at: iso(i) }));
                await db.dbInsertConversion(conversion(`conv_pg${i}`, user, { created_at: iso(100 + i) }), [`pg_t${i}`]);
            }
            const page1 = await db.dbListConversions(user, 1, 2);
            assert.deepStrictEqual(page1.conversions.map((c) => c.conversion_id), ["conv_pg2", "conv_pg1"]);
            assert.strictEqual(page1.total, 3);
            assert.deepStrictEqual(page1.conversions[0]!.tasks, [{ task_id: "pg_t2", type: "split_stems", status: "pending" }]);
            const page2 = await db.dbListConversions(user, 2, 2);
            assert.deepStrictEqual(page2.conversions.map((c) => c.conversion_id), ["conv_pg0"]);
            assert.deepStrictEqual(await db.dbListConversions("u_nobody", 1, 20), { conversions: [], total: 0 });
        });
    } finally {
        await h.close();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error("Runner error:", error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
});
