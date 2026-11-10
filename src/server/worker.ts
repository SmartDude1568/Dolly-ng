/**
 * Conversion worker — drives the full Dolly pipeline for a single conversion.
 *
 * Stages (one DB task each):
 *   split_stems  — LALAL.ai separates the song into per-instrument stems
 *   audio2chart  — each stem is charted by the Modal audio2chart service; the
 *                  resulting [ExpertSingle] section is remapped onto the target
 *                  Clone Hero instrument track
 *   upload_s3    — the merged notes.chart, the full mix, the stem audio and a
 *                  song.ini are packaged into a downloadable .sng archive
 *
 * The worker runs in-process (fire-and-forget) and reports progress by
 * updating the task / conversion rows in Neon.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

import { LalalSplitter, type LalalStem } from "../split/lalal.js";
import { Audio2ChartModal } from "../chart/audio2chart.js";
import { parseChart, type Chart, type ChartSection, type TrackEvent } from "../chart/parse.js";
import { writeChart } from "../chart/write.js";
import { mergeCharts } from "../chart/merge.js";
import { packSng, type SngEntry } from "../sng.js";
import { metrics } from "../metrics.js";
import {
    dbUpdateTask,
    dbUpdateConversionStatus,
    dbInsertFile,
} from "./db-helpers.js";
import type { ConversionRecord, FileRecord, TaskRecord, TaskStatus } from "./types.js";

const MODAL_URL =
    process.env.MODAL_GENERATE_URL ??
    "https://melvillevt--audio2chart-generate.modal.run";

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? path.resolve("./output");

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
// ffmpeg-static exports the binary path (CJS `export =`).
const FFMPEG_PATH: string = require("ffmpeg-static");

/**
 * Transcode any audio file to Ogg/Opus, the format Clone Hero's BASS backend
 * expects inside a .sng (MP3 is rejected with a FileFormat error).
 */
async function transcodeToOpus(input: string, output: string): Promise<void> {
    try {
        await execFileAsync(
            FFMPEG_PATH,
            ["-y", "-i", input, "-c:a", "libopus", "-b:a", "128k", output],
            { timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 * 32 },
        );
    } catch (err) {
        // execFile rejects with a bare "Command failed" message that drops
        // ffmpeg's own output, making a killed child indistinguishable from a
        // real encode error. Surface the stderr tail + how the process exited.
        const e = err as {
            stderr?: string | Buffer;
            signal?: string | null;
            killed?: boolean;
            code?: number | string;
        };
        const stderr = (e.stderr ? e.stderr.toString() : "").trim();
        const tail = stderr.split(/\r?\n/).slice(-8).join("\n");
        const parts = [`ffmpeg transcode failed for ${path.basename(input)}`];
        if (e.killed || e.signal) {
            parts.push(`(process killed${e.signal ? ` by ${e.signal}` : ""} — likely interrupted/timed out)`);
        } else if (e.code !== undefined) {
            parts.push(`(exit ${e.code})`);
        }
        parts.push(tail ? `ffmpeg output:\n${tail}` : "(ffmpeg produced no output)");
        throw new Error(parts.join(" "));
    }
}

/** How a requested instrument maps onto a LALAL stem + a CH chart track. */
interface InstrumentMapEntry {
    /** LALAL stem to isolate for this instrument. */
    stem: LalalStem;
    /** Clone Hero track-section suffix (after the difficulty prefix). */
    section: string;
    /** Clone Hero stem-audio base filename. */
    chName: string;
}

