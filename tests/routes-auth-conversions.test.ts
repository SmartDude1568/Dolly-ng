/**
 * HTTP tests for the auth and conversions routes (src/server/routes/auth.ts and
 * src/server/routes/conversions.ts).
 *
 * Drives the REAL Express app + REAL conversion worker through the shared
 * hermetic harness (in-memory pg-mem DB, ephemeral port). LALAL and Modal are
 * replaced by in-process fakes via setWorkerExternals(); ffmpeg runs for real.
 *
 * Usage:  npx tsx tests/routes-auth-conversions.test.ts
 */

import { createHarness, writeSilentWav } from "./helpers/harness.js";
import * as assert from "node:assert";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

interface ApiError {
    error: { code: string; message: string };
}
interface TaskSummary {
    task_id: string;
    type: string;
    status: string;
}
interface ConversionBody {
    conversion_id: string;
    status: string;
    input_file_id: string;
    tasks: TaskSummary[];
    created_at: string;
    download_url: string | null;
}
interface ConversionList {
    conversions: ConversionBody[];
    total: number;
    page: number;
    per_page: number;
}
interface LoginBody {
    token: string;
    expires_at: string;
    user_id: string;
}
interface RegisterBody {
    status: string;
    message: string;
}

const FAKE_CHART = `[Song]
{
  Name = "Fake"
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 90000
}
[Events]
{
}
[ExpertSingle]
{
  768 = N 0 0
  960 = N 1 0
  1152 = N 2 0
}`;

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

