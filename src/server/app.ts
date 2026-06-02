/**
 * Express application factory.
 *
 * Builds and wires the full Dolly HTTP app (design-doc v1 routes + the legacy
 * /split and /jobs endpoints) but does NOT bind a port — that is the
 * entrypoint's job (see src/index.ts). Keeping construction separate lets tests
 * spin up the real app on an ephemeral port.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { MulterError } from "multer";
import rateLimit from "express-rate-limit";
import { requireAuth } from "./middleware.js";
import { DummySplitter } from "../split/dummy.js";
import { LalalSplitter } from "../split/lalal.js";
import type { StemSplitter } from "../split.js";
import { CachedSplitter } from "../cache.js";

// Route modules (design-doc API)
import { authRouter } from "./routes/auth.js";
import { filesRouter } from "./routes/files.js";
import { tasksRouter } from "./routes/tasks.js";
import { conversionsRouter } from "./routes/conversions.js";
import { slotsRouter } from "./routes/slots.js";
import { chartsRouter } from "./routes/charts.js";
import { metricsRouter } from "./routes/metrics.js";

// ---------------------------------------------------------------------------
// Legacy job store (kept for backwards compat with /split + /jobs)
// ---------------------------------------------------------------------------

type JobStatus = "pending" | "processing" | "complete" | "error";

interface Job {
    id: string;
    status: JobStatus;
    createdAt: number;
    stems?: { stem: string; path: string }[];
    error?: string;
}

const LEGACY_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const LEGACY_JOB_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

function evictExpiredJobs(jobs: Map<string, Job>, now = Date.now()): void {
    for (const [jobId, job] of jobs) {
        if (now - job.createdAt > LEGACY_JOB_TTL_MS) {
            jobs.delete(jobId);
        }
    }
}

function cleanupUploadedFile(file: Express.Multer.File | undefined): void {
    if (!file) {
        return;
    }
    fs.promises.unlink(file.path).catch(() => {});
}

export interface CreateAppOptions {
    /**
     * Apply the IP rate limiter (default true). Tests that poll aggressively
     * disable it to avoid 429s.
     */
    rateLimit?: boolean;
}