// ISSUE 4: `vocals` was previously mapped to section "Single" — the same track
// guitar uses — so requesting both guitar and vocals made mergeCharts silently
// drop one. Charting vocals as a 5-fret guitar track is also musically wrong
// (Clone Hero expects a dedicated lyrics/vocals track, which audio2chart does
// not produce). Vocals is therefore intentionally NOT a chartable instrument;
// requesting it fails the task with a clear error (see normalizeInstrument).
const INSTRUMENT_MAP: Record<string, InstrumentMapEntry> = {
    guitar: { stem: "electric_guitar", section: "Single", chName: "guitar" },
    bass: { stem: "bass", section: "DoubleBass", chName: "bass" },
    drums: { stem: "drum", section: "Drums", chName: "drums" },
    drum: { stem: "drum", section: "Drums", chName: "drums" },
    keys: { stem: "piano", section: "Keyboard", chName: "keys" },
    keyboard: { stem: "piano", section: "Keyboard", chName: "keys" },
    piano: { stem: "piano", section: "Keyboard", chName: "keys" },
};

const DIFFICULTY_PREFIX: Record<string, string> = {
    expert: "Expert",
    hard: "Hard",
    medium: "Medium",
    easy: "Easy",
};

function normalizeInstrument(name: string): InstrumentMapEntry {
    const key = name.trim().toLowerCase();
    const entry = INSTRUMENT_MAP[key];
    // ISSUE 15: previously an unrecognized name silently fell back to a guitar
    // track, so a typo produced a wrong-but-silent chart. Fail loudly instead —
    // the thrown error propagates to runConversion's catch and marks the task
    // failed with a visible message (rather than emitting a bogus track).
    if (!entry) {
        throw new Error(
            `unsupported instrument "${name}" (supported: ${Object.keys(INSTRUMENT_MAP).join(", ")})`,
        );
    }
    return entry;
}

function sanitize(name: string): string {
    return name.replace(/[^a-z0-9_\-. ]/gi, "_").trim() || "song";
}

/** A per-instrument chart after it has been remapped onto its CH track. */
export interface ChartedInstrument {
    /** Canonical instrument name (guitar, bass, drums, keys). */
    instrument: string;
    /** How this instrument maps to a stem / CH track. */
    entry: InstrumentMapEntry;
    /** Full target section, e.g. "ExpertSingle". */
    section: string;
    /** The remapped single-track chart. */
    chart: Chart;
}

/** Count the note (`N`) events in a chart's named track section. */
export function countSectionNotes(chart: Chart, section: string): number {
    const sec = chart.tracks.get(section);
    if (!sec) return 0;
    let n = 0;
    for (const ev of sec.events) if (ev.typeCode === "N") n++;
    return n;
}

/**
 * Partition charted instruments into those that actually carry notes and those
 * audio2chart returned empty (no `N` events on the target track).
 *
 * THE DROPPED-GUITAR BUG: audio2chart can hand back a chart whose instrument
 * track has no notes (e.g. when a separated stem is near-silent). The worker
 * used to advertise every *requested* instrument in song.ini regardless, so a
 * note-less guitar still set `diff_guitar`. Clone Hero then hides a part it was
 * promised but cannot find in notes.chart — the song loads "without a guitar
 * option". Dropping note-less instruments here keeps song.ini and notes.chart in
 * agreement so CH only ever shows parts that are really playable.
 */
export function selectInstrumentsWithNotes<T extends { chart: Chart; section: string }>(
    charted: T[],
): { kept: T[]; dropped: T[] } {
    const kept: T[] = [];
    const dropped: T[] = [];
    for (const c of charted) {
        if (countSectionNotes(c.chart, c.section) > 0) kept.push(c);
        else dropped.push(c);
    }
    return { kept, dropped };
}

/**
 * Build the song.ini `diff_*` fields from the set of CH instrument base names
 * (guitar/bass/drums/keys) that actually landed notes in the merged chart, so
 * the advertised difficulties always match the tracks present in notes.chart.
 */
export function songIniDiffFields(
    producedChNames: Set<string>,
    diffValue: string,
): { diff_guitar: string; diff_bass: string; diff_drums: string; diff_keys: string } {
    return {
        diff_guitar: producedChNames.has("guitar") ? diffValue : "-1",
        diff_bass: producedChNames.has("bass") ? diffValue : "-1",
        diff_drums: producedChNames.has("drums") ? diffValue : "-1",
        diff_keys: producedChNames.has("keys") ? diffValue : "-1",
    };
}

