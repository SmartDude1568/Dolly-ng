/**
 * In-process quality-metrics registry.
 *
 * Tracks the "Quality Metrics" defined in the design doc:
 *   1. Stem cache hits / misses     — recorded by src/cache.ts
 *   2. Errors in each module        — recorded by the worker stages, bpm, …
 *   3. Input audio length           — recorded on upload (src/server/routes/files.ts)
 *   4. Stemmer API process duration — recorded by the worker split stage
 *   5. audio2chart process duration — recorded by the worker chart stage
 *
 * Deliberately dependency-free and in-memory so it can be imported from both the
 * CLI and the server without dragging in the database. Counters are process-local
 * and reset on restart; the GET /metrics dashboard renders a live snapshot.
 */

/** How many recent events are retained per ring buffer for the activity feed. */
const RECENT_LIMIT = 50;

/** Aggregated view of a numeric metric (durations, audio lengths, …). */
export interface StatSnapshot {
    count: number;
    total: number;
    avg: number | null;
    min: number | null;
    max: number | null;
    last: number | null;
}

export interface RecentDuration {
    metric: string;
    ms: number;
    at: string;
}

export interface RecentError {
    module: string;
    message: string;
    at: string;
}

export interface ModuleErrors {
    module: string;
    count: number;
    last_message: string;
    last_at: string;
}

export interface MetricsSnapshot {
    started_at: string;
    uptime_sec: number;
    /** Metric 1 */
    cache: {
        hits: number;
        misses: number;
        total: number;
        /** Fraction of lookups served from cache (0–1), or null if none yet. */
        hit_rate: number | null;
    };
    /** Metric 2 */
    errors: {
        total: number;
        by_module: ModuleErrors[];
        recent: RecentError[];
    };
    /** Metric 3 — seconds of source audio analysed on upload. */
    audio_length_sec: StatSnapshot;
    /** Metrics 4 & 5 — process durations in milliseconds, keyed by stage. */
    durations: Record<string, StatSnapshot>;
    recent_durations: RecentDuration[];
}

/**
 * Full serialized state of the registry — the exact shape persisted to the
 * database so the metrics survive a restart. {@link MetricsRegistry.hydrate}
 * restores it.
 */
export interface SerializedMetrics {
    version: 1;
    started_at: number;
    cache_hits: number;
    cache_misses: number;
    errors_by_module: Array<[string, { count: number; lastMessage: string; lastAt: string }]>;
    recent_errors: RecentError[];
    audio_length_sec: RunningStatState;
    durations: Array<[string, RunningStatState]>;
    recent_durations: RecentDuration[];
}

/** Serialized form of a {@link RunningStat} (for DB persistence). */
export interface RunningStatState {
    count: number;
    total: number;
    min: number | null;
    max: number | null;
    last: number | null;
}

/** Streaming min/max/avg accumulator — no need to retain every sample. */
class RunningStat {
    private count = 0;
    private total = 0;
    private min: number | null = null;
    private max: number | null = null;
    private last: number | null = null;

    add(value: number): void {
        if (!Number.isFinite(value)) return;
        this.count++;
        this.total += value;
        this.min = this.min === null ? value : Math.min(this.min, value);
        this.max = this.max === null ? value : Math.max(this.max, value);
        this.last = value;
    }

    snapshot(): StatSnapshot {
        return {
            count: this.count,
            total: this.total,
            avg: this.count > 0 ? this.total / this.count : null,
            min: this.min,
            max: this.max,
            last: this.last,
        };
    }

    serialize(): RunningStatState {
        return { count: this.count, total: this.total, min: this.min, max: this.max, last: this.last };
    }

    restore(s: RunningStatState): void {
        this.count = Number(s.count) || 0;
        this.total = Number(s.total) || 0;
        this.min = s.min == null ? null : Number(s.min);
        this.max = s.max == null ? null : Number(s.max);
        this.last = s.last == null ? null : Number(s.last);
    }
}

class MetricsRegistry {
    private startedAt = Date.now();

    /**
     * Set whenever a metric changes; the server's persistence layer (see
     * src/server/metrics-store.ts) checks this on a timer and flushes to the
     * database only when there is something new to write.
     */
    private dirty = false;

    private cacheHits = 0;
    private cacheMisses = 0;

    private errorsByModule = new Map<string, { count: number; lastMessage: string; lastAt: string }>();
    private recentErrors: RecentError[] = [];

    private audioLengthSec = new RunningStat();

    // Pre-seed the two pipeline durations so the dashboard always shows both
    // stages even before any conversion has run.
    private durations = new Map<string, RunningStat>([
        ["stemmer", new RunningStat()],
        ["audio2chart", new RunningStat()],
    ]);
    private recentDurations: RecentDuration[] = [];

    // ── Metric 1: stem cache hits / misses ──────────────────────────────────

    recordCacheHit(count = 1): void {
        if (count > 0) {
            this.cacheHits += count;
            this.dirty = true;
        }
    }

    recordCacheMiss(count = 1): void {
        if (count > 0) {
            this.cacheMisses += count;
            this.dirty = true;
        }
    }

    // ── Metric 2: errors in each module ─────────────────────────────────────

    recordError(module: string, message: string): void {
        const at = new Date().toISOString();
        const existing = this.errorsByModule.get(module);
        if (existing) {
            existing.count++;
            existing.lastMessage = message;
            existing.lastAt = at;
        } else {
            this.errorsByModule.set(module, { count: 1, lastMessage: message, lastAt: at });
        }
        this.pushRecent(this.recentErrors, { module, message, at });
        this.dirty = true;
    }

    // ── Metric 3: input audio length ────────────────────────────────────────

    recordAudioLength(seconds: number): void {
        this.audioLengthSec.add(seconds);
        this.dirty = true;
    }

