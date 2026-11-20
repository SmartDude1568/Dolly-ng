/**
 * Shared hermetic harness for server tests.
 *
 * Starts the REAL Express app (createApp) on an ephemeral port, backed by an
 * in-memory pg-mem Postgres injected through setSqlExecutor(). No network
 * services, no secrets, nothing outside a temp directory is touched.
 *
 * IMPORTANT: import this module BEFORE any `src/server/*` module. It sets
 * OUTPUT_DIR (read by worker.ts at load time) and clears DATABASE_URL on import.
 * `src/server/*` modules must then be loaded with dynamic `await import(...)`
 * inside the test, after `createHarness()` has been awaited.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

export const WORK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dolly-test-"));
process.env.OUTPUT_DIR = path.join(WORK_ROOT, "output");
delete process.env.DATABASE_URL;

export const SCHEMA = `
CREATE TABLE users (
    user_id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE files (
    file_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    mime_type TEXT NOT NULL,
    local_path TEXT NOT NULL,
    bpm REAL,
    kind TEXT NOT NULL DEFAULT 'source',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    progress REAL NOT NULL DEFAULT 0,
    input_file_id TEXT,
    settings JSONB NOT NULL DEFAULT '{}',
    slot_id TEXT,
    output_file_id TEXT,
    error JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);
CREATE TABLE conversions (
    conversion_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress',
    input_file_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE conversion_tasks (
    conversion_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    PRIMARY KEY (conversion_id, task_id)
);
`;

/** Mono 16-bit PCM WAV of silence. */
export function writeSilentWav(filePath: string, durationSec: number, sampleRate = 8000): void {
    const numSamples = Math.floor(sampleRate * durationSec);
    const dataSize = numSamples * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(dataSize, 40);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buf);
}

export interface ApiResponse<T = Record<string, unknown>> {
    status: number;
    /** Parsed JSON body (caller names the shape via T), or null when the body is empty / not JSON. */
    json: T;
    text: string;
    headers: Headers;
}

export interface RequestOptions {
    method?: string;
    /** Bearer token. */
    token?: string;
    /** JSON body. */
    json?: unknown;
    /** Multipart body (mutually exclusive with `json`). */
    form?: FormData;
    headers?: Record<string, string>;
}

export interface Harness {
    /** e.g. http://127.0.0.1:54321 */
    base: string;
    workRoot: string;
    /** Raw SQL against the in-memory database, for seeding and assertions. */
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;
    /** Fetch `${base}${pathname}` and read the body exactly once. */
    request<T = Record<string, unknown>>(pathname: string, opts?: RequestOptions): Promise<ApiResponse<T>>;
    /** Register + log in a fresh user; returns its bearer token and email. */
    registerAndLogin(email?: string, password?: string): Promise<{ token: string; email: string; userId: string }>;
    close(): Promise<void>;
}

let userCounter = 0;

export async function createHarness(opts: { rateLimit?: boolean } = {}): Promise<Harness> {
    // Dynamic imports below are deliberate: worker.ts reads OUTPUT_DIR at load time, so the
    // server modules must load only after this file has set it.
    const { newDb } = await import("pg-mem");
    const mem = newDb();
    const { Client } = mem.adapters.createPg();
    const client = new Client();
    await client.connect();
    await client.query(SCHEMA);

    // Serialize queries through the single pg-mem client (it is not re-entrant).
    let chain: Promise<unknown> = Promise.resolve();
    const sql: Harness["sql"] = (strings, ...values) => {
        let text = strings[0]!;
        for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1];
        const run = chain.then(() =>
            client.query(text, values).then((r: { rows: Record<string, unknown>[] }) => r.rows),
        );
        chain = run.catch(() => {});
        return run as Promise<Record<string, unknown>[]>;
    };

    const { setSqlExecutor } = await import("../../src/server/db.js");
    setSqlExecutor(sql);

    const { createApp } = await import("../../src/server/app.js");
    const app = createApp({ rateLimit: opts.rateLimit ?? false });
    const server = app.listen(0);
    const listening = Promise.withResolvers<void>();
    server.once("listening", () => listening.resolve());
    await listening.promise;
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    async function request<T = Record<string, unknown>>(pathname: string, o: RequestOptions = {}): Promise<ApiResponse<T>> {
        const headers: Record<string, string> = { ...(o.headers ?? {}) };
        if (o.token) headers.authorization = `Bearer ${o.token}`;
        let body: BodyInit | undefined;
        if (o.json !== undefined) {
            headers["content-type"] = "application/json";
            body = JSON.stringify(o.json);
        } else if (o.form) {
            body = o.form;
        }
        const res = await fetch(`${base}${pathname}`, { method: o.method ?? "GET", headers, ...(body ? { body } : {}) });
        const text = await res.text();
        let json: unknown = null;
        try {
            json = JSON.parse(text);
        } catch {
            /* empty or non-JSON body */
        }
        return { status: res.status, json: json as T, text, headers: res.headers };
    }

    async function registerAndLogin(email?: string, password = "password12345") {
        const addr = email ?? `user${++userCounter}_${Date.now()}@dolly.test`;
        const reg = await request("/v1/auth/register", { method: "POST", json: { email: addr, password } });
        if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${reg.text}`);
        const login = await request("/v1/auth/login", { method: "POST", json: { email: addr, password } });
        if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.text}`);
        const rows = await sql`SELECT user_id FROM users WHERE email = ${addr}`;
        return { token: (login.json as { token: string }).token, email: addr, userId: rows[0]!.user_id as string };
    }

    return {
        base,
        workRoot: WORK_ROOT,
        sql,
        request,
        registerAndLogin,
        async close() {
            const closed = Promise.withResolvers<void>();
            server.close(() => closed.resolve());
            await closed.promise;
            setSqlExecutor(null);
            fs.rmSync(WORK_ROOT, { recursive: true, force: true });
        },
    };
}