/**
 * ISSUE 6: remove a conversion's intermediate artifacts (stems, transcoded
 * .opus, notes.chart, cached per-instrument .chart files, etc.) once the .sng
 * is packaged, to stop OUTPUT_DIR growing without bound. The served output file
 * (`keepPath`) is preserved; everything else in `workDir` is deleted. Best
 * effort — failures are logged and swallowed so cleanup never fails a
 * successful conversion.
 */
function cleanupIntermediates(workDir: string, keepPath: string, log: (msg: string) => void): void {
    let entries: string[];
    try {
        entries = fs.readdirSync(workDir);
    } catch {
        return;
    }
    const keep = path.resolve(keepPath);
    let removed = 0;
    for (const name of entries) {
        const full = path.join(workDir, name);
        if (path.resolve(full) === keep) continue; // never delete the served .sng
        try {
            fs.rmSync(full, { recursive: true, force: true });
            removed++;
        } catch (err) {
            log(`cleanup: could not remove ${name}: ${err instanceof Error ? err.message : err}`);
        }
    }
    if (removed > 0) log(`cleaned up ${removed} intermediate artifact(s)`);
}

/**
 * Rebuild the stem→path map from files left on disk by a prior split, so an
 * interrupted conversion can resume without re-running LALAL. Returns null if
 * any expected stem file is missing (forcing a fresh split).
 */
function existingStemMap(
    workDir: string,
    inputLocalPath: string,
    stems: LalalStem[],
): Map<LalalStem, string> | null {
    const baseName = path.basename(inputLocalPath, path.extname(inputLocalPath));
    const map = new Map<LalalStem, string>();
    for (const stem of stems) {
        const p = path.join(workDir, `${baseName}_${stem}.wav`);
        if (!fs.existsSync(p)) return null;
        map.set(stem, p);
    }
    return map;
}

/**
 * The two external services the pipeline depends on. Pulling them behind an
 * interface lets tests run the full worker (split → chart → merge → pack)
 * against in-process fakes, with no LALAL / Modal calls or API keys.
 */
export interface WorkerExternals {
    /** Build the stem splitter that writes per-instrument audio into `outputDir`. */
    createSplitter(outputDir: string): {
        split(
            input: string,
            stems: LalalStem[],
        ): Promise<{ stems: { stem: LalalStem; path: string }[] }>;
    };
    /** Build the audio2chart client used to chart each stem. */
    createChartClient(opts: { bpm: number | undefined }): {
        generateText(
            audioPath: string,
            overrides?: { name?: string; sustains?: boolean; beatAudioPath?: string },
        ): Promise<string>;
    };
}

let externalsOverride: WorkerExternals | null = null;

/**
 * Override the worker's external services (LALAL splitter + audio2chart client).
 * Pass `null` to restore the real implementations. Used by tests.
 */
export function setWorkerExternals(externals: WorkerExternals | null): void {
    externalsOverride = externals;
}

export interface RunConversionArgs {
    conversion: ConversionRecord;
    tasks: TaskRecord[];
    inputFile: FileRecord;
    instruments: string[];
    difficulty: string;
    /** Confirmed tempo for the song; forwarded to audio2chart for timing. */
    bpm?: number | null;
}

/**
 * ISSUE 7: cap how many conversions run their (CPU/GPU/network-heavy) pipeline
 * at once. `startConversion` is fire-and-forget and the startup resume sweep can
 * relaunch every interrupted conversion simultaneously, which would otherwise
 * flood LALAL/Modal/ffmpeg with unbounded parallelism. A tiny in-process
 * semaphore serializes the excess into a FIFO queue. Configurable via
 * WORKER_CONCURRENCY (default 2); no external deps.
 */
