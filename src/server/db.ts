/**
 * Neon serverless Postgres connection.
 *
 * Uses the HTTP-based `neon()` SQL tagged-template helper, which is ideal
 * for serverless / short-lived processes (no persistent TCP connection).
 */

import { neon } from "@neondatabase/serverless";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    throw new Error(
        "DATABASE_URL is not set. Provide the Neon connection string via the environment (see .env.example).",
    );
}

/**
 * Tagged-template SQL executor.
 *
 * Usage:
 *   const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
 */
export const sql = neon(DATABASE_URL);
