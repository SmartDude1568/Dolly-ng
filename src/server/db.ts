/**
 * Neon serverless Postgres connection.
 *
 * Uses the HTTP-based `neon()` SQL tagged-template helper, which is ideal
 * for serverless / short-lived processes (no persistent TCP connection).
 *
 * The executor is created lazily on first use (so importing this module never
 * throws when DATABASE_URL is absent) and can be swapped out via
 * {@link setSqlExecutor} — tests inject an in-memory Postgres this way.
 */

import { neon } from "@neondatabase/serverless";

/**
 * A Neon-compatible tagged-template SQL executor: called as
 * `` sql`SELECT ... ${value}` `` and resolves to an array of row objects.
 */
export type SqlExecutor = (
    strings: TemplateStringsArray,
    ...values: unknown[]
) => Promise<Record<string, unknown>[]>;

let executor: SqlExecutor | null = null;

/** Build the default Neon-backed executor from DATABASE_URL. */
function defaultExecutor(): SqlExecutor {
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
        throw new Error(
            "DATABASE_URL is not set. Provide the Neon connection string via the environment (see .env.example).",
        );
    }
    return neon(DATABASE_URL) as unknown as SqlExecutor;
}

/**
 * Override the SQL executor (e.g. an in-memory Postgres for tests). Pass `null`
 * to fall back to the default Neon-backed executor on the next query.
 */
export function setSqlExecutor(fn: SqlExecutor | null): void {
    executor = fn;
}

/**
 * Tagged-template SQL executor.
 *
 * Usage:
 *   const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
 */
export const sql: SqlExecutor = (strings, ...values) => {
    if (!executor) executor = defaultExecutor();
    return executor(strings, ...values);
};
