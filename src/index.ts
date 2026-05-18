import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { DummySplitter } from "./split/dummy.js";
import { LalalSplitter } from "./split/lalal.js";
import type { StemSplitter } from "./split.js";
import { CachedSplitter } from "./cache.js";

// Route modules (design-doc API)
import { authRouter } from "./server/routes/auth.js";
import { filesRouter } from "./server/routes/files.js";
import { tasksRouter } from "./server/routes/tasks.js";
import { conversionsRouter } from "./server/routes/conversions.js";
import { slotsRouter } from "./server/routes/slots.js";
import { chartsRouter } from "./server/routes/charts.js";

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

const jobs = new Map<string, Job>();

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

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

// Rate limiter — applied to all routes registered after this line
const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// ---------------------------------------------------------------------------
// Design-doc API routes (v1)
// ---------------------------------------------------------------------------

app.use("/v1/auth", authRouter);
app.use("/v1/files", filesRouter);
app.use("/v1/tasks", tasksRouter);
app.use("/v1/conversions", conversionsRouter);
app.use("/v1/internal/slots", slotsRouter);
app.use("/charts", chartsRouter);

// ---------------------------------------------------------------------------
// Legacy: Multer upload for /split
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// POST /split  (legacy)
// ---------------------------------------------------------------------------

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? "./output";

app.post("/split", upload.single("audio"), (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: "Missing required field: audio" });
        return;
    }

    const splitterName: string = (req.body.splitter as string | undefined) ?? "dummy";
    if (splitterName !== "dummy" && splitterName !== "lalal") {
        res.status(400).json({ error: `Unknown splitter "${splitterName}". Use "dummy" or "lalal".` });
        return;
    }

    const stemsParam: string | undefined = req.body.stems as string | undefined;
    if (!stemsParam) {
        res.status(400).json({ error: "Missing required field: stems" });
        return;
    }
    const stems = stemsParam.split(",").map(s => s.trim()).filter(Boolean);
    if (stems.length === 0) {
        res.status(400).json({ error: "stems field must contain at least one stem" });
        return;
    }

    const apiKey: string | undefined = (req.body.apiKey as string | undefined) ?? process.env.LALAL_API_KEY;
    if (splitterName === "lalal" && !apiKey) {
        res.status(400).json({ error: "lalal splitter requires apiKey field or LALAL_API_KEY env var" });
        return;
    }

    const noCache = (req.body.noCache as string | undefined) === "true";
    const outputDir = OUTPUT_DIR;
    const cacheDir: string = (req.body.cacheDir as string | undefined) ?? path.join(outputDir, ".cache");

    // Create job
    const jobId = crypto.randomUUID();
    const job: Job = { id: jobId, status: "pending", createdAt: Date.now() };
    jobs.set(jobId, job);

    // Run in background
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
            const result = await splitter.split(req.file!.path, stems);
            job.stems = result.stems.map(s => ({ stem: s.stem, path: path.resolve(s.path) }));
            job.status = "complete";
        } catch (err) {
            job.error = err instanceof Error ? err.message : String(err);
            job.status = "error";
        }
    })();

    res.status(202).json({ jobId });
});

// ---------------------------------------------------------------------------
// GET /jobs/:id  (legacy)
// ---------------------------------------------------------------------------

app.get("/jobs/:id", (req, res) => {
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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
app.listen(PORT, () => {
    console.log(`Dolly API listening on :${PORT}`);
    console.log(`  v1 endpoints: /v1/auth, /v1/files, /v1/tasks, /v1/conversions`);
    console.log(`  legacy:       /split, /jobs/:id`);
});
