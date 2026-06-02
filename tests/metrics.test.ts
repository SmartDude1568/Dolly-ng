/**
 * Tests for the quality-metrics registry (src/metrics.ts) and the GET /metrics
 * endpoint (src/server/routes/metrics.ts).
 *
 * Two layers:
 *   1. Unit — record the five design-doc metrics into the registry and assert
 *      the aggregated snapshot() math (hit rate, per-module errors, durations,
 *      audio length stats).
 *   2. Endpoint — drive the real createApp() and assert /metrics serves the JSON
 *      snapshot (?format=json) and the HTML dashboard (Accept: text/html). No DB
 *      is touched by this route, so it runs without DATABASE_URL.
 *
 * Usage:  npx tsx tests/metrics.test.ts
 */

import * as assert from "node:assert";
import type { AddressInfo } from "node:net";

// The /metrics route doesn't query the DB; make sure db.ts can't reach Neon.
delete process.env.DATABASE_URL;

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

    const { metrics } = await import("../src/metrics.js");

    await step("snapshot() aggregates the five quality metrics", () => {
        metrics.reset();

        // 1. cache hits / misses
        metrics.recordCacheHit(3);
        metrics.recordCacheMiss(1);

        // 2. errors per module
        metrics.recordError("split_stems", "LALAL timeout");
        metrics.recordError("split_stems", "LALAL 502");
        metrics.recordError("bpm", "ffmpeg decode failed");

        // 3. input audio length (seconds)
        metrics.recordAudioLength(10);
        metrics.recordAudioLength(20);
        metrics.recordAudioLength(30);

        // 4 & 5. process durations (ms)
        metrics.recordDuration("stemmer", 100);
        metrics.recordDuration("stemmer", 300);
        metrics.recordDuration("audio2chart", 50);

        const s = metrics.snapshot();

        // cache
        assert.strictEqual(s.cache.hits, 3);
        assert.strictEqual(s.cache.misses, 1);
        assert.strictEqual(s.cache.total, 4);
        assert.strictEqual(s.cache.hit_rate, 0.75);

        // errors — sorted by count desc, split_stems (2) before bpm (1)
        assert.strictEqual(s.errors.total, 3);
        assert.strictEqual(s.errors.by_module.length, 2);
        assert.strictEqual(s.errors.by_module[0].module, "split_stems");
        assert.strictEqual(s.errors.by_module[0].count, 2);
        assert.strictEqual(s.errors.by_module[0].last_message, "LALAL 502");
        assert.strictEqual(s.errors.by_module[1].module, "bpm");
        // recent feed is newest-first
        assert.strictEqual(s.errors.recent[0].message, "ffmpeg decode failed");

        // audio length
        assert.strictEqual(s.audio_length_sec.count, 3);
        assert.strictEqual(s.audio_length_sec.avg, 20);
        assert.strictEqual(s.audio_length_sec.min, 10);
        assert.strictEqual(s.audio_length_sec.max, 30);
        assert.strictEqual(s.audio_length_sec.total, 60);

        // durations
        assert.strictEqual(s.durations.stemmer.count, 2);
        assert.strictEqual(s.durations.stemmer.avg, 200);
        assert.strictEqual(s.durations.stemmer.min, 100);
        assert.strictEqual(s.durations.stemmer.max, 300);
        assert.strictEqual(s.durations.stemmer.last, 300);
        assert.strictEqual(s.durations.audio2chart.count, 1);
        assert.strictEqual(s.durations.audio2chart.avg, 50);
    });

    await step("hit_rate is null and durations exist before any data", () => {
        metrics.reset();
        const s = metrics.snapshot();
        assert.strictEqual(s.cache.hit_rate, null);
        assert.strictEqual(s.cache.total, 0);
        assert.strictEqual(s.errors.total, 0);
        assert.strictEqual(s.audio_length_sec.count, 0);
        assert.strictEqual(s.audio_length_sec.avg, null);
        // The two pipeline stages are always present (seeded), even at zero.
        assert.ok("stemmer" in s.durations);
        assert.ok("audio2chart" in s.durations);
        assert.strictEqual(s.durations.stemmer.count, 0);
    });

    await step("time() records the wrapped operation's duration", async () => {
        metrics.reset();
        const result = await metrics.time("stemmer", async () => {
            await new Promise((r) => setTimeout(r, 10));
            return 42;
        });
        assert.strictEqual(result, 42);
        const s = metrics.snapshot();
        assert.strictEqual(s.durations.stemmer.count, 1);
        assert.ok((s.durations.stemmer.last ?? 0) >= 0, "recorded a duration sample");
    });

    await step("invalid samples are ignored", () => {
        metrics.reset();
        metrics.recordDuration("stemmer", -5);
        metrics.recordDuration("stemmer", NaN);
        metrics.recordCacheHit(0);
        metrics.recordCacheMiss(-2);
        const s = metrics.snapshot();
        assert.strictEqual(s.durations.stemmer.count, 0);
        assert.strictEqual(s.cache.hits, 0);
        assert.strictEqual(s.cache.misses, 0);
    });

    // ── Persistence ──────────────────────────────────────────────────────
    await step("serialize → hydrate round-trips the full state", () => {
        metrics.reset();
        metrics.recordCacheHit(5);
        metrics.recordCacheMiss(2);
        metrics.recordError("audio2chart", "GPU timeout");
        metrics.recordAudioLength(123.4);
        metrics.recordDuration("stemmer", 999);

        const serialized = JSON.parse(JSON.stringify(metrics.serialize()));
        const before = metrics.snapshot();

        // Wipe, then restore from the serialized blob.
        metrics.reset();
        assert.strictEqual(metrics.snapshot().cache.hits, 0);
        metrics.hydrate(serialized);

        const after = metrics.snapshot();
        assert.strictEqual(after.cache.hits, before.cache.hits);
        assert.strictEqual(after.cache.misses, before.cache.misses);
        assert.strictEqual(after.errors.total, before.errors.total);
        assert.strictEqual(after.errors.by_module[0].module, "audio2chart");
        assert.strictEqual(after.audio_length_sec.last, 123.4);
        assert.strictEqual(after.durations.stemmer.last, 999);
        assert.strictEqual(after.started_at, before.started_at);
        // A freshly hydrated registry is in sync with the store.
        assert.strictEqual(metrics.isDirty(), false);
    });

    await step("dirty flag tracks unflushed changes", () => {
        metrics.reset();
        assert.strictEqual(metrics.isDirty(), false);
        metrics.recordCacheHit();
        assert.strictEqual(metrics.isDirty(), true);
        metrics.clearDirty();
        assert.strictEqual(metrics.isDirty(), false);
    });

    await step("hydrate tolerates malformed/partial data", () => {
        metrics.reset();
        metrics.recordCacheHit(3);
        // None of these should throw or corrupt existing counters.
        metrics.hydrate(null);
        metrics.hydrate("not an object");
        metrics.hydrate({ cache_hits: "garbage", durations: "nope", errors_by_module: [["x"]] });
        assert.strictEqual(metrics.snapshot().cache.hits, 3);
    });

    await step("flushMetrics → hydrateMetrics persists through Postgres", async () => {
        const { setSqlExecutor } = await import("../src/server/db.js");
        const { flushMetrics, hydrateMetrics, resetMetricsStoreForTest } =
            await import("../src/server/metrics-store.js");

        // Real in-memory Postgres (pg-mem), driven by the shared executor —
        // exercises the actual CREATE TABLE / upsert / SELECT SQL.
        const { newDb } = await import("pg-mem");
        const mem = newDb();
        const { Client } = mem.adapters.createPg();
        const client = new Client();
        await client.connect();

        let chain: Promise<unknown> = Promise.resolve();
        setSqlExecutor((strings, ...values) => {
            let text = strings[0]!;
            for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1];
            const run = chain.then(() =>
                client.query(text, values).then((r: { rows: Record<string, unknown>[] }) => r.rows),
            );
            chain = run.catch(() => {});
            return run as Promise<Record<string, unknown>[]>;
        });
        resetMetricsStoreForTest();

        try {
            metrics.reset();
            metrics.recordCacheHit(4);
            metrics.recordDuration("audio2chart", 4321);
            assert.strictEqual(metrics.isDirty(), true);

            await flushMetrics();
            assert.strictEqual(metrics.isDirty(), false, "flush clears the dirty flag");

            const rows = await client.query("SELECT key, snapshot FROM metrics_state");
            assert.strictEqual(rows.rows.length, 1, "one snapshot row written");
            assert.strictEqual(rows.rows[0].key, "global");

            // Simulate a restart: wipe in-memory state, hydrate from Postgres.
            metrics.reset();
            assert.strictEqual(metrics.snapshot().cache.hits, 0);
            await hydrateMetrics();

            const s = metrics.snapshot();
            assert.strictEqual(s.cache.hits, 4, "cache hits survived the restart");
            assert.strictEqual(s.durations.audio2chart.last, 4321, "durations survived the restart");

            // A second flush upserts the same row rather than inserting a duplicate.
            metrics.recordCacheMiss(1);
            await flushMetrics();
            const rows2 = await client.query("SELECT COUNT(*)::int AS n FROM metrics_state");
            assert.strictEqual(rows2.rows[0].n, 1, "upsert keeps a single row");
        } finally {
            setSqlExecutor(null);
            resetMetricsStoreForTest();
            try {
                await client.end();
            } catch { /* ignore */ }
        }
    });

    await step("flush/hydrate are no-ops when the database is unconfigured", async () => {
        const { setSqlExecutor } = await import("../src/server/db.js");
        const { flushMetrics, hydrateMetrics, resetMetricsStoreForTest } =
            await import("../src/server/metrics-store.js");
        // No executor injected and DATABASE_URL is unset → sql() throws, which
        // these must swallow without wiping the in-memory metrics.
        setSqlExecutor(null);
        resetMetricsStoreForTest();
        delete process.env.DATABASE_URL;
        metrics.reset();
        metrics.recordCacheHit(2);
        await flushMetrics(); // must not throw
        await hydrateMetrics(); // must not throw / wipe
        assert.strictEqual(metrics.snapshot().cache.hits, 2);
    });

    // ── Endpoint ─────────────────────────────────────────────────────────
    const { createApp } = await import("../src/server/app.js");
    const app = createApp({ rateLimit: false });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
        await step("GET /metrics?format=json returns the snapshot", async () => {
            metrics.reset();
            metrics.recordCacheHit(2);
            metrics.recordCacheMiss(2);
            metrics.recordDuration("audio2chart", 1234);

            const res = await fetch(`${base}/metrics?format=json`);
            assert.strictEqual(res.status, 200);
            assert.match(res.headers.get("content-type") ?? "", /application\/json/);
            const body = await res.json();
            assert.strictEqual(body.cache.hits, 2);
            assert.strictEqual(body.cache.hit_rate, 0.5);
            assert.strictEqual(body.durations.audio2chart.last, 1234);
            assert.ok(typeof body.uptime_sec === "number");
        });

        await step("GET /metrics with Accept: application/json returns JSON", async () => {
            const res = await fetch(`${base}/metrics`, { headers: { Accept: "application/json" } });
            assert.strictEqual(res.status, 200);
            assert.match(res.headers.get("content-type") ?? "", /application\/json/);
        });

        await step("GET /metrics with Accept: text/html serves the dashboard page", async () => {
            const res = await fetch(`${base}/metrics`, { headers: { Accept: "text/html" } });
            assert.strictEqual(res.status, 200);
            assert.match(res.headers.get("content-type") ?? "", /text\/html/);
            const html = await res.text();
            assert.ok(html.includes("Quality metrics"), "dashboard page rendered");
            assert.ok(html.includes("metrics.js"), "dashboard loads its script");
        });

        await step("/metrics is reachable without authentication", async () => {
            // No Authorization header — must not 401 like the /v1 routes do.
            const res = await fetch(`${base}/metrics?format=json`);
            assert.notStrictEqual(res.status, 401);
            assert.strictEqual(res.status, 200);
        });
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((error) => {
    console.error("Metrics test runner error:", error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
});
