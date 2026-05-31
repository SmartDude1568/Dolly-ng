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
import { parseChart, type Chart, type ChartSection } from "../chart/parse.js";
import { writeChart } from "../chart/write.js";
import { mergeCharts } from "../chart/merge.js";
import { packSng, type SngEntry } from "../sng.js";
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

const INSTRUMENT_MAP: Record<string, InstrumentMapEntry> = {
    guitar: { stem: "electric_guitar", section: "Single", chName: "guitar" },
    bass: { stem: "bass", section: "DoubleBass", chName: "bass" },
    drums: { stem: "drum", section: "Drums", chName: "drums" },
    drum: { stem: "drum", section: "Drums", chName: "drums" },
    keys: { stem: "piano", section: "Keyboard", chName: "keys" },
    keyboard: { stem: "piano", section: "Keyboard", chName: "keys" },
    piano: { stem: "piano", section: "Keyboard", chName: "keys" },
    vocals: { stem: "vocals", section: "Single", chName: "vocals" },
};

const DIFFICULTY_PREFIX: Record<string, string> = {
    expert: "Expert",
    hard: "Hard",
    medium: "Medium",
    easy: "Easy",
};

function normalizeInstrument(name: string): InstrumentMapEntry {
    const key = name.trim().toLowerCase();
    return INSTRUMENT_MAP[key] ?? { stem: "electric_guitar", section: "Single", chName: key || "guitar" };
}

function sanitize(name: string): string {
    return name.replace(/[^a-z0-9_\-. ]/gi, "_").trim() || "song";
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

export interface RunConversionArgs {
    conversion: ConversionRecord;
    tasks: TaskRecord[];
    inputFile: FileRecord;
    instruments: string[];
    difficulty: string;
}

/** Fire-and-forget entry point — never throws to the caller. */
export function startConversion(args: RunConversionArgs): void {
    runConversion(args).catch((err) => {
        console.error(
            `[worker] conversion ${args.conversion.conversion_id} crashed:`,
            err instanceof Error ? err.stack ?? err.message : err,
        );
    });
}

export async function runConversion(args: RunConversionArgs): Promise<void> {
    const { conversion, tasks, inputFile, instruments, difficulty } = args;
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

            const apiKey = process.env.LALAL_API_KEY;
            if (!apiKey) throw new Error("LALAL_API_KEY is not configured");

            const splitter = new LalalSplitter({ apiKey, outputDir: workDir });
            const splitResult = await splitter.split(inputFile.local_path, wantedStems);
            stemPathByStem = new Map(splitResult.stems.map((s) => [s.stem, s.path]));
            log(`stems ready: ${splitResult.stems.map((s) => s.stem).join(", ")}`);
            await setTask(splitTask, "completed", 100);
        }

        // ── 2. audio2chart per instrument ────────────────────────────────
        const modal = new Audio2ChartModal({
            endpointUrl: MODAL_URL,
            token: process.env.AUDIO2CHART_TOKEN,
            artist: "Dolly",
            charter: "Dolly",
        });
        const diffPrefix = DIFFICULTY_PREFIX[difficulty.toLowerCase()] ?? "Expert";
        const perInstrumentCharts: Chart[] = [];

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
                text = await modal.generateText(stemPath, {
                    name: `${songTitle} (${instrument})`,
                });
                fs.writeFileSync(chartCachePath, text, "utf8");

                if (task) await setTask(task, "completed", 100);
            }

            const chart = parseChart(text);
            perInstrumentCharts.push(remapChartTracks(chart, `${diffPrefix}${entry.section}`));
        }

        if (perInstrumentCharts.length === 0) {
            throw new Error("no instrument charts were generated");
        }

        // ── 3. merge ─────────────────────────────────────────────────────
        const merged =
            perInstrumentCharts.length === 1
                ? perInstrumentCharts[0]!
                : mergeCharts(perInstrumentCharts, { conflictStrategy: "last-wins" });

        merged.song.Name = songTitle;
        merged.song.Artist = "Dolly";
        merged.song.Charter = "Dolly (audio2chart)";
        merged.song.MusicStream = "song.opus";

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

        const seenStemAudio = new Set<string>();
        for (const entry of instrEntries) {
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
        // song.ini file is needed inside the archive.
        const diffValue = String({ Expert: 5, Hard: 4, Medium: 3, Easy: 1 }[diffPrefix] ?? 5);
        const has = (name: string) => instruments.some((x) => x.toLowerCase() === name);
        const sngBuf = packSng(entries, {
            name: songTitle,
            artist: "Dolly",
            album: "audio2chart",
            genre: "Rock",
            charter: "Dolly (audio2chart)",
            diff_guitar: has("guitar") ? diffValue : "-1",
            diff_bass: has("bass") ? diffValue : "-1",
            diff_drums: has("drums") || has("drum") ? diffValue : "-1",
            diff_keys: has("keys") || has("keyboard") || has("piano") ? diffValue : "-1",
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
            local_path: sngPath,
            created_at: new Date().toISOString(),
        };
        await dbInsertFile(fileRec);
        await dbUpdateTask(uploadTask.task_id, { output_file_id: fileRec.file_id });
        await setTask(uploadTask, "completed", 100);

        await dbUpdateConversionStatus(convId, "completed");
        log("conversion completed");
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[worker ${convId}] failed: ${message}`);
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

/**
 * Rebuild a chart so every instrument track is renamed to `targetSection`.
 * audio2chart always emits a single [ExpertSingle] track; this places it on
 * the correct Clone Hero instrument/difficulty.
 */
function remapChartTracks(chart: Chart, targetSection: string): Chart {
    const tracks = new Map<string, ChartSection>();
    // Prefer an ExpertSingle source; otherwise take the first available track.
    const source =
        chart.tracks.get("ExpertSingle") ?? [...chart.tracks.values()][0];
    if (source) {
        tracks.set(targetSection, { name: targetSection, events: source.events });
    }
    return {
        song: chart.song,
        syncTrack: chart.syncTrack,
        events: chart.events,
        tracks,
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