/** Compact .sng unpacker: returns the (unmasked) files inside the archive. */
function unpackSng(buf: Buffer): { magic: string; files: Map<string, Buffer> } {
    const magic = buf.toString("ascii", 0, 6);
    const xorMask = buf.subarray(10, 26);
    let off = 26;
    const metaLen = Number(buf.readBigUInt64LE(off));
    off += 8 + metaLen;
    const fileMetaLen = Number(buf.readBigUInt64LE(off));
    off += 8;
    const indexEnd = off + fileMetaLen;
    const fileCount = Number(buf.readBigUInt64LE(off));
    off += 8;
    const index: { name: string; len: number; abs: number }[] = [];
    for (let i = 0; i < fileCount; i++) {
        const nameLen = buf.readUInt8(off);
        off += 1;
        const name = buf.toString("utf8", off, off + nameLen);
        off += nameLen;
        const len = Number(buf.readBigUInt64LE(off));
        off += 8;
        const abs = Number(buf.readBigUInt64LE(off));
        off += 8;
        index.push({ name, len, abs });
    }
    void indexEnd;
    const files = new Map<string, Buffer>();
    for (const { name, len, abs } of index) {
        const masked = buf.subarray(abs, abs + len);
        const data = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) data[i] = masked[i]! ^ (xorMask[i % 16]! ^ (i & 0xff));
        files.set(name, data);
    }
    return { magic, files };
}

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
    const { setWorkerExternals } = await import("../src/server/worker.js");

    // ── Controllable fakes for LALAL + Modal ─────────────────────────────
    const fake = {
        splitCalls: [] as { input: string; stems: string[] }[],
        chartCalls: [] as { audioPath: string; name: string | undefined; sustains: boolean | undefined; beatAudioPath: string | undefined }[],
        chartClientBpms: [] as (number | undefined)[],
        failSplit: false,
        gate: null as Promise<void> | null,
    };
    setWorkerExternals({
        createSplitter(outputDir: string) {
            return {
                async split(input: string, stems: string[]) {
                    fake.splitCalls.push({ input, stems: [...stems] });
                    if (fake.gate) await fake.gate;
                    if (fake.failSplit) throw new Error("fake split boom");
                    const base = path.basename(input, path.extname(input));
                    fs.mkdirSync(outputDir, { recursive: true });
                    return {
                        stems: stems.map((stem) => {
                            const p = path.join(outputDir, `${base}_${stem}.wav`);
                            fs.copyFileSync(input, p);
                            return { stem: stem as never, path: p };
                        }),
                    };
                },
            };
        },
        createChartClient(opts: { bpm: number | undefined }) {
            fake.chartClientBpms.push(opts.bpm);
            return {
                async generateText(
                    audioPath: string,
                    overrides?: { name?: string; sustains?: boolean; beatAudioPath?: string },
                ) {
                    fake.chartCalls.push({
                        audioPath,
                        name: overrides?.name,
                        sustains: overrides?.sustains,
                        beatAudioPath: overrides?.beatAudioPath,
                    });
                    return FAKE_CHART;
                },
            };
        },
    });

    // ── Helpers ──────────────────────────────────────────────────────────
    const uploadsDir = path.join(h.workRoot, "uploads");
    const longWav = path.join(uploadsDir, "long.wav");
    const shortWav = path.join(uploadsDir, "short.wav");
    const garbageWav = path.join(uploadsDir, "garbage.wav");
    writeSilentWav(longWav, 31); // > 30 s so the duration gate passes
    writeSilentWav(shortWav, 5);
    fs.writeFileSync(garbageWav, "this is definitely not audio");

    let fileCounter = 0;
    async function seedFile(
        userId: string,
        opts: { name?: string; localPath?: string; kind?: "source" | "output"; bpm?: number | null } = {},
    ): Promise<string> {
        const fileId = `file_seed${++fileCounter}`;
        await h.sql`
            INSERT INTO files (file_id, user_id, name, size_bytes, mime_type, local_path, bpm, kind)
            VALUES (${fileId}, ${userId}, ${opts.name ?? "Seed Song.wav"}, ${1000}, ${"audio/wav"},
                    ${opts.localPath ?? longWav}, ${opts.bpm ?? null}, ${opts.kind ?? "source"})
        `;
        return fileId;
    }

    async function seedConversion(args: {
        conversionId: string;
        userId: string;
        status: string;
        inputFileId: string;
        createdAt: string;
        tasks?: { id: string; type: string; status: string; outputFileId?: string | null }[];
    }): Promise<void> {
        await h.sql`
            INSERT INTO conversions (conversion_id, user_id, status, input_file_id, created_at)
            VALUES (${args.conversionId}, ${args.userId}, ${args.status}, ${args.inputFileId}, ${args.createdAt})
        `;
        for (const t of args.tasks ?? []) {
            await h.sql`
                INSERT INTO tasks (task_id, user_id, type, status, input_file_id, output_file_id, created_at)
                VALUES (${t.id}, ${args.userId}, ${t.type}, ${t.status}, ${args.inputFileId},
                        ${t.outputFileId ?? null}, ${args.createdAt})
            `;
            await h.sql`INSERT INTO conversion_tasks (conversion_id, task_id) VALUES (${args.conversionId}, ${t.id})`;
        }
    }

    async function waitForTerminal(token: string, conversionId: string, timeoutMs = 120_000): Promise<ConversionBody> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const res = await h.request<ConversionBody>(`/v1/conversions/${conversionId}`, { token });
            assert.strictEqual(res.status, 200, res.text);
            if (res.json.status === "completed" || res.json.status === "failed") return res.json;
            if (Date.now() > deadline) assert.fail(`conversion ${conversionId} still ${res.json.status} after ${timeoutMs}ms`);
            // Real polling of the HTTP API: the worker's progress is only observable through it.
            const tick = Promise.withResolvers<void>();
            setTimeout(tick.resolve, 250);
            await tick.promise;
        }
    }

    const count = async (table: "users" | "sessions" | "tasks" | "conversions"): Promise<number> => {
        const rows =
            table === "users"
                ? await h.sql`SELECT COUNT(*)::int AS n FROM users`
                : table === "sessions"
                  ? await h.sql`SELECT COUNT(*)::int AS n FROM sessions`
                  : table === "tasks"
                    ? await h.sql`SELECT COUNT(*)::int AS n FROM tasks`
                    : await h.sql`SELECT COUNT(*)::int AS n FROM conversions`;
        return rows[0]!.n as number;
    };

    try {
        // ════════════════════════════════════════════════════════════════
        // AUTH
        // ════════════════════════════════════════════════════════════════

        await step("register: missing email/password → 400 BAD_REQUEST and no user is created", async () => {
            const cases: unknown[] = [
                {},
                { email: "a@dolly.test" },
                { password: "password12345" },
                { email: "", password: "password12345" },
                { email: "a@dolly.test", password: "" },
            ];
            for (const body of cases) {
                const res = await h.request<ApiError>("/v1/auth/register", { method: "POST", json: body });
                assert.strictEqual(res.status, 400, `${JSON.stringify(body)} → ${res.text}`);
                assert.strictEqual(res.json.error.code, "BAD_REQUEST");
                assert.match(res.json.error.message, /email and password are required/);
            }
            assert.strictEqual(await count("users"), 0);
        });

        await step("register: weak password (< 8 chars) → 400, boundary of exactly 8 chars is accepted", async () => {
            const weak = await h.request<ApiError>("/v1/auth/register", {
                method: "POST",
                json: { email: "weak@dolly.test", password: "1234567" },
            });
            assert.strictEqual(weak.status, 400);
            assert.strictEqual(weak.json.error.code, "BAD_REQUEST");
            assert.match(weak.json.error.message, /at least 8 characters/);
            assert.strictEqual((await h.sql`SELECT 1 FROM users WHERE email = ${"weak@dolly.test"}`).length, 0);

            const ok = await h.request<RegisterBody>("/v1/auth/register", {
                method: "POST",
                json: { email: "edge@dolly.test", password: "12345678" },
            });
            assert.strictEqual(ok.status, 201);
            assert.strictEqual((await h.sql`SELECT 1 FROM users WHERE email = ${"edge@dolly.test"}`).length, 1);
        });

        await step("register: a non-string password is rejected without creating an account", async () => {
            const res = await h.request<ApiError>("/v1/auth/register", {
                method: "POST",
                json: { email: "numpw@dolly.test", password: 12345678 },
            });
            assert.ok(res.status >= 400 && res.status < 600, `expected an error status, got ${res.status}`);
            assert.strictEqual(typeof res.json.error.code, "string");
            assert.strictEqual((await h.sql`SELECT 1 FROM users WHERE email = ${"numpw@dolly.test"}`).length, 0);
        });

        await step("register: stores a salted scrypt hash (never the password) plus profile fields", async () => {
            const password = "correct horse battery";
            const res = await h.request<RegisterBody>("/v1/auth/register", {
                method: "POST",
                json: { email: "alice@dolly.test", password, display_name: "Alice" },
            });
            assert.strictEqual(res.status, 201);
            assert.strictEqual(res.json.status, "ok");
            assert.deepStrictEqual(Object.keys(res.json).sort(), ["message", "status"], "no user data leaks in the response");

            await h.request("/v1/auth/register", {
                method: "POST",
                json: { email: "alice2@dolly.test", password },
            });

            const rows = await h.sql`SELECT user_id, email, password_hash, display_name FROM users WHERE email IN (${"alice@dolly.test"}, ${"alice2@dolly.test"})`;
            assert.strictEqual(rows.length, 2);
            const a = rows.find((r) => r.email === "alice@dolly.test");
            const b = rows.find((r) => r.email === "alice2@dolly.test");
            assert.ok(a && b);
            assert.match(a.user_id as string, /^usr_[0-9a-f]{8}$/);
            assert.strictEqual(a.display_name, "Alice");
            assert.strictEqual(b.display_name, null);
            for (const r of rows) {
                const hash = r.password_hash as string;
                assert.match(hash, /^[0-9a-f]{32}:[0-9a-f]{128}$/, "salt:hash hex format");
                assert.ok(!hash.includes(password));
            }
            assert.notStrictEqual(a.password_hash, b.password_hash, "same password must hash differently per user (random salt)");
        });

        await step("register: duplicate email returns a response identical to a fresh signup and never overwrites the account", async () => {
            const first = await h.request<RegisterBody>("/v1/auth/register", {
                method: "POST",
                json: { email: "dup@dolly.test", password: "originalPassword1" },
            });
            const dup = await h.request<RegisterBody>("/v1/auth/register", {
                method: "POST",
                json: { email: "dup@dolly.test", password: "attackerPassword1", display_name: "Mallory" },
            });
            assert.strictEqual(dup.status, first.status);
            assert.deepStrictEqual(dup.json, first.json, "no account-enumeration signal");

            const rows = await h.sql`SELECT display_name FROM users WHERE email = ${"dup@dolly.test"}`;
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0]!.display_name, null, "second signup must not modify the existing row");

            const orig = await h.request<LoginBody>("/v1/auth/login", {
                method: "POST",
                json: { email: "dup@dolly.test", password: "originalPassword1" },
            });
            assert.strictEqual(orig.status, 200);
            const attacker = await h.request<ApiError>("/v1/auth/login", {
                method: "POST",
                json: { email: "dup@dolly.test", password: "attackerPassword1" },
            });
            assert.strictEqual(attacker.status, 401);
        });

        await step("login: missing fields → 400 BAD_REQUEST", async () => {
            const cases: unknown[] = [{}, { email: "dup@dolly.test" }, { password: "originalPassword1" }, { email: "", password: "" }];
            for (const body of cases) {
                const res = await h.request<ApiError>("/v1/auth/login", { method: "POST", json: body });
                assert.strictEqual(res.status, 400, JSON.stringify(body));
                assert.strictEqual(res.json.error.code, "BAD_REQUEST");
            }
        });

        await step("login: wrong password and unknown email give the same uniform 401 and create no session", async () => {
            const before = await count("sessions");
            const wrongPw = await h.request<ApiError>("/v1/auth/login", {
                method: "POST",
                json: { email: "dup@dolly.test", password: "originalPassword2" }, // right user, near-miss password
            });
            const unknown = await h.request<ApiError>("/v1/auth/login", {
                method: "POST",
                json: { email: "nobody@dolly.test", password: "whatever12345" },
            });
            const wrongCase = await h.request<ApiError>("/v1/auth/login", {
                method: "POST",
                json: { email: "dup@dolly.test", password: "ORIGINALPASSWORD1" },
            });
            for (const res of [wrongPw, unknown, wrongCase]) {
                assert.strictEqual(res.status, 401);
                assert.strictEqual(res.json.error.code, "UNAUTHORIZED");
                assert.strictEqual(res.json.error.message, "Invalid email or password");
            }
            assert.deepStrictEqual(wrongPw.json, unknown.json);
            assert.strictEqual(await count("sessions"), before);
        });

        await step("login: success returns a token whose sha256 (not the token) is stored with a ~24h expiry", async () => {
            const res = await h.request<LoginBody>("/v1/auth/login", {
                method: "POST",
                json: { email: "alice@dolly.test", password: "correct horse battery" },
            });
            assert.strictEqual(res.status, 200, res.text);
            const { token, expires_at, user_id } = res.json;
            assert.match(token, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
            const userRows = await h.sql`SELECT user_id FROM users WHERE email = ${"alice@dolly.test"}`;
            assert.strictEqual(user_id, userRows[0]!.user_id);

            const plain = await h.sql`SELECT 1 FROM sessions WHERE token = ${token}`;
            assert.strictEqual(plain.length, 0, "plaintext token must not be stored");
            const stored = await h.sql`SELECT user_id, expires_at FROM sessions WHERE token = ${sha256(token)}`;
            assert.strictEqual(stored.length, 1);
            assert.strictEqual(stored[0]!.user_id, user_id);
            assert.strictEqual(new Date(stored[0]!.expires_at as string | Date).toISOString(), expires_at);
            const ttlMs = new Date(expires_at).getTime() - Date.now();
            assert.ok(Math.abs(ttlMs - 24 * 3600 * 1000) < 2 * 60 * 1000, `expiry ~24h away, got ${ttlMs}ms`);

            const me = await h.request("/v1/files", { token });
            assert.strictEqual(me.status, 200);
        });

        await step("login: every login mints an independent token", async () => {
            const login = () =>
                h.request<LoginBody>("/v1/auth/login", {
                    method: "POST",
                    json: { email: "alice@dolly.test", password: "correct horse battery" },
                });
            const [a, b] = [await login(), await login()];
            assert.notStrictEqual(a.json.token, b.json.token);
            assert.strictEqual((await h.request("/v1/files", { token: a.json.token })).status, 200);
            assert.strictEqual((await h.request("/v1/files", { token: b.json.token })).status, 200);
        });

        await step("auth middleware: missing, malformed and unknown credentials → 401 UNAUTHORIZED", async () => {
            const noHeader = await h.request<ApiError>("/v1/files");
            assert.strictEqual(noHeader.status, 401);
            assert.strictEqual(noHeader.json.error.code, "UNAUTHORIZED");
            for (const authorization of ["Basic YWxpY2U6cHc=", "Bearer", "Bearer ", "Bearer not-a-real-token", "token abc"]) {
                const res = await h.request<ApiError>("/v1/files", { headers: { authorization } });
                assert.strictEqual(res.status, 401, authorization);
                assert.strictEqual(res.json.error.code, "UNAUTHORIZED");
            }
        });

        await step("sessions: an expired session is rejected and purged; a seeded valid one is accepted", async () => {
            const user = await h.registerAndLogin();
            const expiredToken = "seeded-expired-token";
            const validToken = "seeded-valid-token";
            await h.sql`INSERT INTO sessions (token, user_id, expires_at) VALUES (${sha256(expiredToken)}, ${user.userId}, ${new Date(Date.now() - 60_000).toISOString()})`;
            await h.sql`INSERT INTO sessions (token, user_id, expires_at) VALUES (${sha256(validToken)}, ${user.userId}, ${new Date(Date.now() + 3_600_000).toISOString()})`;

            const expired = await h.request<ApiError>("/v1/files", { token: expiredToken });
            assert.strictEqual(expired.status, 401);
            assert.strictEqual(expired.json.error.code, "UNAUTHORIZED");
            assert.strictEqual(expired.json.error.message, "Token has expired");
            assert.strictEqual((await h.sql`SELECT 1 FROM sessions WHERE token = ${sha256(expiredToken)}`).length, 0, "expired row is deleted");

            const again = await h.request<ApiError>("/v1/files", { token: expiredToken });
            assert.strictEqual(again.status, 401);
            assert.strictEqual(again.json.error.message, "Missing or invalid auth token");

            const valid = await h.request("/v1/files", { token: validToken });
            assert.strictEqual(valid.status, 200);
            assert.strictEqual((await h.request("/v1/files", { token: user.token })).status, 200, "other sessions unaffected");
        });

        await step("logout: invalidates only the presented session (204), idempotent, tolerant of junk", async () => {
            const bob = await h.registerAndLogin("bob@dolly.test", "bobPassword123");
            const second = await h.request<LoginBody>("/v1/auth/login", {
                method: "POST",
                json: { email: bob.email, password: "bobPassword123" },
            });
            const carol = await h.registerAndLogin();

            const out = await h.request("/v1/auth/logout", { method: "POST", token: bob.token });
            assert.strictEqual(out.status, 204);
            assert.strictEqual(out.text, "");
            assert.strictEqual((await h.sql`SELECT 1 FROM sessions WHERE token = ${sha256(bob.token)}`).length, 0);

            const after = await h.request<ApiError>("/v1/files", { token: bob.token });
            assert.strictEqual(after.status, 401);
            assert.strictEqual((await h.request("/v1/files", { token: second.json.token })).status, 200, "bob's other session survives");
            assert.strictEqual((await h.request("/v1/files", { token: carol.token })).status, 200, "other users unaffected");

            assert.strictEqual((await h.request("/v1/auth/logout", { method: "POST", token: bob.token })).status, 204, "second logout still 204");
            assert.strictEqual((await h.request("/v1/auth/logout", { method: "POST" })).status, 204, "no header → 204");
            assert.strictEqual((await h.request("/v1/auth/logout", { method: "POST", token: "garbage" })).status, 204, "unknown token → 204");
            assert.strictEqual((await h.request("/v1/auth/logout", { method: "POST", headers: { authorization: "Basic abc" } })).status, 204);
            assert.strictEqual((await h.request("/v1/files", { token: second.json.token })).status, 200, "junk logouts removed nothing");
        });

        await step("register: a genuine database failure is a 500, never reported as a successful signup", async () => {
            const { setSqlExecutor } = await import("../src/server/db.js");
            for (const failure of [new Error("connection reset by peer"), "boom (non-Error rejection)"]) {
                setSqlExecutor((strings, ...values) =>
                    strings.join("?").includes("INSERT INTO users") ? Promise.reject(failure) : h.sql(strings, ...values),
                );
                try {
                    const res = await h.request<ApiError>("/v1/auth/register", {
                        method: "POST",
                        json: { email: "dbfail@dolly.test", password: "password12345" },
                    });
                    assert.strictEqual(res.status, 500);
                    assert.strictEqual(res.json.error.code, "INTERNAL_ERROR");
                    assert.ok(!res.text.includes("connection reset"), "internal error detail must not leak");
                } finally {
                    setSqlExecutor(h.sql);
                }
            }
            assert.strictEqual((await h.sql`SELECT 1 FROM users WHERE email = ${"dbfail@dolly.test"}`).length, 0);
        });

        // ════════════════════════════════════════════════════════════════
        // CONVERSIONS
        // ════════════════════════════════════════════════════════════════

        const alice = await h.registerAndLogin();
        const mallory = await h.registerAndLogin();
        const aliceFile = await seedFile(alice.userId, { name: "Alice Song.wav" });
        const aliceFileBpm = await seedFile(alice.userId, { name: "Tempo Song.wav", bpm: 140 });

        await step("conversions: every endpoint requires authentication", async () => {
            const calls: [string, string][] = [
                ["POST", "/v1/conversions"],
                ["GET", "/v1/conversions"],
                ["GET", "/v1/conversions/conv_x"],
                ["GET", "/v1/conversions/conv_x/download"],
                ["POST", "/v1/conversions/conv_x/retry"],
            ];
            for (const [method, url] of calls) {
                const res = await h.request<ApiError>(url, { method, ...(method === "POST" ? { json: {} } : {}) });
                assert.strictEqual(res.status, 401, `${method} ${url}`);
                assert.strictEqual(res.json.error.code, "UNAUTHORIZED");
            }
        });

        await step("create: missing input_file_id → 400; invalid instruments/difficulty → 422 INVALID_INPUT; nothing persisted", async () => {
            const tasksBefore = await count("tasks");
            const convsBefore = await count("conversions");

            const missing = await h.request<ApiError>("/v1/conversions", {
                method: "POST",
                token: alice.token,
                json: { instruments: ["guitar"] },
            });
            assert.strictEqual(missing.status, 400);
            assert.strictEqual(missing.json.error.code, "BAD_REQUEST");
            assert.match(missing.json.error.message, /input_file_id is required/);

            const cases: { body: Record<string, unknown>; message: RegExp }[] = [
                { body: {}, message: /instruments must be a non-empty array/ },
                { body: { instruments: [] }, message: /non-empty array/ },
                { body: { instruments: "guitar" }, message: /non-empty array/ },
                { body: { instruments: { 0: "guitar" } }, message: /non-empty array/ },
                { body: { instruments: ["guitar", "vocals"] }, message: /Unsupported instrument\(s\): "vocals"/ },
                { body: { instruments: ["kazoo", 7, null] }, message: /Unsupported instrument\(s\): "kazoo", 7, null/ },
                { body: { instruments: [""] }, message: /Unsupported instrument\(s\): ""/ },
                { body: { instruments: ["guitar"], difficulty: "nightmare" }, message: /difficulty must be one of: expert, hard, medium, easy/ },
                { body: { instruments: ["guitar"], difficulty: 3 }, message: /difficulty must be one of/ },
                { body: { instruments: ["guitar"], difficulty: "" }, message: /difficulty must be one of/ },
            ];
            for (const { body, message } of cases) {
                const res = await h.request<ApiError>("/v1/conversions", {
                    method: "POST",
                    token: alice.token,
                    json: { input_file_id: aliceFile, ...body },
                });
                assert.strictEqual(res.status, 422, `${JSON.stringify(body)} → ${res.text}`);
                assert.strictEqual(res.json.error.code, "INVALID_INPUT");
                assert.match(res.json.error.message, message);
            }
            assert.strictEqual(await count("tasks"), tasksBefore);
            assert.strictEqual(await count("conversions"), convsBefore);
        });

        await step("create: unknown file and another user's file both → identical 404; generated outputs → 422", async () => {
            const unknown = await h.request<ApiError>("/v1/conversions", {
                method: "POST",
                token: alice.token,
                json: { input_file_id: "file_does_not_exist", instruments: ["guitar"] },
            });
            const foreign = await h.request<ApiError>("/v1/conversions", {
                method: "POST",
                token: mallory.token,
                json: { input_file_id: aliceFile, instruments: ["guitar"] },
            });
            assert.strictEqual(unknown.status, 404);
            assert.strictEqual(unknown.json.error.code, "NOT_FOUND");
            assert.deepStrictEqual(foreign.json, unknown.json, "must not reveal that the file exists");
            assert.strictEqual(foreign.status, 404);

            const outputFile = await seedFile(alice.userId, { name: "Generated.sng", kind: "output" });
            const output = await h.request<ApiError>("/v1/conversions", {
                method: "POST",
                token: alice.token,
                json: { input_file_id: outputFile, instruments: ["guitar"] },
            });
            assert.strictEqual(output.status, 422);
            assert.strictEqual(output.json.error.code, "INVALID_INPUT");
            assert.match(output.json.error.message, /generated output/);
            assert.strictEqual(await count("conversions"), 0);
        });

        await step("create: audio shorter than 30s → 422 AUDIO_TOO_SHORT before any task or split happens", async () => {
            const shortFile = await seedFile(alice.userId, { localPath: shortWav, name: "Short.wav" });
            const splitsBefore = fake.splitCalls.length;
            const res = await h.request<ApiError>("/v1/conversions", {
                method: "POST",
                token: alice.token,
                json: { input_file_id: shortFile, instruments: ["guitar"] },
            });
            assert.strictEqual(res.status, 422);
            assert.strictEqual(res.json.error.code, "AUDIO_TOO_SHORT");
            assert.match(res.json.error.message, /5\.00s \(minimum 30s\)/);
            assert.strictEqual(await count("tasks"), 0);
            assert.strictEqual(await count("conversions"), 0);
            assert.strictEqual(fake.splitCalls.length, splitsBefore);
        });

        let multiConversionId = "";
        let multiOutputName = "";

        await step("create: normalises aliases, dedupes, defaults difficulty to expert and persists pipeline tasks", async () => {
            const res = await h.request<ConversionBody>("/v1/conversions", {
                method: "POST",
                token: alice.token,
                json: {
                    input_file_id: aliceFile,
                    instruments: [" Guitar ", "drum", "drums", "keyboard", "piano"],
                },
            });
            assert.strictEqual(res.status, 201, res.text);
            multiConversionId = res.json.conversion_id;
            assert.match(multiConversionId, /^conv_[0-9a-f]{8}$/);
            assert.strictEqual(res.json.status, "in_progress");
            assert.strictEqual(res.json.input_file_id, aliceFile);
            assert.strictEqual(res.json.download_url, null);
            assert.deepStrictEqual(
                res.json.tasks.map((t) => t.type),
                ["split_stems", "audio2chart", "audio2chart", "audio2chart", "upload_s3"],
            );
            assert.ok(res.json.tasks.every((t) => t.status === "pending"));

            const taskRows = await h.sql`
                SELECT t.type, t.settings, t.user_id, t.input_file_id FROM tasks t
                JOIN conversion_tasks ct ON ct.task_id = t.task_id
                WHERE ct.conversion_id = ${multiConversionId} ORDER BY t.created_at`;
            assert.strictEqual(taskRows.length, 5);
            assert.ok(taskRows.every((r) => r.user_id === alice.userId && r.input_file_id === aliceFile));
            const a2c = taskRows.filter((r) => r.type === "audio2chart").map((r) => r.settings);
            assert.deepStrictEqual(a2c, [
                { difficulty: "expert", instrument: "guitar" },
                { difficulty: "expert", instrument: "drums" },
                { difficulty: "expert", instrument: "keys" },
            ]);
            const split = taskRows.find((r) => r.type === "split_stems")!;
            assert.deepStrictEqual(split.settings, { stems: 4, model: "orion" });
        });

        await step("status: polling reaches completed; tasks all completed and download_url is advertised", async () => {
            const done = await waitForTerminal(alice.token, multiConversionId);
            assert.strictEqual(done.status, "completed");
            assert.deepStrictEqual(done.tasks.map((t) => t.status), ["completed", "completed", "completed", "completed", "completed"]);
            assert.strictEqual(done.download_url, `/v1/conversions/${multiConversionId}/download`);

            // Real worker side effects: one split with the de-duplicated mapped stems, one chart per instrument.
            const split = fake.splitCalls.at(-1)!;
            assert.strictEqual(split.input, longWav);
            assert.deepStrictEqual(split.stems, ["electric_guitar", "drum", "piano"]);
            const calls = fake.chartCalls.slice(-3);
            assert.deepStrictEqual(calls.map((c) => c.name), ["Alice Song (guitar)", "Alice Song (drums)", "Alice Song (keys)"]);
            assert.deepStrictEqual(calls.map((c) => c.sustains), [true, false, true], "drums have no sustains");
            assert.ok(calls.every((c) => c.beatAudioPath === longWav));
            assert.deepStrictEqual(calls.map((c) => path.basename(c.audioPath)), ["long_electric_guitar.wav", "long_drum.wav", "long_piano.wav"]);
            assert.strictEqual(fake.chartClientBpms.at(-1), undefined, "no confirmed BPM was forwarded");
        });

        await step("download: completed conversion streams a real .sng with the requested instruments", async () => {
            const res = await fetch(`${h.base}/v1/conversions/${multiConversionId}/download`, {
                headers: { authorization: `Bearer ${alice.token}` },
            });
            assert.strictEqual(res.status, 200);
            const disposition = res.headers.get("content-disposition") ?? "";
            assert.match(disposition, /attachment/);
            assert.match(disposition, /Alice Song\.sng/);
            multiOutputName = "Alice Song.sng";
            const buf = Buffer.from(await res.arrayBuffer());
            const { magic, files } = unpackSng(buf);
            assert.strictEqual(magic, "SNGPKG");
            assert.ok(files.has("song.opus"));
            const chart = files.get("notes.chart")!.toString("utf8");
            assert.ok(chart.includes("[ExpertSingle]") && chart.includes("[ExpertDrums]") && chart.includes("[ExpertKeyboard]"), "expert tracks for guitar/drums/keys");
            assert.ok(!chart.includes("[HardSingle]"));

            const outputRows = await h.sql`
                SELECT f.file_id, f.name, f.kind, f.user_id, f.size_bytes, f.local_path
                FROM files f JOIN tasks t ON t.output_file_id = f.file_id
                JOIN conversion_tasks ct ON ct.task_id = t.task_id
                WHERE ct.conversion_id = ${multiConversionId}`;
            assert.strictEqual(outputRows.length, 1);
            const out = outputRows[0]!;
            assert.strictEqual(out.name, multiOutputName);
            assert.strictEqual(out.kind, "output");
            assert.strictEqual(out.user_id, alice.userId);
            assert.strictEqual(Number(out.size_bytes), buf.length);
        });

        await step("create: a generated output of a finished conversion cannot be used as a conversion input", async () => {
            const rows = await h.sql`
                SELECT t.output_file_id FROM tasks t JOIN conversion_tasks ct ON ct.task_id = t.task_id
                WHERE ct.conversion_id = ${multiConversionId} AND t.type = 'upload_s3'`;
            const res = await h.request<ApiError>("/v1/conversions", {
                method: "POST",
                token: alice.token,
                json: { input_file_id: rows[0]!.output_file_id, instruments: ["guitar"] },
            });
            assert.strictEqual(res.status, 422);
            assert.strictEqual(res.json.error.code, "INVALID_INPUT");
        });

        await step("create: difficulty is normalised and honoured, confirmed BPM is forwarded and enforced", async () => {
            const res = await h.request<ConversionBody>("/v1/conversions", {
                method: "POST",
                token: alice.token,
                json: { input_file_id: aliceFileBpm, instruments: ["GUITAR"], difficulty: " Hard " },
            });
            assert.strictEqual(res.status, 201, res.text);
            const id = res.json.conversion_id;
            const settings = await h.sql`
                SELECT t.settings FROM tasks t JOIN conversion_tasks ct ON ct.task_id = t.task_id
                WHERE ct.conversion_id = ${id} AND t.type = 'audio2chart'`;
            assert.deepStrictEqual(settings[0]!.settings, { difficulty: "hard", instrument: "guitar" });

            const done = await waitForTerminal(alice.token, id);
            assert.strictEqual(done.status, "completed");
            assert.strictEqual(fake.chartClientBpms.at(-1), 140);

            const dl = await fetch(`${h.base}/v1/conversions/${id}/download`, { headers: { authorization: `Bearer ${alice.token}` } });
            assert.strictEqual(dl.status, 200);
            const chart = unpackSng(Buffer.from(await dl.arrayBuffer())).files.get("notes.chart")!.toString("utf8");
            assert.ok(chart.includes("[HardSingle]"), "requested difficulty lands in the chart");
            assert.ok(!chart.includes("[ExpertSingle]"));
            assert.ok(chart.includes("B 140000"), "tempo forced to the confirmed 140 BPM");
        });

        await step("get/list/download/retry: another user's conversion is indistinguishable from a missing one (404)", async () => {
            const missing = await h.request<ApiError>("/v1/conversions/conv_nope", { token: alice.token });
            assert.strictEqual(missing.status, 404);
            assert.strictEqual(missing.json.error.code, "NOT_FOUND");
            for (const [method, suffix] of [["GET", ""], ["GET", "/download"], ["POST", "/retry"]] as const) {
                const res = await h.request<ApiError>(`/v1/conversions/${multiConversionId}${suffix}`, {
                    method,
                    token: mallory.token,
                    ...(method === "POST" ? { json: {} } : {}),
                });
                assert.strictEqual(res.status, 404, `${method} ${suffix}`);
                assert.strictEqual(res.json.error.code, "NOT_FOUND");
            }
            const list = await h.request<ConversionList>("/v1/conversions", { token: mallory.token });
            assert.strictEqual(list.status, 200);
            assert.strictEqual(list.json.total, 0);
            assert.deepStrictEqual(list.json.conversions, []);
            // The owner's conversion is untouched by the probing.
            assert.strictEqual((await h.request<ConversionBody>(`/v1/conversions/${multiConversionId}`, { token: alice.token })).json.status, "completed");
        });

        await step("retry: completed conversions → 409; download/retry on a running conversion → 409 until it finishes", async () => {
            const completedRetry = await h.request<ApiError>(`/v1/conversions/${multiConversionId}/retry`, {
                method: "POST",
                token: alice.token,
                json: {},
            });
            assert.strictEqual(completedRetry.status, 409);
            assert.strictEqual(completedRetry.json.error.code, "CONFLICT");
            assert.match(completedRetry.json.error.message, /already completed/);

            const gate = Promise.withResolvers<void>();
            const release = gate.resolve;
            fake.gate = gate.promise;
            try {
                const created = await h.request<ConversionBody>("/v1/conversions", {
                    method: "POST",
                    token: alice.token,
                    json: { input_file_id: aliceFile, instruments: ["bass"] },
                });
                assert.strictEqual(created.status, 201);
                const id = created.json.conversion_id;

                const status = await h.request<ConversionBody>(`/v1/conversions/${id}`, { token: alice.token });
                assert.strictEqual(status.json.status, "in_progress");
                assert.strictEqual(status.json.download_url, null);

                const dl = await h.request<ApiError>(`/v1/conversions/${id}/download`, { token: alice.token });
                assert.strictEqual(dl.status, 409);
                assert.strictEqual(dl.json.error.code, "CONFLICT");
                assert.match(dl.json.error.message, /Conversion is in_progress, not completed/);

                const retry = await h.request<ApiError>(`/v1/conversions/${id}/retry`, { method: "POST", token: alice.token, json: {} });
                assert.strictEqual(retry.status, 409);
                assert.match(retry.json.error.message, /already running/);

                release();
                const done = await waitForTerminal(alice.token, id);
                assert.strictEqual(done.status, "completed");
                const dlAfter = await h.request("/v1/conversions/" + id + "/download", { token: alice.token });
                assert.strictEqual(dlAfter.status, 200);
            } finally {
                release();
                fake.gate = null;
            }
        });

        await step("failure + retry: a failed split records WORKER_ERROR, blocks download, and retry completes the same conversion", async () => {
            fake.failSplit = true;
            let id = "";
            try {
                const created = await h.request<ConversionBody>("/v1/conversions", {
                    method: "POST",
                    token: alice.token,
                    json: { input_file_id: aliceFile, instruments: ["guitar"] },
                });
                assert.strictEqual(created.status, 201);
                id = created.json.conversion_id;
                const failedConv = await waitForTerminal(alice.token, id);
                assert.strictEqual(failedConv.status, "failed");
                assert.deepStrictEqual(failedConv.tasks.map((t) => `${t.type}:${t.status}`), [
                    "split_stems:failed",
                    "audio2chart:pending",
                    "upload_s3:pending",
                ]);
                assert.strictEqual(failedConv.download_url, null);
            } finally {
                fake.failSplit = false;
            }

            const [errRow] = await h.sql`
                SELECT t.error, t.completed_at FROM tasks t JOIN conversion_tasks ct ON ct.task_id = t.task_id
                WHERE ct.conversion_id = ${id} AND t.type = 'split_stems'`;
            const err = errRow!.error as { code: string; message: string };
            assert.strictEqual(err.code, "WORKER_ERROR");
            assert.match(err.message, /fake split boom/);
            assert.ok(errRow!.completed_at, "completed_at stamped on failure");

            const dl = await h.request<ApiError>(`/v1/conversions/${id}/download`, { token: alice.token });
            assert.strictEqual(dl.status, 409);
            assert.match(dl.json.error.message, /Conversion is failed, not completed/);

            const splitsBefore = fake.splitCalls.length;
            const retry = await h.request<ConversionBody>(`/v1/conversions/${id}/retry`, { method: "POST", token: alice.token, json: {} });
            assert.strictEqual(retry.status, 202, retry.text);
            assert.strictEqual(retry.json.conversion_id, id);
            assert.strictEqual(retry.json.status, "in_progress");
            assert.strictEqual(retry.json.download_url, null);

            const done = await waitForTerminal(alice.token, id);
            assert.strictEqual(done.status, "completed");
            assert.ok(done.tasks.every((t) => t.status === "completed"));
            assert.strictEqual(fake.splitCalls.length, splitsBefore + 1, "split re-ran exactly once");
            const [after] = await h.sql`
                SELECT t.error FROM tasks t JOIN conversion_tasks ct ON ct.task_id = t.task_id
                WHERE ct.conversion_id = ${id} AND t.type = 'split_stems'`;
            assert.strictEqual(after!.error, null, "stale error cleared");
            assert.strictEqual((await h.request(`/v1/conversions/${id}/download`, { token: alice.token })).status, 200);
        });

        await step("retry: a failed conversion whose input file is gone → 422 CANNOT_RESUME and state is untouched", async () => {
            const ghostFile = await seedFile(alice.userId, { name: "Ghost.wav" });
            await seedConversion({
                conversionId: "conv_ghost",
                userId: alice.userId,
                status: "failed",
                inputFileId: ghostFile,
                createdAt: "2026-01-01T00:00:00Z",
                tasks: [
                    { id: "task_ghost_split", type: "split_stems", status: "failed" },
                    { id: "task_ghost_up", type: "upload_s3", status: "pending" },
                ],
            });
            await h.sql`DELETE FROM files WHERE file_id = ${ghostFile}`;
            const res = await h.request<ApiError>("/v1/conversions/conv_ghost/retry", { method: "POST", token: alice.token, json: {} });
            assert.strictEqual(res.status, 422);
            assert.strictEqual(res.json.error.code, "CANNOT_RESUME");
            const rows = await h.sql`SELECT status FROM conversions WHERE conversion_id = ${"conv_ghost"}`;
            assert.strictEqual(rows[0]!.status, "failed");
            const t = await h.sql`SELECT status FROM tasks WHERE task_id = ${"task_ghost_split"}`;
            assert.strictEqual(t[0]!.status, "failed");
        });

        await step("download: completed conversion with no registered output, or whose file vanished from disk → 404", async () => {
            // Completed, but the upload task never recorded an output file.
            const f = await seedFile(alice.userId, { name: "NoOutput.wav" });
            await seedConversion({
                conversionId: "conv_nooutput",
                userId: alice.userId,
                status: "completed",
                inputFileId: f,
                createdAt: "2026-01-02T00:00:00Z",
                tasks: [{ id: "task_noout_up", type: "upload_s3", status: "completed" }],
            });
            const noOut = await h.request<ApiError>("/v1/conversions/conv_nooutput/download", { token: alice.token });
            assert.strictEqual(noOut.status, 404);
            assert.strictEqual(noOut.json.error.code, "NOT_FOUND");
            assert.match(noOut.json.error.message, /output not available/);

            // Completed with an output row, but the artifact was purged from disk.
            const [row] = await h.sql`
                SELECT f.local_path FROM files f JOIN tasks t ON t.output_file_id = f.file_id
                JOIN conversion_tasks ct ON ct.task_id = t.task_id WHERE ct.conversion_id = ${multiConversionId}`;
            const outPath = row!.local_path as string;
            assert.ok(fs.existsSync(outPath));
            fs.rmSync(outPath);
            const purged = await h.request<ApiError>(`/v1/conversions/${multiConversionId}/download`, { token: alice.token });
            assert.strictEqual(purged.status, 404);
            assert.match(purged.json.error.message, /output not available/);
            // The status endpoint still reports the stored state.
            assert.strictEqual((await h.request<ConversionBody>(`/v1/conversions/${multiConversionId}`, { token: alice.token })).json.status, "completed");
        });

        await step("create: a missing source file or an unprobeable one is not blocked up front — the pipeline fails it visibly", async () => {
            // File row points at a path that does not exist → duration probe skipped, split fails (ENOENT).
            const missingDisk = await seedFile(alice.userId, { localPath: path.join(uploadsDir, "gone.wav"), name: "Gone.wav" });
            const a = await h.request<ConversionBody>("/v1/conversions", {
                method: "POST",
                token: alice.token,
                json: { input_file_id: missingDisk, instruments: ["guitar"] },
            });
            assert.strictEqual(a.status, 201, a.text);
            const aDone = await waitForTerminal(alice.token, a.json.conversion_id);
            assert.strictEqual(aDone.status, "failed");
            assert.strictEqual(aDone.tasks[0]!.status, "failed");

            // Garbage bytes → ffprobe-style duration probe throws → creation proceeds; transcode later fails.
            const garbage = await seedFile(alice.userId, { localPath: garbageWav, name: "Garbage.wav" });
            const b = await h.request<ConversionBody>("/v1/conversions", {
                method: "POST",
                token: alice.token,
                json: { input_file_id: garbage, instruments: ["guitar"] },
            });
            assert.strictEqual(b.status, 201, b.text);
            const bDone = await waitForTerminal(alice.token, b.json.conversion_id);
            assert.strictEqual(bDone.status, "failed");
            assert.deepStrictEqual(bDone.tasks.map((t) => `${t.type}:${t.status}`), [
                "split_stems:completed",
                "audio2chart:completed",
                "upload_s3:failed",
            ]);
        });

        await step("list: newest first, paginated, per_page clamped and bad params fall back to defaults", async () => {
            const lister = await h.registerAndLogin();
            const f = await seedFile(lister.userId);
            for (const [i, day] of ["01", "02", "03"].entries()) {
                await seedConversion({
                    conversionId: `conv_list${i}`,
                    userId: lister.userId,
                    status: "failed",
                    inputFileId: f,
                    createdAt: `2026-02-${day}T00:00:00Z`,
                    tasks: [{ id: `task_list${i}`, type: "split_stems", status: "failed" }],
                });
            }
            const ids = (l: ConversionList) => l.conversions.map((c) => c.conversion_id);

            const p1 = await h.request<ConversionList>("/v1/conversions?per_page=2&page=1", { token: lister.token });
            assert.strictEqual(p1.status, 200);
            assert.deepStrictEqual(ids(p1.json), ["conv_list2", "conv_list1"]);
            assert.strictEqual(p1.json.total, 3);
            assert.strictEqual(p1.json.page, 1);
            assert.strictEqual(p1.json.per_page, 2);
            assert.deepStrictEqual(p1.json.conversions[0]!.tasks, [{ task_id: "task_list2", type: "split_stems", status: "failed" }]);
            assert.strictEqual(p1.json.conversions[0]!.download_url, null);

            const p2 = await h.request<ConversionList>("/v1/conversions?per_page=2&page=2", { token: lister.token });
            assert.deepStrictEqual(ids(p2.json), ["conv_list0"]);
            const p3 = await h.request<ConversionList>("/v1/conversions?per_page=2&page=3", { token: lister.token });
            assert.deepStrictEqual(p3.json.conversions, []);
            assert.strictEqual(p3.json.total, 3);

            const defaults = await h.request<ConversionList>("/v1/conversions?page=abc&per_page=zzz", { token: lister.token });
            assert.strictEqual(defaults.json.page, 1);
            assert.strictEqual(defaults.json.per_page, 20);
            const zero = await h.request<ConversionList>("/v1/conversions?page=0&per_page=0", { token: lister.token });
            assert.strictEqual(zero.json.page, 1);
            assert.strictEqual(zero.json.per_page, 20);
            const negative = await h.request<ConversionList>("/v1/conversions?page=-4&per_page=-5", { token: lister.token });
            assert.strictEqual(negative.json.page, 1);
            assert.strictEqual(negative.json.per_page, 1);
            const huge = await h.request<ConversionList>("/v1/conversions?per_page=5000", { token: lister.token });
            assert.strictEqual(huge.json.per_page, 100);
            assert.strictEqual(huge.json.conversions.length, 3);
        });

        await step("list: completed conversions expose a download_url for their owner only", async () => {
            const list = await h.request<ConversionList>("/v1/conversions?per_page=100", { token: alice.token });
            const found = list.json.conversions.find((c) => c.conversion_id === multiConversionId);
            assert.ok(found);
            assert.strictEqual(found!.status, "completed");
            assert.strictEqual(found!.download_url, `/v1/conversions/${multiConversionId}/download`);
            assert.ok(list.json.conversions.every((c) => ["conv_list0", "conv_list1", "conv_list2"].indexOf(c.conversion_id) === -1), "other users' conversions never listed");
            assert.ok(list.json.total >= 6);
        });
    } finally {
        setWorkerExternals(null);
        await h.close();
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error("Runner error:", error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
});
