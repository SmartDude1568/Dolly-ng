/**
 * Unit tests for the bearer-token auth middleware (src/server/middleware.ts).
 *
 * The sessions table is replaced by a tiny in-process SQL executor, and the request/response
 * objects are minimal fakes, so the middleware's decisions can be asserted exactly.
 *
 * Usage:  npx tsx tests/middleware.test.ts
 */

import * as assert from "node:assert";
import * as crypto from "node:crypto";
import type { Request, Response } from "express";
import { setSqlExecutor, type SqlExecutor } from "../src/server/db.js";
import { requireAuth } from "../src/server/middleware.js";

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

interface Session {
    token: string; // stored as the SHA-256 of the bearer token
    user_id: string;
    expires_at: Date | string;
}

/** Fake sessions table understanding exactly the two statements the middleware issues. */
function fakeDb(rows: Session[]): { executor: SqlExecutor; deleted: string[]; queries: string[] } {
    const deleted: string[] = [];
    const queries: string[] = [];
    const executor: SqlExecutor = async (strings, ...values) => {
        const text = strings.join("?").replace(/\s+/g, " ").trim();
        queries.push(text);
        if (text.startsWith("SELECT token, user_id, expires_at FROM sessions")) {
            return rows.filter((r) => r.token === values[0]) as unknown as Record<string, unknown>[];
        }
        if (text.startsWith("DELETE FROM sessions")) {
            deleted.push(values[0] as string);
            return [];
        }
        throw new Error(`unexpected query: ${text}`);
    };
    return { executor, deleted, queries };
}

interface Outcome {
    status: number | null;
    body: unknown;
    nextCalled: boolean;
    req: Request;
}

async function run(authorization: string | undefined): Promise<Outcome> {
    const out: Outcome = { status: null, body: null, nextCalled: false, req: { headers: {} } as Request };
    if (authorization !== undefined) out.req.headers.authorization = authorization;
    const res = {
        status(code: number) {
            out.status = code;
            return this;
        },
        json(body: unknown) {
            out.body = body;
            return this;
        },
    } as unknown as Response;
    await requireAuth(out.req, res, () => {
        out.nextCalled = true;
    });
    return out;
}

const errorOf = (o: Outcome): { code: string; message: string } =>
    (o.body as { error: { code: string; message: string } }).error;

async function main(): Promise<void> {
    let passed = 0;
    let failed = 0;
    async function step(name: string, fn: () => Promise<void>): Promise<void> {
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

    const future = new Date(Date.now() + 3_600_000);
    const past = new Date(Date.now() - 3_600_000);

    try {
        await step("rejects a request with no Authorization header, without touching the database", async () => {
            const db = fakeDb([]);
            setSqlExecutor(db.executor);
            const o = await run(undefined);
            assert.strictEqual(o.status, 401);
            assert.strictEqual(errorOf(o).code, "UNAUTHORIZED");
            assert.strictEqual(o.nextCalled, false);
            assert.strictEqual(db.queries.length, 0);
        });

        await step("rejects a non-Bearer scheme", async () => {
            setSqlExecutor(fakeDb([]).executor);
            const o = await run("Basic dXNlcjpwYXNz");
            assert.strictEqual(o.status, 401);
            assert.strictEqual(o.nextCalled, false);
        });

        await step("rejects an unknown token", async () => {
            setSqlExecutor(fakeDb([{ token: sha256("other"), user_id: "u1", expires_at: future }]).executor);
            const o = await run("Bearer wrong");
            assert.strictEqual(o.status, 401);
            assert.strictEqual(errorOf(o).message, "Missing or invalid auth token");
            assert.strictEqual(o.nextCalled, false);
        });

        await step("accepts a valid token and exposes the user on req.auth", async () => {
            setSqlExecutor(fakeDb([{ token: sha256("good-token"), user_id: "usr_42", expires_at: future }]).executor);
            const o = await run("Bearer good-token");
            assert.strictEqual(o.status, null, "no error response expected");
            assert.strictEqual(o.nextCalled, true);
            assert.strictEqual(o.req.auth?.user_id, "usr_42");
            assert.strictEqual(o.req.auth?.token, "good-token");
            assert.strictEqual(o.req.auth?.expires_at, future.toISOString());
        });

        await step("looks sessions up by the token's hash, never the raw bearer value", async () => {
            const db = fakeDb([{ token: "good-token", user_id: "usr_42", expires_at: future }]); // raw token stored
            setSqlExecutor(db.executor);
            const o = await run("Bearer good-token");
            assert.strictEqual(o.status, 401, "a session row keyed by the raw token must not authenticate");
        });

        await step("accepts expires_at delivered as an ISO string (drivers differ)", async () => {
            setSqlExecutor(
                fakeDb([{ token: sha256("t"), user_id: "u", expires_at: future.toISOString() }]).executor,
            );
            const o = await run("Bearer t");
            assert.strictEqual(o.nextCalled, true);
            assert.strictEqual(o.req.auth?.expires_at, future.toISOString());
        });

        await step("rejects an expired token and deletes the stale session", async () => {
            const db = fakeDb([{ token: sha256("old"), user_id: "u", expires_at: past }]);
            setSqlExecutor(db.executor);
            const o = await run("Bearer old");
            assert.strictEqual(o.status, 401);
            assert.strictEqual(errorOf(o).message, "Token has expired");
            assert.strictEqual(o.nextCalled, false);
            assert.deepStrictEqual(db.deleted, [sha256("old")]);
            assert.strictEqual(o.req.auth, undefined);
        });
    } finally {
        setSqlExecutor(null);
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error("Test runner error:", error);
    process.exit(1);
});
