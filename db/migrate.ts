#!/usr/bin/env node
/**
 * Run the schema migration against the configured Neon database.
 *
 * Usage:
 *   npx tsx db/migrate.ts
 *
 * Requires DATABASE_URL in the environment (see .env / .env.example).
 * The schema is idempotent — safe to run multiple times.
 */

import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    throw new Error(
        "DATABASE_URL is not set. Provide the Neon connection string via the environment (see .env.example).",
    );
}

const sql = neon(DATABASE_URL);

const schemaPath = path.join(__dirname, "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");

// Split into individual statements and strip leading comment lines from each.
const statements = schema
    .split(/;\s*\n/)
    .map((s) => {
        // Strip leading blank lines and comment lines, keep the SQL
        return s.replace(/^(\s*(--[^\n]*)?\n)+/, "").trim();
    })
    .filter((s) => s.length > 0);

console.log(`Running ${statements.length} schema statements against Neon DB…`);

for (const stmt of statements) {
    try {
        await (sql as NeonQueryFunction<false, false>).query(stmt);
        // Print just the first non-comment line as a summary
        const firstSql = stmt.split("\n").find((l) => !l.trimStart().startsWith("--")) ?? stmt;
        console.log(`  ✓ ${firstSql.slice(0, 80)}`);
    } catch (err) {
        console.error(`  ✗ Failed: ${(err as Error).message}`);
        console.error(`    Statement: ${stmt.slice(0, 200)}`);
        process.exit(1);
    }
}

console.log("Migration complete.");
