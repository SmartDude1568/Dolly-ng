/**
 * Neon serverless Postgres connection.
 *
 * Uses the HTTP-based `neon()` SQL tagged-template helper, which is ideal
 * for serverless / short-lived processes (no persistent TCP connection).
 */

import { neon } from "@neondatabase/serverless";

const DATABASE_URL =
    process.env.DATABASE_URL ??
    "postgresql://neondb_owner:npg_YHcEx34sgUik@ep-old-sun-anu91iem.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require";

/**
 * Tagged-template SQL executor.
 *
 * Usage:
 *   const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
 */
export const sql = neon(DATABASE_URL);