    // ── Metrics 4 & 5: process durations ────────────────────────────────────

    /** Record a stage duration in milliseconds (e.g. "stemmer", "audio2chart"). */
    recordDuration(metric: string, ms: number): void {
        if (!Number.isFinite(ms) || ms < 0) return;
        let stat = this.durations.get(metric);
        if (!stat) {
            stat = new RunningStat();
            this.durations.set(metric, stat);
        }
        stat.add(ms);
        this.pushRecent(this.recentDurations, { metric, ms, at: new Date().toISOString() });
        this.dirty = true;
    }

    /** Time an async operation and record how long it took under `metric`. */
    async time<T>(metric: string, fn: () => Promise<T>): Promise<T> {
        const start = Date.now();
        try {
            return await fn();
        } finally {
            this.recordDuration(metric, Date.now() - start);
        }
    }

    // ── Snapshot / reset ────────────────────────────────────────────────────

    snapshot(): MetricsSnapshot {
        const cacheTotal = this.cacheHits + this.cacheMisses;
        const byModule = [...this.errorsByModule.entries()]
            .map(([module, v]) => ({
                module,
                count: v.count,
                last_message: v.lastMessage,
                last_at: v.lastAt,
            }))
            .sort((a, b) => b.count - a.count);
        const errorTotal = byModule.reduce((sum, m) => sum + m.count, 0);

        const durations: Record<string, StatSnapshot> = {};
        for (const [name, stat] of this.durations) {
            durations[name] = stat.snapshot();
        }

        return {
            started_at: new Date(this.startedAt).toISOString(),
            uptime_sec: Math.round((Date.now() - this.startedAt) / 1000),
            cache: {
                hits: this.cacheHits,
                misses: this.cacheMisses,
                total: cacheTotal,
                hit_rate: cacheTotal > 0 ? this.cacheHits / cacheTotal : null,
            },
            errors: {
                total: errorTotal,
                by_module: byModule,
                recent: [...this.recentErrors].reverse(),
            },
            audio_length_sec: this.audioLengthSec.snapshot(),
            durations,
            recent_durations: [...this.recentDurations].reverse(),
        };
    }

    // ── Persistence (database) ──────────────────────────────────────────────

    /** True if a metric changed since the last {@link clearDirty}. */
    isDirty(): boolean {
        return this.dirty;
    }

    clearDirty(): void {
        this.dirty = false;
    }

    /** Capture the full state for persistence. */
    serialize(): SerializedMetrics {
        return {
            version: 1,
            started_at: this.startedAt,
            cache_hits: this.cacheHits,
            cache_misses: this.cacheMisses,
            errors_by_module: [...this.errorsByModule.entries()].map(([m, v]) => [m, { ...v }]),
            recent_errors: [...this.recentErrors],
            audio_length_sec: this.audioLengthSec.serialize(),
            durations: [...this.durations.entries()].map(([n, s]) => [n, s.serialize()]),
            recent_durations: [...this.recentDurations],
        };
    }

    /**
     * Replace the registry's state with a previously {@link serialize}d snapshot
     * loaded from the database. Defensive: malformed/partial data is skipped field by
     * field rather than throwing, so a corrupt key can never crash startup.
     * Leaves the registry clean (in sync with the store).
     */
    hydrate(state: unknown): void {
        if (!state || typeof state !== "object") return;
        const s = state as Partial<SerializedMetrics>;

        if (typeof s.started_at === "number") this.startedAt = s.started_at;
        if (typeof s.cache_hits === "number") this.cacheHits = s.cache_hits;
        if (typeof s.cache_misses === "number") this.cacheMisses = s.cache_misses;

        if (Array.isArray(s.errors_by_module)) {
            this.errorsByModule = new Map();
            for (const entry of s.errors_by_module) {
                if (!Array.isArray(entry)) continue;
                const [module, v] = entry;
                if (typeof module === "string" && v && typeof v === "object") {
                    this.errorsByModule.set(module, {
                        count: Number(v.count) || 0,
                        lastMessage: String(v.lastMessage ?? ""),
                        lastAt: String(v.lastAt ?? ""),
                    });
                }
            }
        }
        if (Array.isArray(s.recent_errors)) this.recentErrors = s.recent_errors.slice(-RECENT_LIMIT);

        if (s.audio_length_sec) this.audioLengthSec.restore(s.audio_length_sec);

        if (Array.isArray(s.durations)) {
            // Keep the two seeded stages, overlaying any persisted values.
            for (const entry of s.durations) {
                if (!Array.isArray(entry)) continue;
                const [name, raw] = entry;
                if (typeof name !== "string" || !raw) continue;
                let stat = this.durations.get(name);
                if (!stat) {
                    stat = new RunningStat();
                    this.durations.set(name, stat);
                }
                stat.restore(raw);
            }
        }
        if (Array.isArray(s.recent_durations)) this.recentDurations = s.recent_durations.slice(-RECENT_LIMIT);

        this.dirty = false;
    }

    /** Clear all collected metrics. Used by tests. */
    reset(): void {
        this.startedAt = Date.now();
        this.cacheHits = 0;
        this.cacheMisses = 0;
        this.errorsByModule.clear();
        this.recentErrors = [];
        this.audioLengthSec = new RunningStat();
        this.durations = new Map([
            ["stemmer", new RunningStat()],
            ["audio2chart", new RunningStat()],
        ]);
        this.recentDurations = [];
        this.dirty = false;
    }

    private pushRecent<T>(buffer: T[], item: T): void {
        buffer.push(item);
        if (buffer.length > RECENT_LIMIT) buffer.shift();
    }
}

/** Process-global metrics registry shared by the CLI and the API server. */
export const metrics = new MetricsRegistry();
