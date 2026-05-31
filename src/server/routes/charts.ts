import { Router } from "express";
import multer from "multer";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Audio2ChartModal } from "../../chart/audio2chart.js";
import type { ProgressEvent } from "../../chart/modal.js";

/**
 * Chart generation route backed by the Modal-hosted audio2chart service.
 *
 * Pattern mirrors the legacy /split route in src/index.ts:
 *   POST /charts            multipart audio + JSON opts -> {jobId}
 *   GET  /charts/:id        -> {status, progress, chartUrl|error}
 *   GET  /charts/:id/file   -> the generated .chart file
 *
 * Configuration is read from environment variables on first use:
 *   MODAL_GENERATE_URL    - https://...modal.run/  for http_generate
 *   MODAL_STATUS_URL      - https://...modal.run/  for http_status
 *   AUDIO2CHART_TOKEN     - shared secret matching the modal Secret
 *   CHARTS_OUTPUT_DIR     - where finished .chart files are written
 *                           (default: ./output/charts)
 */

type JobStatus = "pending" | "processing" | "complete" | "error";

interface ChartJob {
    id: string;
    status: JobStatus;
    createdAt: number;
    progress: ProgressEvent | null;
    chartPath: string | null;
    error: string | null;
}

const jobs = new Map<string, ChartJob>();

const uploadDir = path.join(os.tmpdir(), "dolly-chart-uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname) || ".bin";
        cb(null, `${crypto.randomUUID()}${ext}`);
    },
});

const upload = multer({
    storage,
    fileFilter: (_req, file, cb) => {
        if (
            file.mimetype.startsWith("audio/") ||
            file.mimetype === "application/octet-stream"
        ) {
            cb(null, true);
        } else {
            cb(new Error(`Unsupported MIME type: ${file.mimetype}`));
        }
    },
});

export const chartsRouter = Router();

// ── POST /charts ───────────────────────────────────────────────────────────

chartsRouter.post("/", upload.single("audio"), (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: "Missing required field: audio" });
        return;
    }

    const generateUrl =
        process.env.MODAL_GENERATE_URL ??
        "https://melvillevt--audio2chart-generate.modal.run";
    const token = process.env.AUDIO2CHART_TOKEN;

    // Optional opts JSON forwarded to the Modal function.
    let opts: Record<string, unknown> = {};
    const optsRaw = req.body.opts as string | undefined;
    if (optsRaw) {
        try {
            opts = JSON.parse(optsRaw);
        } catch (e) {
            res.status(400).json({
                error: `Invalid 'opts' JSON: ${(e as Error).message}`,
            });
            return;
        }
    }

    const outputDir =
        process.env.CHARTS_OUTPUT_DIR ?? path.resolve("./output/charts");

    const jobId = crypto.randomUUID();
    const job: ChartJob = {
        id: jobId,
        status: "pending",
        createdAt: Date.now(),
        progress: null,
        chartPath: null,
        error: null,
    };
    jobs.set(jobId, job);

    // Run in background — same fire-and-forget pattern as legacy /split.
    (async () => {
        job.status = "processing";
        job.progress = { stage: "generating", step: 0, total: 0 };

        const client = new Audio2ChartModal({
            endpointUrl: generateUrl,
            token,
            modelName: opts.model_name as string | undefined,
            temperature: opts.temperature as number | undefined,
            topK: opts.top_k as number | undefined,
            name: opts.name as string | undefined,
            artist: opts.artist as string | undefined,
            album: opts.album as string | undefined,
            genre: opts.genre as string | undefined,
            charter: opts.charter as string | undefined,
            bpm: opts.bpm as number | undefined,
            resolution: opts.resolution as number | undefined,
        });

        try {
            const result = await client.generate(req.file!.path, outputDir);
            job.chartPath = result.chartPath;
            job.status = "complete";
        } catch (err) {
            job.error = err instanceof Error ? err.message : String(err);
            job.status = "error";
        } finally {
            // Clean up the upload regardless of outcome.
            fs.promises.unlink(req.file!.path).catch(() => {});
        }
    })();

    res.status(202).json({ jobId });
});

// ── GET /charts/:id ────────────────────────────────────────────────────────

chartsRouter.get("/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
    }

    res.json({
        id: job.id,
        status: job.status,
        progress: job.progress,
        chartUrl: job.status === "complete" ? `/charts/${job.id}/file` : null,
        error: job.error,
    });
});

// ── GET /charts/:id/file ───────────────────────────────────────────────────

chartsRouter.get("/:id/file", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
    }
    if (job.status !== "complete" || !job.chartPath) {
        res.status(409).json({ error: `Job not complete (status=${job.status})` });
        return;
    }
    res.download(job.chartPath, path.basename(job.chartPath));
});