const MAX_CONCURRENT_CONVERSIONS = (() => {
    const n = Number(process.env.WORKER_CONCURRENCY);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
})();

let activeConversions = 0;
const conversionQueue: Array<() => void> = [];

/** Acquire a run slot, waiting in FIFO order if the limit is reached. */
function acquireConversionSlot(): Promise<void> {
    if (activeConversions < MAX_CONCURRENT_CONVERSIONS) {
        activeConversions++;
        return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
        conversionQueue.push(() => {
            activeConversions++;
            resolve();
        });
    });
}

/** Release a run slot and hand it to the next waiter, if any. */
function releaseConversionSlot(): void {
    activeConversions--;
    const next = conversionQueue.shift();
    if (next) next();
}

/** Fire-and-forget entry point — never throws to the caller. */
export function startConversion(args: RunConversionArgs): void {
    (async () => {
        await acquireConversionSlot();
        try {
            await runConversion(args);
        } finally {
            releaseConversionSlot();
        }
    })().catch((err) => {
        console.error(
            `[worker] conversion ${args.conversion.conversion_id} crashed:`,
            err instanceof Error ? err.stack ?? err.message : err,
        );
    });
}

export async function runConversion(args: RunConversionArgs): Promise<void> {
    const { conversion, tasks, inputFile, instruments, difficulty } = args;
    // A confirmed tempo (>0) drives audio2chart's note timing and the final
    // SyncTrack; fall back to the file's stored BPM if the caller omitted it.
    const bpm = normalizeBpm(args.bpm ?? inputFile.bpm);
    const convId = conversion.conversion_id;
    const log = (msg: string) => console.log(`[worker ${convId}] ${msg}`);

    const splitTask = tasks.find((t) => t.type === "split_stems");
    const a2cTasks = tasks.filter((t) => t.type === "audio2chart");
    const uploadTask = tasks.find((t) => t.type === "upload_s3");

    const workDir = path.join(OUTPUT_DIR, "conversions", convId);
    fs.mkdirSync(workDir, { recursive: true });

    // Track which task is currently running so a crash can mark it failed.
    let active: TaskRecord | undefined;

    try {
        if (!splitTask || !uploadTask) {
            throw new Error("conversion is missing required split/upload tasks");
        }

        const instrEntries = instruments.map(normalizeInstrument);
        const songTitle = inputFile.name.replace(/\.[^.]+$/, "") || "Dolly Song";

        // ── 1. split_stems ───────────────────────────────────────────────
        active = splitTask;
        const wantedStems = [...new Set(instrEntries.map((e) => e.stem))];

        // Resume: if the split already completed and its stems are still on
        // disk, reuse them instead of paying for another LALAL split.
        let stemPathByStem =
            splitTask.status === "completed"
                ? existingStemMap(workDir, inputFile.local_path, wantedStems)
                : null;

        if (stemPathByStem) {
            log(`reusing ${stemPathByStem.size} cached stem(s)`);
        } else {
            await setTask(splitTask, "processing", 5);
            log("splitting stems via LALAL…");

            let splitter: ReturnType<WorkerExternals["createSplitter"]>;
            if (externalsOverride) {
                splitter = externalsOverride.createSplitter(workDir);
            } else {
                const apiKey = process.env.LALAL_API_KEY;
                if (!apiKey) throw new Error("LALAL_API_KEY is not configured");
                splitter = new LalalSplitter({ apiKey, outputDir: workDir });
            }
            // Metric 4: stemmer API process duration.
            const splitStart = Date.now();
            const splitResult = await splitter.split(inputFile.local_path, wantedStems);
            metrics.recordDuration("stemmer", Date.now() - splitStart);
            stemPathByStem = new Map(splitResult.stems.map((s) => [s.stem, s.path]));
            log(`stems ready: ${splitResult.stems.map((s) => s.stem).join(", ")}`);
            await setTask(splitTask, "completed", 100);
        }

        // ── 2. audio2chart per instrument ────────────────────────────────
        if (bpm) log(`using tempo ${bpm} BPM for chart timing`);
        const modal = externalsOverride
            ? externalsOverride.createChartClient({ bpm: bpm ?? undefined })
            : new Audio2ChartModal({
                  endpointUrl: MODAL_URL,
                  token: process.env.AUDIO2CHART_TOKEN,
                  artist: "Dolly",
                  charter: "Dolly",
                  bpm: bpm ?? undefined,
              });
        const diffPrefix = DIFFICULTY_PREFIX[difficulty.toLowerCase()] ?? "Expert";
        const charted: ChartedInstrument[] = [];

        for (let i = 0; i < instrEntries.length; i++) {
            const instrument = instruments[i]!;
            const entry = instrEntries[i]!;
            const task =
                a2cTasks.find((t) => (t.settings as { instrument?: string }).instrument === instrument) ??
                a2cTasks[i];

            // Resume: reuse a chart from a prior run if its task completed and
            // the chart text was persisted; otherwise (re)generate it.
            const chartCachePath = path.join(workDir, `chart_${sanitize(instrument)}.chart`);
            let text: string;
            if (task && task.status === "completed" && fs.existsSync(chartCachePath)) {
                text = fs.readFileSync(chartCachePath, "utf8");
                log(`reusing chart for ${instrument}`);
            } else {
                if (task) {
                    active = task;
                    await setTask(task, "processing", 10);
                }
                log(`charting ${instrument} (${entry.stem})…`);

                const stemPath = stemPathByStem.get(entry.stem) ?? inputFile.local_path;
                // Metric 5: audio2chart process duration (per stem/instrument).
                const chartStart = Date.now();
                text = await modal.generateText(stemPath, {
                    name: `${songTitle} (${instrument})`,
                    // Drums have no sustains in Clone Hero; every other part does.
                    sustains: entry.section !== "Drums",
                    // Beats are tracked on the full mix; a lone stem is unreliable.
                    beatAudioPath: inputFile.local_path,
                });
                metrics.recordDuration("audio2chart", Date.now() - chartStart);
                fs.writeFileSync(chartCachePath, text, "utf8");

                if (task) await setTask(task, "completed", 100);
            }

            const chart = parseChart(text);
            const section = `${diffPrefix}${entry.section}`;
            charted.push({
                instrument,
                entry,
                section,
                chart: remapChartTracks(chart, section, entry.section === "Drums"),
            });
        }

        if (charted.length === 0) {
            throw new Error("no instrument charts were generated");
        }

        // Drop any instrument audio2chart returned with no notes so the
        // packaged .sng never advertises a part that notes.chart lacks (the
        // dropped-guitar bug). Surface each drop loudly rather than silently
        // shipping an inconsistent .sng.
        const { kept, dropped } = selectInstrumentsWithNotes(charted);
        for (const d of dropped) {
            const msg = `audio2chart produced no notes for ${d.instrument} (stem ${d.entry.stem}); excluding it from the chart`;
            log(`WARNING: ${msg}`);
            metrics.recordError("audio2chart", msg);
        }
        if (kept.length === 0) {
            throw new Error("no instrument produced any chart notes");
        }
        const perInstrumentCharts = kept.map((c) => c.chart);

        // ── 3. merge ─────────────────────────────────────────────────────
        const merged =
            perInstrumentCharts.length === 1
                ? perInstrumentCharts[0]!
                : mergeCharts(perInstrumentCharts, { conflictStrategy: "last-wins" });

        merged.song.Name = songTitle;
        merged.song.Artist = "Dolly";
        merged.song.Charter = "Dolly (audio2chart)";
        merged.song.MusicStream = "song.opus";

        // Guarantee the final SyncTrack tempo matches the BPM we charted with,
        // so Clone Hero plays the notes at the speed the user confirmed.
        if (bpm) enforceTempo(merged, bpm);

        const notesChart = writeChart(merged);
        fs.writeFileSync(path.join(workDir, "notes.chart"), notesChart, "utf8");

        // ── 4. upload_s3 (package .sng) ──────────────────────────────────
        active = uploadTask;
        if (uploadTask.status === "completed" && uploadTask.output_file_id) {
            log("packaging already complete; nothing to do");
            await dbUpdateConversionStatus(convId, "completed");
            log("conversion completed");
            return;
        }
        await setTask(uploadTask, "processing", 20);
        log("packaging .sng…");

        const entries: SngEntry[] = [];
        entries.push({ name: "notes.chart", data: Buffer.from(notesChart, "utf8") });

        // Transcode the full mix to Opus — the single playback stream. Clone
        // Hero sums every root-level audio stream, so we keep only `song.opus`
        // as playable audio and ship the separated stems under stems/ (ignored
        // by the mixer) to deliver the separation without doubling.
        const songOpus = path.join(workDir, "song.opus");
        await transcodeToOpus(inputFile.local_path, songOpus);
        entries.push({ name: "song.opus", data: fs.readFileSync(songOpus) });

        // Only ship stem audio for instruments that actually charted, so the
        // stems/ folder matches the parts present in notes.chart.
        const seenStemAudio = new Set<string>();
        for (const { entry } of kept) {
            if (seenStemAudio.has(entry.chName)) continue;
            const sp = stemPathByStem.get(entry.stem);
            if (sp && fs.existsSync(sp)) {
                const stemOpus = path.join(workDir, `stem_${entry.chName}.opus`);
                await transcodeToOpus(sp, stemOpus);
                entries.push({ name: `stems/${entry.chName}.opus`, data: fs.readFileSync(stemOpus) });
                seenStemAudio.add(entry.chName);
            }
        }

        // Clone Hero reads the embedded metadata as the song.ini, so no separate
        // song.ini file is needed inside the archive. Advertise only the parts
        // that actually produced notes (see selectInstrumentsWithNotes) so the
        // difficulties line up with the tracks in notes.chart.
        const diffValue = String({ Expert: 5, Hard: 4, Medium: 3, Easy: 1 }[diffPrefix] ?? 5);
        const producedChNames = new Set(kept.map((c) => c.entry.chName));
        const sngBuf = packSng(entries, {
            name: songTitle,
            artist: "Dolly",
            album: "audio2chart",
            genre: "Rock",
            charter: "Dolly (audio2chart)",
            ...songIniDiffFields(producedChNames, diffValue),
        });
        const sngName = `${sanitize(songTitle)}.sng`;
        const sngPath = path.join(workDir, sngName);
        fs.writeFileSync(sngPath, sngBuf);
        log(`wrote ${sngName} (${sngBuf.length} bytes)`);

        // Register the .sng as a downloadable file and link it to the task.
        const fileRec: FileRecord = {
            file_id: `file_${crypto.randomUUID().slice(0, 8)}`,
            user_id: conversion.user_id,
            name: sngName,
            size_bytes: sngBuf.length,
            mime_type: "application/octet-stream",
            // Generated artifact — not a chartable source song.
            kind: "output",
            local_path: sngPath,
            created_at: new Date().toISOString(),
        };
        await dbInsertFile(fileRec);
        await dbUpdateTask(uploadTask.task_id, { output_file_id: fileRec.file_id });
        await setTask(uploadTask, "completed", 100);

        await dbUpdateConversionStatus(convId, "completed");
        // ISSUE 6: reclaim the per-conversion intermediates (stems, .opus,
        // notes.chart, chart caches) now that the .sng is built. The served
        // output is preserved.
        cleanupIntermediates(workDir, sngPath, log);
        log("conversion completed");
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[worker ${convId}] failed: ${message}`);
        // Metric 2: attribute the failure to the pipeline stage (module) that
        // was running when it threw, falling back to the worker itself.
        metrics.recordError(active?.type ?? "worker", message);
        if (active) {
            await dbUpdateTask(active.task_id, {
                status: "failed",
                error: { code: "WORKER_ERROR", message },
                completed_at: new Date().toISOString(),
            }).catch(() => {});
        }
        await dbUpdateConversionStatus(convId, "failed").catch(() => {});
    }
}

const AUDIO2CHART_DIFFICULTIES = ["Expert", "Hard", "Medium", "Easy"] as const;
const DIFFICULTY_PREFIX_RE = /^(Expert|Hard|Medium|Easy)/;

/**
 * Rebuild a chart so its instrument tracks land on `targetSection`.
 *
 * audio2chart emits a `[<Difficulty>Single]` track per difficulty it generated (Expert,
 * plus real Hard/Medium/Easy reductions); each is placed on the same Clone Hero
 * instrument as `targetSection` under its own difficulty prefix. An older deployment
 * returns only `[ExpertSingle]`: that single track is placed on `targetSection` as-is,
 * so the requested difficulty is still honoured.
 *
 * When `drums` is set the note lanes are also translated from 5-lane guitar
 * semantics to drum semantics (see {@link remapDrumEvent}). This is required:
 * Clone Hero silently refuses to load a drums track that contains illegal
 * lanes (the guitar open note 7 / force 5 / tap 6 markers), so a verbatim
 * copy of the guitar chart leaves the song with no playable drums at all.
 */
export function remapChartTracks(chart: Chart, targetSection: string, drums = false): Chart {
    const tracks = new Map<string, ChartSection>();
    const place = (name: string, source: ChartSection): void => {
        const events = drums
            ? dedupeDrumNoteEvents(source.events.flatMap(remapDrumEvent))
            : source.events;
        tracks.set(name, { name, events });
    };

    const generated = AUDIO2CHART_DIFFICULTIES.filter((d) => chart.tracks.has(`${d}Single`));
    if (generated.length > 1) {
        const instrumentSection = targetSection.replace(DIFFICULTY_PREFIX_RE, "");
        for (const difficulty of generated) {
            place(`${difficulty}${instrumentSection}`, chart.tracks.get(`${difficulty}Single`)!);
        }
    } else {
        // Prefer an ExpertSingle source; otherwise take the first available track.
        const source = chart.tracks.get("ExpertSingle") ?? [...chart.tracks.values()][0];
        if (source) place(targetSection, source);
    }
    return {
        song: chart.song,
        syncTrack: chart.syncTrack,
        events: chart.events,
        tracks,
    };
}

/**
 * 5-lane-guitar fret/marker → Clone Hero drum lane.
 *
 * audio2chart only emits guitar notes (0-4 frets, plus 5 force / 6 tap / 7
 * open markers). On a drums track the only legal note values are 0 (kick) and
 * 1-4 (the pads), so the frets are shifted onto the pads, open strums become
 * the kick, and the HOPO force/tap markers — meaningless for drums — are
 * dropped. `null` means "drop this note entirely".
 */
const GUITAR_TO_DRUM_LANE: Record<string, string | null> = {
    "0": "1", // green  → red pad
    "1": "2", // red    → yellow pad
    "2": "3", // yellow → blue pad
    "3": "4", // blue   → green pad
    "4": "4", // orange → green pad (5-lane drums are uncommon; collapse onto 4)
    "5": null, // force marker — illegal on drums
    "6": null, // tap marker   — illegal on drums
    "7": "0", // open   → kick
};

/** Translate one [ExpertSingle] event onto a drums track. */
function remapDrumEvent(ev: TrackEvent): TrackEvent[] {
    // Pass non-note events through untouched (S = star power, E = text, etc.).
    if (ev.typeCode !== "N") return [ev];
    const lane = ev.values[0];
    const mapped = lane !== undefined ? GUITAR_TO_DRUM_LANE[lane] : undefined;
    if (mapped === null) return []; // drop force/tap modifiers
    if (mapped === undefined) return [ev]; // unknown lane — leave as-is
    return [{ position: ev.position, typeCode: "N", values: [mapped, ev.values[1] ?? "0"] }];
}

/** Remove exact duplicate drum notes produced by collapsed guitar lanes. */
function dedupeDrumNoteEvents(events: TrackEvent[]): TrackEvent[] {
    const seen = new Set<string>();
    const deduped: TrackEvent[] = [];
    for (const ev of events) {
        if (ev.typeCode !== "N") {
            deduped.push(ev);
            continue;
        }

        const lane = ev.values[0];
        if (lane === undefined) {
            deduped.push(ev);
            continue;
        }

        const key = `${ev.position}\u0000${lane}\u0000${ev.values[1] ?? "0"}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(ev);
    }
    return deduped;
}

