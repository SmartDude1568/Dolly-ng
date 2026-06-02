/**
 * Postgres-backed persistence for the quality-metrics registry.
 *
 * The in-memory `metrics` registry (src/metrics.ts) remains the live, zero-
 * latency accumulator. This layer makes its counts survive a restart by storing
 * the serialized snapshot in the same Neon Postgres database the rest of the app
 * uses (via DATABASE_URL / the shared `sql` executor) — no extra service:
 *
 *   • hydrateMetrics()  — on startup, load the last-persisted snapshot back into
 *                         the registry.
 *   • startMetricsPersistence() — flush to Postgres on a timer, but only when
 *                         something changed (the registry's dirty flag), bounding
 *                         write volume during a busy conversion.
 *   • flushMetrics()    — force an immediate write (used on graceful shutdown so
 *                         the final few seconds aren't lost).
 *
 * The whole snapshot is stored as one JSON string in the single-row
 * `metrics_state` table, keyed by {@link KEY}. That is faithful to the registry's
 * shape (counters + running stats + ring buffers) and atomic to upsert. It
 * assumes a single writer — the in-process server — matching the current
 * single-process worker model.
 *
 * Everything degrades gracefully: any DB error (including DATABASE_URL unset) is
 * caught and logged, so metrics simply stay in-memory as before.
 */

import { metrics } from "../metrics.js";
import { sql } from "./db.js";

/** Row key for the persisted snapshot (a single logical metrics document). */
const KEY = process.env.METRICS_DB_KEY ?? "global";
const DEFAULT_FLUSH_INTERVAL_MS = 5000;

// Ensure the table exists before the first read/write. schema.sql also creates
// it (the canonical migration path); this is a cheap safety net so persistence
// works even if `npm run migrate` hasn't been run for this table yet. Memoized
// so it runs at most once per successful creation.
let schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
    if (!schemaReady) {
        schemaReady = (async () => {
            await sql`
                CREATE TABLE IF NOT EXISTS metrics_state (
                    key        TEXT PRIMARY KEY,
                    snapshot   TEXT NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
            `;
        })();
        // On failure, allow a retry on the next call rather than caching the rejection.
        schemaReady.catch(() => {
            schemaReady = null;
        });
    }
    return schemaReady;
}

/** Load the persisted snapshot from Postgres into the registry, if present. */
export async function hydrateMetrics(): Promise<void> {
    try {
        await ensureSchema();
        const rows = await sql`SELECT snapshot FROM metrics_state WHERE key = ${KEY}`;
        const raw = rows[0]?.snapshot;
        if (typeof raw === "string" && raw.length > 0) {
            metrics.hydrate(JSON.parse(raw));
            console.log("[metrics] restored persisted metrics from the database");
        }
    } catch (err) {
        // A missing table / corrupt row / unset DATABASE_URL must never block startup.
        console.warn("[metrics] could not restore metrics from the database:", errMsg(err));
    }
}

/** Write the current registry state to Postgres. */
export async function flushMetrics(): Promise<void> {
    try {
        await ensureSchema();
        const payload = JSON.stringify(metrics.serialize());
        await sql`
            INSERT INTO metrics_state (key, snapshot, updated_at)
            VALUES (${KEY}, ${payload}, NOW())
            ON CONFLICT (key) DO UPDATE
                SET snapshot = EXCLUDED.snapshot, updated_at = NOW()
        `;
        metrics.clearDirty();
    } catch (err) {
        console.warn("[metrics] flush to the database failed:", errMsg(err));
    }
}

/**
 * Begin periodically flushing the registry to Postgres. Returns a stop function
 * that cancels the timer (the interval is unref'd so it never keeps the process
 * alive on its own).
 */
export function startMetricsPersistence(intervalMs = DEFAULT_FLUSH_INTERVAL_MS): () => void {
    const timer = setInterval(() => {
        if (metrics.isDirty()) void flushMetrics();
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
}

/** Test hook: forget the memoized schema check (e.g. after swapping executors). */
export function resetMetricsStoreForTest(): void {
    schemaReady = null;
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
