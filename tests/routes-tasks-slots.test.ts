/**
 * Route tests for /v1/tasks and /v1/internal/slots.
 *
 * Drives the REAL Express app (createApp) over HTTP with an in-memory pg-mem
 * database (see tests/helpers/harness.ts). Slots live in the process-local
 * store in src/server/stores.ts, which the tests reset between scenarios.
 *
 * Usage:  npx tsx tests/routes-tasks-slots.test.ts
 */

import { createHarness, type Harness } from "./helpers/harness.js";
import * as assert from "node:assert";

const INTERNAL_TOKEN = "internal-test-secret";
process.env.INTERNAL_API_TOKEN = INTERNAL_TOKEN;

let passed = 0;
let failed = 0;
async function step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`✓ ${name}`);
        passed++;
    } catch (err) {
        console.log(`✗ ${name}`);
        console.log(`    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        failed++;
    }
}

interface ApiErr {
    error: { code: string; message: string };
}
interface TaskOut {
    task_id: string;
    type: string;
    status: string;
    progress: number;
    input_file_id: string;
    settings: Record<string, unknown>;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    output_file_id: string | null;
    slot_id: string | null;
    error: { code: string; message: string } | null;
}
interface TaskList {
    tasks: TaskOut[];
    total: number;
    page: number;
    per_page: number;
}
interface SlotOut {
    slot_id: string;
    status: string;
    capabilities: string[];
    current_task_id: string | null;
    gpu_server: string | null;
}

async function main(): Promise<void> {
    const h: Harness = await createHarness();
    const { slots } = await import("../src/server/stores.js");

    try {
        const A = await h.registerAndLogin();
        const B = await h.registerAndLogin();

        // ── helpers ─────────────────────────────────────────────────────────
        function resetSlots(): void {
            for (const s of slots.values()) {
                s.status = "idle";
                s.current_task_id = null;
            }
        }
        async function seedFile(userId: string, id: string): Promise<string> {
            await h.sql`
                INSERT INTO files (file_id, user_id, name, size_bytes, mime_type, local_path)
                VALUES (${id}, ${userId}, ${id + ".wav"}, ${10}, ${"audio/wav"}, ${"/nonexistent/" + id + ".wav"})
            `;
            return id;
        }
        let seedCounter = 0;
        async function seedTask(
            userId: string,
            fileId: string,
            fields: { type?: string; status?: string; createdAt?: string } = {},
        ): Promise<string> {
            const id = `task_seed_${++seedCounter}`;
            await h.sql`
                INSERT INTO tasks (task_id, user_id, type, status, input_file_id, created_at)
                VALUES (${id}, ${userId}, ${fields.type ?? "split_stems"}, ${fields.status ?? "pending"}, ${fileId},
                        ${fields.createdAt ?? new Date().toISOString()})
            `;
            return id;
        }
        async function dbTask(id: string): Promise<Record<string, unknown> | undefined> {
            return (await h.sql`SELECT * FROM tasks WHERE task_id = ${id}`)[0];
        }
        const createTask = (token: string | undefined, json: unknown) =>
            h.request<TaskOut & ApiErr>("/v1/tasks", { method: "POST", token, json });
        const getTask = (token: string | undefined, id: string) =>
            h.request<TaskOut & ApiErr>(`/v1/tasks/${id}`, { token });
        const cancelTask = (token: string | undefined, id: string) =>
            h.request<ApiErr>(`/v1/tasks/${id}`, { method: "DELETE", token });
        const listTasks = (token: string | undefined, qs = "") =>
            h.request<TaskList & ApiErr>(`/v1/tasks${qs}`, { token });
        const internal = (p: string, opts: { method?: string; token?: string | null; json?: unknown } = {}) => {
            const headers: Record<string, string> = {};
            const tok = opts.token === undefined ? INTERNAL_TOKEN : opts.token;
            if (tok !== null) headers["x-internal-token"] = tok;
            return h.request<ApiErr & { ok?: boolean; slots?: SlotOut[] }>(`/v1/internal/slots${p}`, {
                method: opts.method ?? "GET",
                headers,
                ...(opts.json !== undefined ? { json: opts.json } : {}),
            });
        };

        const fileA = await seedFile(A.userId, "file_a_song");
        const fileB = await seedFile(B.userId, "file_b_song");

        // ═══════════════════════════════════════════════════════════════════
        // /v1/tasks
        // ═══════════════════════════════════════════════════════════════════

        await step("tasks: every endpoint rejects a missing or unknown bearer token with 401", async () => {
            const calls: Array<[string, string]> = [
                ["POST", "/v1/tasks"],
                ["GET", "/v1/tasks"],
                ["GET", "/v1/tasks/task_x"],
                ["DELETE", "/v1/tasks/task_x"],
            ];
            for (const [method, p] of calls) {
                const none = await h.request<ApiErr>(p, { method });
                assert.strictEqual(none.status, 401, `${method} ${p}`);
                assert.strictEqual(none.json.error.code, "UNAUTHORIZED");
                assert.strictEqual((await h.request(p, { method, token: "nope" })).status, 401);
            }
        });

        await step("create: invalid or missing task type → 400", async () => {
            for (const body of [
                { input_file_id: fileA },
                { type: "", input_file_id: fileA },
                { type: "mix_stems", input_file_id: fileA },
                { type: "SPLIT_STEMS", input_file_id: fileA },
                { type: "toString", input_file_id: fileA },
                { type: 7, input_file_id: fileA },
            ]) {
                const res = await createTask(A.token, body);
                assert.strictEqual(res.status, 400, JSON.stringify(body));
                assert.strictEqual(res.json.error.code, "BAD_REQUEST");
                assert.match(res.json.error.message, /task type/);
            }
        });

        await step("create: missing input_file_id → 400", async () => {
            for (const body of [{ type: "split_stems" }, { type: "split_stems", input_file_id: "" }]) {
                const res = await createTask(A.token, body);
                assert.strictEqual(res.status, 400);
                assert.strictEqual(res.json.error.code, "BAD_REQUEST");
                assert.match(res.json.error.message, /input_file_id is required/);
            }
        });

        await step("create: type is validated before the file lookup", async () => {
            const res = await createTask(A.token, { type: "bogus", input_file_id: "file_does_not_exist" });
            assert.strictEqual(res.status, 400);
        });

        await step("create: unknown file and another user's file → identical 404, no task row created", async () => {
            const before = (await h.sql`SELECT COUNT(*)::int AS n FROM tasks`)[0]!.n;
            const missing = await createTask(A.token, { type: "split_stems", input_file_id: "file_does_not_exist" });
            const foreign = await createTask(A.token, { type: "split_stems", input_file_id: fileB });
            assert.strictEqual(missing.status, 404);
            assert.strictEqual(missing.json.error.code, "NOT_FOUND");
            assert.strictEqual(foreign.status, 404);
            assert.deepStrictEqual(foreign.json, missing.json, "no existence leak");
            assert.strictEqual((await h.sql`SELECT COUNT(*)::int AS n FROM tasks`)[0]!.n, before);
        });

        await step("create: default settings per task type", async () => {
            resetSlots();
            for (const s of slots.values()) s.status = "busy"; // keep everything queued; irrelevant here
            const split = await createTask(A.token, { type: "split_stems", input_file_id: fileA });
            const chart = await createTask(A.token, { type: "audio2chart", input_file_id: fileA });
            const s3 = await createTask(A.token, { type: "upload_s3", input_file_id: fileA });
            for (const r of [split, chart, s3]) assert.strictEqual(r.status, 201, r.text);
            assert.deepStrictEqual(split.json.settings, { stems: 4, model: "orion" });
            assert.deepStrictEqual(chart.json.settings, { difficulty: "expert", instrument: "guitar" });
            assert.deepStrictEqual(s3.json.settings, {});
            // persisted, not just echoed
            assert.deepStrictEqual((await dbTask(split.json.task_id))?.settings, { stems: 4, model: "orion" });
            resetSlots();
        });

        await step("create: explicit settings replace the defaults verbatim; settings:null falls back to defaults", async () => {
            for (const s of slots.values()) s.status = "busy";
            const custom = { stems: 2, model: "andromeda", nested: { a: [1, 2, 3] } };
            const res = await createTask(A.token, { type: "split_stems", input_file_id: fileA, settings: custom });
            assert.strictEqual(res.status, 201);
            assert.deepStrictEqual(res.json.settings, custom);
            assert.deepStrictEqual((await dbTask(res.json.task_id))?.settings, custom);

            const empty = await createTask(A.token, { type: "split_stems", input_file_id: fileA, settings: {} });
            assert.deepStrictEqual(empty.json.settings, {}, "an explicit empty object is honoured, not defaulted");

            const nul = await createTask(A.token, { type: "audio2chart", input_file_id: fileA, settings: null });
            assert.deepStrictEqual(nul.json.settings, { difficulty: "expert", instrument: "guitar" });
            resetSlots();
        });

        await step("create: response shape for a fresh task, and the public view hides user_id", async () => {
            for (const s of slots.values()) s.status = "busy";
            const res = await createTask(A.token, { type: "upload_s3", input_file_id: fileA });
            assert.strictEqual(res.status, 201);
            assert.match(res.json.task_id, /^task_[0-9a-f-]{36}$/);
            assert.strictEqual(res.json.type, "upload_s3");
            assert.strictEqual(res.json.input_file_id, fileA);
            assert.strictEqual(res.json.progress, 0);
            assert.strictEqual(res.json.started_at, null);
            assert.strictEqual(res.json.completed_at, null);
            assert.strictEqual(res.json.output_file_id, null);
            assert.strictEqual(res.json.error, null);
            assert.ok(!Number.isNaN(Date.parse(res.json.created_at)));
            assert.ok(!("user_id" in res.json));
            const row = await dbTask(res.json.task_id);
            assert.strictEqual(row?.user_id, A.userId);
            resetSlots();
        });

        await step("scheduling: a task is assigned to an idle slot that has the capability", async () => {
            resetSlots();
            const res = await createTask(A.token, { type: "split_stems", input_file_id: fileA });
            assert.strictEqual(res.status, 201);
            assert.strictEqual(res.json.status, "assigned");
            assert.strictEqual(res.json.slot_id, "slot_01");
            const slot = slots.get("slot_01")!;
            assert.strictEqual(slot.status, "busy");
            assert.strictEqual(slot.current_task_id, res.json.task_id);
            assert.strictEqual(slots.get("slot_02")!.status, "idle", "other slots untouched");
            const row = await dbTask(res.json.task_id);
            assert.strictEqual(row?.status, "assigned");
            assert.strictEqual(row?.slot_id, "slot_01");
            const got = await getTask(A.token, res.json.task_id);
            assert.strictEqual(got.json.status, "assigned");
            assert.strictEqual(got.json.slot_id, "slot_01");
        });

        await step("scheduling: capability decides which slot — audio2chart goes to slot_02, not the idle slot_01", async () => {
            resetSlots();
            const res = await createTask(A.token, { type: "audio2chart", input_file_id: fileA });
            assert.strictEqual(res.json.status, "assigned");
            assert.strictEqual(res.json.slot_id, "slot_02");
            assert.strictEqual(slots.get("slot_01")!.status, "idle");
            assert.strictEqual(slots.get("slot_02")!.current_task_id, res.json.task_id);
        });

        await step("scheduling: with every capable slot busy the task stays queued with no slot", async () => {
            resetSlots();
            const first = await createTask(A.token, { type: "split_stems", input_file_id: fileA });
            assert.strictEqual(first.json.status, "assigned");
            const second = await createTask(A.token, { type: "split_stems", input_file_id: fileA });
            assert.strictEqual(second.status, 201);
            assert.strictEqual(second.json.status, "queued");
            assert.strictEqual(second.json.slot_id, null);
            const row = await dbTask(second.json.task_id);
            assert.strictEqual(row?.status, "queued");
            assert.strictEqual(row?.slot_id, null);
            assert.strictEqual(slots.get("slot_01")!.current_task_id, first.json.task_id, "busy slot keeps its task");

            // upload_s3 is also served only by slot_01, which is busy → queued as well.
            const s3 = await createTask(A.token, { type: "upload_s3", input_file_id: fileA });
            assert.strictEqual(s3.json.status, "queued");
            // …while audio2chart still finds its idle slot.
            const chart = await createTask(A.token, { type: "audio2chart", input_file_id: fileA });
            assert.strictEqual(chart.json.status, "assigned");
        });

        await step("scheduling: a task created while no slots exist at all stays queued", async () => {
            const saved = [...slots.entries()];
            slots.clear();
            try {
                const res = await createTask(A.token, { type: "split_stems", input_file_id: fileA });
                assert.strictEqual(res.status, 201);
                assert.strictEqual(res.json.status, "queued");
            } finally {
                for (const [k, v] of saved) slots.set(k, v);
                resetSlots();
            }
        });

        // ── GET /v1/tasks/:id ───────────────────────────────────────────────

        await step("get: returns the task; unknown id and another user's task are identical 404s", async () => {
            resetSlots();
            const made = await createTask(A.token, { type: "audio2chart", input_file_id: fileA });
            const own = await getTask(A.token, made.json.task_id);
            assert.strictEqual(own.status, 200);
            assert.deepStrictEqual(own.json, made.json, "GET mirrors what POST returned");

            const missing = await getTask(A.token, "task_nope");
            const foreign = await getTask(B.token, made.json.task_id);
            assert.strictEqual(missing.status, 404);
            assert.strictEqual(missing.json.error.code, "NOT_FOUND");
            assert.strictEqual(foreign.status, 404);
            assert.deepStrictEqual(foreign.json, missing.json);
            resetSlots();
        });

        await step("get: error and timestamps from the DB are surfaced for a failed task", async () => {
            const id = await seedTask(A.userId, fileA, { status: "failed" });
            await h.sql`
                UPDATE tasks SET error = ${JSON.stringify({ code: "SPLIT_FAILED", message: "boom" })}::jsonb,
                       started_at = ${"2024-02-01T10:00:00.000Z"}, completed_at = ${"2024-02-01T10:05:00.000Z"},
                       progress = ${0.5}, output_file_id = ${"file_out"} WHERE task_id = ${id}
            `;
            const res = await getTask(A.token, id);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json.status, "failed");
            assert.deepStrictEqual(res.json.error, { code: "SPLIT_FAILED", message: "boom" });
            assert.strictEqual(res.json.started_at, "2024-02-01T10:00:00.000Z");
            assert.strictEqual(res.json.completed_at, "2024-02-01T10:05:00.000Z");
            assert.strictEqual(res.json.progress, 0.5);
            assert.strictEqual(res.json.output_file_id, "file_out");
        });

        // ── GET /v1/tasks (list) ────────────────────────────────────────────

        const C = await h.registerAndLogin();
        const fileC = await seedFile(C.userId, "file_c_song");
        const t0 = Date.parse("2024-03-01T00:00:00Z");
        const at = (i: number) => new Date(t0 + i * 60_000).toISOString();
        const cIds = {
            a: await seedTask(C.userId, fileC, { type: "split_stems", status: "completed", createdAt: at(1) }),
            b: await seedTask(C.userId, fileC, { type: "audio2chart", status: "pending", createdAt: at(2) }),
            c: await seedTask(C.userId, fileC, { type: "audio2chart", status: "completed", createdAt: at(3) }),
            d: await seedTask(C.userId, fileC, { type: "upload_s3", status: "failed", createdAt: at(4) }),
            e: await seedTask(C.userId, fileC, { type: "audio2chart", status: "completed", createdAt: at(5) }),
        };
        const taskIds = (r: { json: TaskList }) => r.json.tasks.map((t) => t.task_id);

        await step("list: newest first with total, page and per_page", async () => {
            const res = await listTasks(C.token);
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(taskIds(res), [cIds.e, cIds.d, cIds.c, cIds.b, cIds.a]);
            assert.strictEqual(res.json.total, 5);
            assert.strictEqual(res.json.page, 1);
            assert.strictEqual(res.json.per_page, 20);
            assert.ok(!("user_id" in res.json.tasks[0]!));
        });

        await step("list: filters by status, by type, and by both", async () => {
            const byStatus = await listTasks(C.token, "?status=completed");
            assert.deepStrictEqual(taskIds(byStatus), [cIds.e, cIds.c, cIds.a]);
            assert.strictEqual(byStatus.json.total, 3);

            const byType = await listTasks(C.token, "?type=audio2chart");
            assert.deepStrictEqual(taskIds(byType), [cIds.e, cIds.c, cIds.b]);
            assert.strictEqual(byType.json.total, 3);

            const both = await listTasks(C.token, "?status=completed&type=audio2chart");
            assert.deepStrictEqual(taskIds(both), [cIds.e, cIds.c]);
            assert.strictEqual(both.json.total, 2);

            const none = await listTasks(C.token, "?status=processing");
            assert.deepStrictEqual(none.json.tasks, []);
            assert.strictEqual(none.json.total, 0);

            const bogus = await listTasks(C.token, "?type=not_a_type");
            assert.strictEqual(bogus.status, 200);
            assert.strictEqual(bogus.json.total, 0);
        });

        await step("list: pagination returns slices and keeps the full total", async () => {
            const p1 = await listTasks(C.token, "?per_page=2");
            assert.deepStrictEqual(taskIds(p1), [cIds.e, cIds.d]);
            assert.strictEqual(p1.json.total, 5);
            const p2 = await listTasks(C.token, "?per_page=2&page=2");
            assert.deepStrictEqual(taskIds(p2), [cIds.c, cIds.b]);
            const p3 = await listTasks(C.token, "?per_page=2&page=3");
            assert.deepStrictEqual(taskIds(p3), [cIds.a]);
            const p4 = await listTasks(C.token, "?per_page=2&page=4");
            assert.deepStrictEqual(p4.json.tasks, []);
            assert.strictEqual(p4.json.total, 5);
            const filtered = await listTasks(C.token, "?status=completed&per_page=2&page=2");
            assert.deepStrictEqual(taskIds(filtered), [cIds.a]);
            assert.strictEqual(filtered.json.total, 3);
        });

        await step("list: page and per_page are clamped (per_page 1..100, page>=1, junk → defaults)", async () => {
            assert.strictEqual((await listTasks(C.token, "?per_page=5000")).json.per_page, 100);
            const neg = await listTasks(C.token, "?per_page=-4&page=-2");
            assert.strictEqual(neg.json.per_page, 1);
            assert.strictEqual(neg.json.page, 1);
            assert.strictEqual(neg.json.tasks.length, 1);
            const zero = await listTasks(C.token, "?per_page=0&page=0");
            assert.strictEqual(zero.json.per_page, 20);
            assert.strictEqual(zero.json.page, 1);
            const junk = await listTasks(C.token, "?per_page=lots&page=first");
            assert.strictEqual(junk.json.per_page, 20);
            assert.strictEqual(junk.json.page, 1);
        });

        await step("list: only the caller's tasks appear; a user with none gets an empty list", async () => {
            const fresh = await h.registerAndLogin();
            const empty = await listTasks(fresh.token);
            assert.strictEqual(empty.status, 200);
            assert.deepStrictEqual(empty.json.tasks, []);
            assert.strictEqual(empty.json.total, 0);
            const forB = await listTasks(B.token, "?per_page=100");
            for (const id of Object.values(cIds)) assert.ok(!taskIds(forB).includes(id), "C's tasks hidden from B");
            const forC = await listTasks(C.token, "?per_page=100");
            assert.ok(taskIds(forC).every((id) => Object.values(cIds).includes(id)));
        });

        // ── DELETE /v1/tasks/:id (cancel) ───────────────────────────────────

        await step("cancel: pending and queued tasks → 204 and status becomes cancelled", async () => {
            const pending = await seedTask(A.userId, fileA, { status: "pending" });
            const queued = await seedTask(A.userId, fileA, { status: "queued" });
            for (const id of [pending, queued]) {
                const res = await cancelTask(A.token, id);
                assert.strictEqual(res.status, 204, id);
                assert.strictEqual(res.text, "");
                assert.strictEqual((await dbTask(id))?.status, "cancelled");
                assert.strictEqual((await getTask(A.token, id)).json.status, "cancelled");
            }
        });

        await step("cancel: assigned, processing, completed, failed and already-cancelled tasks → 409 and unchanged", async () => {
            for (const status of ["assigned", "processing", "completed", "failed", "cancelled"]) {
                const id = await seedTask(A.userId, fileA, { status });
                const res = await cancelTask(A.token, id);
                assert.strictEqual(res.status, 409, status);
                assert.strictEqual(res.json.error.code, "CONFLICT");
                assert.match(res.json.error.message, /cannot be cancelled/);
                assert.strictEqual((await dbTask(id))?.status, status, "status untouched");
            }
        });

        await step("cancel: a task created through the API is cancellable only while queued", async () => {
            resetSlots();
            const assigned = await createTask(A.token, { type: "split_stems", input_file_id: fileA });
            const queued = await createTask(A.token, { type: "split_stems", input_file_id: fileA });
            assert.strictEqual(assigned.json.status, "assigned");
            assert.strictEqual(queued.json.status, "queued");
            assert.strictEqual((await cancelTask(A.token, assigned.json.task_id)).status, 409);
            assert.strictEqual((await cancelTask(A.token, queued.json.task_id)).status, 204);
            assert.strictEqual((await cancelTask(A.token, queued.json.task_id)).status, 409, "second cancel");
            resetSlots();
        });

        await step("cancel: unknown task and another user's task → 404, victim's task keeps its status", async () => {
            const id = await seedTask(A.userId, fileA, { status: "pending" });
            const foreign = await cancelTask(B.token, id);
            assert.strictEqual(foreign.status, 404);
            assert.strictEqual(foreign.json.error.code, "NOT_FOUND");
            assert.strictEqual((await dbTask(id))?.status, "pending");
            assert.strictEqual((await cancelTask(A.token, "task_nope")).status, 404);
        });

        await step("cancel releases the file: delete is 409 while a task is pending, 204 once it is cancelled", async () => {
            const lone = await seedFile(A.userId, "file_a_lonely");
            const id = await seedTask(A.userId, lone, { status: "pending" });
            const blocked = await h.request<ApiErr>(`/v1/files/${lone}`, { method: "DELETE", token: A.token });
            assert.strictEqual(blocked.status, 409);
            assert.strictEqual((await cancelTask(A.token, id)).status, 204);
            const freed = await h.request(`/v1/files/${lone}`, { method: "DELETE", token: A.token });
            assert.strictEqual(freed.status, 204);
        });

        // ═══════════════════════════════════════════════════════════════════
        // /v1/internal/slots
        // ═══════════════════════════════════════════════════════════════════

        await step("slots: fail-closed — with INTERNAL_API_TOKEN unset every endpoint is 503, even with a header", async () => {
            delete process.env.INTERNAL_API_TOKEN;
            try {
                const calls: Array<[string, string]> = [
                    ["GET", ""],
                    ["POST", "/slot_01/assign"],
                    ["POST", "/slot_01/release"],
                ];
                for (const [method, p] of calls) {
                    for (const token of [null, INTERNAL_TOKEN, ""]) {
                        const res = await internal(p, { method, token, json: method === "POST" ? { task_id: "x" } : undefined });
                        assert.strictEqual(res.status, 503, `${method} ${p} token=${token}`);
                        assert.strictEqual(res.json.error.code, "INTERNAL_AUTH_NOT_CONFIGURED");
                    }
                }
                // The 503 must not have mutated anything.
                assert.strictEqual(slots.get("slot_01")!.status, "idle");
            } finally {
                process.env.INTERNAL_API_TOKEN = INTERNAL_TOKEN;
            }
        });

        await step("slots: an empty INTERNAL_API_TOKEN also counts as unconfigured (503)", async () => {
            process.env.INTERNAL_API_TOKEN = "";
            try {
                assert.strictEqual((await internal("", { token: "" })).status, 503);
            } finally {
                process.env.INTERNAL_API_TOKEN = INTERNAL_TOKEN;
            }
        });

        await step("slots: missing or wrong internal token → 403 on every endpoint, nothing mutated", async () => {
            resetSlots();
            const taskId = await seedTask(A.userId, fileA, { status: "pending" });
            const wrong = [null, "", "wrong", INTERNAL_TOKEN + "x", INTERNAL_TOKEN.slice(0, -1), INTERNAL_TOKEN.toUpperCase()];
            const calls: Array<[string, string]> = [
                ["GET", ""],
                ["POST", "/slot_01/assign"],
                ["POST", "/slot_01/release"],
            ];
            slots.get("slot_01")!.status = "busy";
            for (const [method, p] of calls) {
                for (const token of wrong) {
                    const res = await internal(p, { method, token, json: method === "POST" ? { task_id: taskId } : undefined });
                    assert.strictEqual(res.status, 403, `${method} ${p} token=${JSON.stringify(token)}`);
                    assert.strictEqual(res.json.error.code, "FORBIDDEN");
                }
            }
            assert.strictEqual(slots.get("slot_01")!.status, "busy", "403 release did not free the slot");
            assert.strictEqual((await dbTask(taskId))?.status, "pending", "403 assign did not touch the task");
            resetSlots();
        });

        await step("slots: a user's bearer token is not a substitute for the internal token", async () => {
            const res = await h.request<ApiErr>("/v1/internal/slots", { token: A.token });
            assert.strictEqual(res.status, 403);
            const both = await h.request<ApiErr>("/v1/internal/slots", { token: A.token, headers: { "x-internal-token": "nope" } });
            assert.strictEqual(both.status, 403);
        });

        await step("slots: GET lists the pre-seeded slots and reflects live state", async () => {
            resetSlots();
            const idle = await internal("");
            assert.strictEqual(idle.status, 200);
            assert.deepStrictEqual(idle.json.slots, [
                { slot_id: "slot_01", status: "idle", capabilities: ["split_stems", "upload_s3"], current_task_id: null, gpu_server: null },
                { slot_id: "slot_02", status: "idle", capabilities: ["audio2chart"], current_task_id: null, gpu_server: "gpu-01.internal" },
            ]);
            const task = await createTask(A.token, { type: "split_stems", input_file_id: fileA });
            const busy = await internal("");
            const s1 = busy.json.slots!.find((s) => s.slot_id === "slot_01")!;
            assert.strictEqual(s1.status, "busy");
            assert.strictEqual(s1.current_task_id, task.json.task_id);
            resetSlots();
        });

        await step("assign: binds an idle capable slot to a task — slot busy, task assigned with slot_id", async () => {
            resetSlots();
            const taskId = await seedTask(A.userId, fileA, { type: "audio2chart", status: "queued" });
            const res = await internal("/slot_02/assign", { method: "POST", json: { task_id: taskId } });
            assert.strictEqual(res.status, 200, res.text);
            assert.deepStrictEqual(res.json, { ok: true });
            assert.strictEqual(slots.get("slot_02")!.status, "busy");
            assert.strictEqual(slots.get("slot_02")!.current_task_id, taskId);
            const row = await dbTask(taskId);
            assert.strictEqual(row?.status, "assigned");
            assert.strictEqual(row?.slot_id, "slot_02");
            // visible to the task's owner through the public API
            const pub = await getTask(A.token, taskId);
            assert.strictEqual(pub.json.status, "assigned");
            assert.strictEqual(pub.json.slot_id, "slot_02");
            resetSlots();
        });

        await step("assign: unknown slot → 404", async () => {
            const taskId = await seedTask(A.userId, fileA);
            const res = await internal("/slot_99/assign", { method: "POST", json: { task_id: taskId } });
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.json.error.code, "NOT_FOUND");
            assert.match(res.json.error.message, /Slot/);
            assert.strictEqual((await dbTask(taskId))?.status, "pending");
        });

        await step("assign: missing task_id → 400; unknown task → 404", async () => {
            resetSlots();
            const missing = await internal("/slot_01/assign", { method: "POST", json: {} });
            assert.strictEqual(missing.status, 400);
            assert.strictEqual(missing.json.error.code, "BAD_REQUEST");
            assert.match(missing.json.error.message, /task_id is required/);
            const unknown = await internal("/slot_01/assign", { method: "POST", json: { task_id: "task_ghost" } });
            assert.strictEqual(unknown.status, 404);
            assert.match(unknown.json.error.message, /Task/);
            assert.strictEqual(slots.get("slot_01")!.status, "idle", "failed assigns leave the slot idle");
        });

        await step("assign: busy slot → 409 and the existing assignment is preserved", async () => {
            resetSlots();
            const first = await seedTask(A.userId, fileA, { status: "queued" });
            const second = await seedTask(A.userId, fileA, { status: "queued" });
            assert.strictEqual((await internal("/slot_01/assign", { method: "POST", json: { task_id: first } })).status, 200);
            const res = await internal("/slot_01/assign", { method: "POST", json: { task_id: second } });
            assert.strictEqual(res.status, 409);
            assert.strictEqual(res.json.error.code, "CONFLICT");
            assert.match(res.json.error.message, /busy/);
            assert.strictEqual(slots.get("slot_01")!.current_task_id, first);
            assert.strictEqual((await dbTask(second))?.status, "queued");
            assert.strictEqual((await dbTask(second))?.slot_id, null);
            resetSlots();
        });

        await step("assign: slot lacking the task's capability → 400 naming the capability; nothing changes", async () => {
            resetSlots();
            const chartTask = await seedTask(A.userId, fileA, { type: "audio2chart", status: "queued" });
            const res = await internal("/slot_01/assign", { method: "POST", json: { task_id: chartTask } });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.json.error.code, "BAD_REQUEST");
            assert.match(res.json.error.message, /does not have capability "audio2chart"/);
            assert.strictEqual(slots.get("slot_01")!.status, "idle");
            assert.strictEqual((await dbTask(chartTask))?.status, "queued");
            // the reverse mismatch
            const splitTask = await seedTask(A.userId, fileA, { type: "split_stems", status: "queued" });
            const res2 = await internal("/slot_02/assign", { method: "POST", json: { task_id: splitTask } });
            assert.strictEqual(res2.status, 400);
            assert.match(res2.json.error.message, /"split_stems"/);
        });

        await step("assign: check order — a busy slot answers 409 before the capability check, 404 task before 409", async () => {
            resetSlots();
            slots.get("slot_01")!.status = "busy";
            const chartTask = await seedTask(A.userId, fileA, { type: "audio2chart", status: "queued" });
            assert.strictEqual((await internal("/slot_01/assign", { method: "POST", json: { task_id: chartTask } })).status, 409);
            assert.strictEqual((await internal("/slot_01/assign", { method: "POST", json: { task_id: "task_ghost" } })).status, 404);
            resetSlots();
        });

        await step("release: frees a busy slot (200) and is idempotent on an idle one", async () => {
            resetSlots();
            const taskId = await seedTask(A.userId, fileA, { status: "queued" });
            await internal("/slot_01/assign", { method: "POST", json: { task_id: taskId } });
            assert.strictEqual(slots.get("slot_01")!.status, "busy");
            const res = await internal("/slot_01/release", { method: "POST" });
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(res.json, { ok: true });
            assert.strictEqual(slots.get("slot_01")!.status, "idle");
            assert.strictEqual(slots.get("slot_01")!.current_task_id, null);
            const again = await internal("/slot_01/release", { method: "POST" });
            assert.strictEqual(again.status, 200);
            assert.strictEqual(slots.get("slot_01")!.status, "idle");
        });

        await step("release: unknown slot → 404", async () => {
            const res = await internal("/slot_99/release", { method: "POST" });
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.json.error.code, "NOT_FOUND");
        });

        await step("lifecycle: task occupies a slot, a queued task waits, release lets the next task take it", async () => {
            resetSlots();
            const one = await createTask(A.token, { type: "split_stems", input_file_id: fileA });
            const two = await createTask(A.token, { type: "split_stems", input_file_id: fileA });
            assert.strictEqual(one.json.slot_id, "slot_01");
            assert.strictEqual(two.json.status, "queued");

            assert.strictEqual((await internal("/slot_01/release", { method: "POST" })).status, 200);
            // A queued task is bound to the freed slot via assign (the worker/scheduler's job).
            const assign = await internal("/slot_01/assign", { method: "POST", json: { task_id: two.json.task_id } });
            assert.strictEqual(assign.status, 200);
            const after = await getTask(A.token, two.json.task_id);
            assert.strictEqual(after.json.status, "assigned");
            assert.strictEqual(after.json.slot_id, "slot_01");

            // and brand-new work created after a release is scheduled onto the freed slot directly
            await internal("/slot_01/release", { method: "POST" });
            const three = await createTask(A.token, { type: "upload_s3", input_file_id: fileA });
            assert.strictEqual(three.json.status, "assigned");
            assert.strictEqual(three.json.slot_id, "slot_01");
            resetSlots();
        });
    } finally {
        await h.close();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