/** Coerce a possibly-null/garbage BPM into a usable number, or null. */
function normalizeBpm(bpm: number | null | undefined): number | null {
    if (bpm == null) return null;
    const n = Number(bpm);
    if (!Number.isFinite(n) || n <= 0 || n > 400) return null;
    return n;
}

/** How far (as a fraction) a chart's own tempo may sit from the confirmed BPM and still agree. */
const TEMPO_AGREEMENT = 0.1;

/**
 * Make the SyncTrack agree with the BPM the user confirmed.
 *
 * audio2chart writes notes against its own tempo map: one constant tempo fitted to the
 * confirmed BPM, or (the default) a map that follows the song's tracked beats, with the
 * confirmed BPM choosing the beat octave. Either way the notes' ticks are only correct
 * against *that* map, so a map whose median tempo is within {@link TEMPO_AGREEMENT} of
 * the confirmed BPM is kept as is. Anything else (a service that ignored the BPM) is
 * replaced by a single constant tempo anchored at position 0. Time signature and other
 * sync events are preserved. `.chart` encodes BPM as milli-BPM (BPM × 1000), e.g.
 * 120 BPM → `0 = B 120000`.
 */
export function enforceTempo(chart: Chart, bpm: number): void {
    const hasTimeSig = chart.syncTrack.events.some((e) => e.typeCode === "TS" && e.position === 0);
    const ensureTimeSig = (events: TrackEvent[]): TrackEvent[] =>
        // A chart with a tempo but no time signature is malformed for some
        // parsers; default to 4/4 if the model omitted one.
        hasTimeSig ? events : [{ position: 0, typeCode: "TS", values: ["4"] }, ...events];

    const tempos = chart.syncTrack.events
        .filter((e) => e.typeCode === "B")
        .map((e) => Number(e.values[0]) / 1000)
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((a, b) => a - b);
    const median = tempos[Math.floor(tempos.length / 2)];
    if (median !== undefined && Math.abs(median - bpm) / bpm <= TEMPO_AGREEMENT) {
        chart.syncTrack = {
            name: chart.syncTrack.name,
            events: ensureTimeSig(chart.syncTrack.events),
        };
        return;
    }

    const milliBpm = String(Math.round(bpm * 1000));
    const kept = chart.syncTrack.events.filter((e) => e.typeCode !== "B");
    chart.syncTrack = {
        name: chart.syncTrack.name,
        events: ensureTimeSig([{ position: 0, typeCode: "B", values: [milliBpm] }, ...kept]),
    };
}

async function setTask(task: TaskRecord, status: TaskStatus, progress: number): Promise<void> {
    const fields: Parameters<typeof dbUpdateTask>[1] = { status, progress };
    if (status === "processing" && !task.started_at) {
        fields.started_at = new Date().toISOString();
        task.started_at = fields.started_at;
    }
    if (status === "completed" || status === "failed") {
        fields.completed_at = new Date().toISOString();
    }
    task.status = status;
    await dbUpdateTask(task.task_id, fields);
}