/** Build the Dolly Express app (without listening). */
export function createApp(options: CreateAppOptions = {}): Express {
    const { rateLimit: useRateLimit = true } = options;
    const jobs = new Map<string, Job>();
    const jobCleanupInterval = setInterval(() => evictExpiredJobs(jobs), LEGACY_JOB_CLEANUP_INTERVAL_MS);
    jobCleanupInterval.unref();

    const app = express();
    app.use(express.json());

    // Static frontend
    app.use(express.static(path.resolve("public")));

    // Health — exempt from rate limit (registered before limiter)
    app.get("/health", (_req, res) => {
        res.json({ ok: true });
    });

    // Splitters — exempt from rate limit
    app.get("/splitters", (_req, res) => {
        res.json({
            dummy: new DummySplitter("").supportedStems(),
            lalal: new LalalSplitter({ apiKey: "", outputDir: "" }).supportedStems(),
        });
    });

    // Quality-metrics dashboard + JSON snapshot — operational telemetry, so it
    // is unauthenticated and exempt from rate limiting (registered before the
    // limiter, like /health and /splitters).
    app.use("/metrics", metricsRouter);

    // Rate limiter — applied to all routes registered after this line
    if (useRateLimit) {
        const limiter = rateLimit({
            windowMs: 60 * 1000,
            max: 60,
            standardHeaders: true,
            legacyHeaders: false,
        });
        app.use(limiter);
    }

    // Stricter limiter for the auth endpoints (login/register) to harden
    // against credential stuffing. Disabled together with the general limiter
    // so the e2e test (which registers/logs in repeatedly) isn't throttled.
    const authLimiter = useRateLimit
        ? rateLimit({
              windowMs: 15 * 60 * 1000,
              max: 10,
              standardHeaders: true,
              legacyHeaders: false,
              message: { error: { code: "RATE_LIMITED", message: "Too many auth attempts, please try again later" } },
          })
        : (_req: Request, _res: Response, next: NextFunction) => next();

    // -----------------------------------------------------------------------
    // Design-doc API routes (v1)
    // -----------------------------------------------------------------------

    app.use("/v1/auth", authLimiter, authRouter);
    app.use("/v1/files", filesRouter);
    app.use("/v1/tasks", tasksRouter);
    app.use("/v1/conversions", conversionsRouter);
    app.use("/v1/internal/slots", slotsRouter);
    app.use("/charts", chartsRouter);

    // -----------------------------------------------------------------------
    // Legacy: Multer upload for /split
    // -----------------------------------------------------------------------

    const uploadDir = path.join(os.tmpdir(), "dolly-uploads");
    fs.mkdirSync(uploadDir, { recursive: true });

    const storage = multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadDir),
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, `${crypto.randomUUID()}${ext}`);
        },
    });

    const upload = multer({
        storage,
        fileFilter: (_req, file, cb) => {
            if (file.mimetype.startsWith("audio/") || file.mimetype === "application/octet-stream") {
                cb(null, true);
            } else {
                cb(new Error(`Unsupported MIME type: ${file.mimetype}`));
            }
        },
    });

    const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "./output";

    // POST /split (legacy) — requires auth: it can invoke the paid LALAL
    // splitter and writes uploads to disk.
    app.post("/split", requireAuth, upload.single("audio"), (req, res) => {
        if (!req.file) {
            res.status(400).json({ error: "Missing required field: audio" });
            return;
        }

        const splitterName: string = (req.body.splitter as string | undefined) ?? "dummy";
        if (splitterName !== "dummy" && splitterName !== "lalal") {
            cleanupUploadedFile(req.file);
            res.status(400).json({ error: `Unknown splitter "${splitterName}". Use "dummy" or "lalal".` });
            return;
        }

        const stemsParam: string | undefined = req.body.stems as string | undefined;
        if (!stemsParam) {
            cleanupUploadedFile(req.file);
            res.status(400).json({ error: "Missing required field: stems" });
            return;
        }
        const stems = stemsParam.split(",").map((s) => s.trim()).filter(Boolean);
        if (stems.length === 0) {
            cleanupUploadedFile(req.file);
            res.status(400).json({ error: "stems field must contain at least one stem" });
            return;
        }

        const apiKey: string | undefined =
            (req.body.apiKey as string | undefined) ?? process.env.LALAL_API_KEY;
        if (splitterName === "lalal" && !apiKey) {
            cleanupUploadedFile(req.file);
            res.status(400).json({ error: "lalal splitter requires apiKey field or LALAL_API_KEY env var" });
            return;
        }

        const noCache = (req.body.noCache as string | undefined) === "true";
        const outputDir = OUTPUT_DIR;
        const cacheDir: string =
            (req.body.cacheDir as string | undefined) ?? path.join(outputDir, ".cache");

        evictExpiredJobs(jobs);
        const uploadedPath = req.file.path;
        const jobId = crypto.randomUUID();
        const job: Job = { id: jobId, status: "pending", createdAt: Date.now() };
        jobs.set(jobId, job);

        (async () => {
            job.status = "processing";

            let splitter: StemSplitter;
            if (splitterName === "dummy") {
                splitter = new DummySplitter(outputDir);
            } else {
                splitter = new LalalSplitter({ apiKey: apiKey!, outputDir });
            }

            if (!noCache) {
                fs.mkdirSync(cacheDir, { recursive: true });
                splitter = new CachedSplitter({ inner: splitter, cacheDir });
            }

            fs.mkdirSync(outputDir, { recursive: true });

            try {
                const result = await splitter.split(uploadedPath, stems);
                job.stems = result.stems.map((s) => ({ stem: s.stem, path: path.resolve(s.path) }));
                job.status = "complete";
            } catch (err) {
                job.error = err instanceof Error ? err.message : String(err);
                job.status = "error";
            } finally {
                fs.promises.unlink(uploadedPath).catch(() => {});
            }
        })();

        res.status(202).json({ jobId });
    });

    // GET /jobs/:id (legacy)
    app.get("/jobs/:id", (req, res) => {
        evictExpiredJobs(jobs);
        const job = jobs.get(req.params.id);
        if (!job) {
            res.status(404).json({ error: "Job not found" });
            return;
        }

        res.json({
            id: job.id,
            status: job.status,
            stems: job.stems ?? null,
            error: job.error ?? null,
        });
    });

    // -----------------------------------------------------------------------
    // Global error handler (4-arg). Mounted last so it catches Multer
    // rejections (unsupported MIME, file-too-large) and any thrown/forwarded
    // errors, returning them in the standard {error:{code,message}} envelope
    // instead of Express's default HTML 500.
    // -----------------------------------------------------------------------
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
        // If a response was already started, defer to Express's default handler.
        if (res.headersSent) {
            return _next(err);
        }

        if (err instanceof MulterError) {
            if (err.code === "LIMIT_FILE_SIZE") {
                res.status(413).json({
                    error: { code: "PAYLOAD_TOO_LARGE", message: "Uploaded file exceeds the maximum allowed size" },
                });
                return;
            }
            res.status(400).json({
                error: { code: "BAD_REQUEST", message: err.message },
            });
            return;
        }

        // fileFilter rejections surface as a plain Error (unsupported MIME).
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && /unsupported mime type/i.test(message)) {
            res.status(400).json({
                error: { code: "BAD_REQUEST", message },
            });
            return;
        }

        console.error("[app] Unhandled error:", err);
        res.status(500).json({
            error: { code: "INTERNAL_ERROR", message: "Internal server error" },
        });
    });

    return app;
}
