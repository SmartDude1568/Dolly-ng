import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Client for the Modal-hosted audio2chart service (modal/audio2chart_app.py).
 *
 * Implements the same generate(audioPath) shape as the local Audio2Chart class
 * in src/chart.ts, so the rest of the app can swap backends transparently.
 */

export interface ModalAudio2ChartOptions {
    /** URL of the deployed http_generate endpoint. */
    generateUrl: string;
    /** URL of the deployed http_status endpoint. */
    statusUrl: string;
    /** Shared secret matching AUDIO2CHART_TOKEN in the Modal secret. */
    token: string;
    /** Where to write the resulting .chart file. */
    outputDir: string;

    // ---- generation options forwarded as JSON in the `opts` field ----
    modelName?: string | undefined;
    temperature?: number | undefined;
    topK?: number | undefined;
    name?: string | undefined;
    artist?: string | undefined;
    album?: string | undefined;
    genre?: string | undefined;
    charter?: string | undefined;
    bpm?: number | undefined;
    resolution?: number | undefined;

    /** Polling interval in ms (default 2000). */
    pollIntervalMs?: number | undefined;
    /** Hard cap on total polling time in ms (default 30 min). */
    timeoutMs?: number | undefined;
    /** Optional progress callback. */
    onProgress?: ProgressCallback | undefined;
    /** Override fetch for testing. */
    fetchFn?: typeof fetch | undefined;
}

export interface ProgressEvent {
    stage: string;
    step: number;
    total: number;
}

export type ProgressCallback = (event: ProgressEvent) => void;

export interface ChartResult {
    sourcePath: string;
    chartPath: string;
}

interface SpawnResponse {
    call_id: string;
    modal_call_id: string;
}

interface StatusResponse {
    status: "running" | "done" | "error";
    progress?: ProgressEvent;
    chart?: string;
    error?: string;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class ModalAudio2Chart {
    private readonly generateUrl: string;
    private readonly statusUrl: string;
    private readonly token: string;
    private readonly outputDir: string;
    private readonly opts: Record<string, unknown>;
    private readonly pollIntervalMs: number;
    private readonly timeoutMs: number;
    private readonly onProgress: ProgressCallback | undefined;
    private readonly fetchFn: typeof fetch;

    constructor(options: ModalAudio2ChartOptions) {
        this.generateUrl = options.generateUrl;
        this.statusUrl = options.statusUrl;
        this.token = options.token;
        this.outputDir = path.resolve(options.outputDir);
        this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.onProgress = options.onProgress;
        this.fetchFn = options.fetchFn ?? fetch;

        // Build the opts payload sent to Modal as JSON. Only include defined keys
        // so Modal-side defaults take effect for the rest.
        const opts: Record<string, unknown> = {};
        if (options.modelName !== undefined) opts.model_name = options.modelName;
        if (options.temperature !== undefined) opts.temperature = options.temperature;
        if (options.topK !== undefined) opts.top_k = options.topK;
        if (options.name !== undefined) opts.name = options.name;
        if (options.artist !== undefined) opts.artist = options.artist;
        if (options.album !== undefined) opts.album = options.album;
        if (options.genre !== undefined) opts.genre = options.genre;
        if (options.charter !== undefined) opts.charter = options.charter;
        if (options.bpm !== undefined) opts.bpm = options.bpm;
        if (options.resolution !== undefined) opts.resolution = options.resolution;
        this.opts = opts;
    }

    /** Generate a .chart file from a local audio file via the Modal service. */
    async generate(audioPath: string): Promise<ChartResult> {
        const resolvedAudioPath = path.resolve(audioPath);
        if (!fs.existsSync(resolvedAudioPath)) {
            throw new Error(`Audio file not found: ${resolvedAudioPath}`);
        }

        const { call_id, modal_call_id } = await this.spawn(resolvedAudioPath);
        const chartText = await this.poll(call_id, modal_call_id);

        fs.mkdirSync(this.outputDir, { recursive: true });
        const songName =
            (this.opts.name as string | undefined) ??
            path.basename(resolvedAudioPath, path.extname(resolvedAudioPath));
        const chartPath = path.join(this.outputDir, `${songName}.chart`);
        fs.writeFileSync(chartPath, chartText, "utf8");

        return { sourcePath: resolvedAudioPath, chartPath };
    }

    /** POST audio + opts to the Modal http_generate endpoint. */
    private async spawn(audioPath: string): Promise<SpawnResponse> {
        const audioBuf = fs.readFileSync(audioPath);
        const filename = path.basename(audioPath);

        // Use the WHATWG FormData/Blob API (available in Node 18+).
        // Copy into a fresh Uint8Array to detach from Node's Buffer pool.
        const bytes = new Uint8Array(audioBuf.byteLength);
        bytes.set(audioBuf);
        const blob = new Blob([bytes], { type: "application/octet-stream" });

        const form = new FormData();
        form.append("file", blob, filename);
        form.append("opts", JSON.stringify(this.opts));

        const res = await this.fetchFn(this.generateUrl, {
            method: "POST",
            headers: { "x-audio2chart-token": this.token },
            body: form,
        });

        if (!res.ok) {
            const body = await safeText(res);
            throw new Error(
                `Modal http_generate failed: ${res.status} ${res.statusText} ${body}`,
            );
        }

        const data = (await res.json()) as SpawnResponse;
        if (!data.call_id || !data.modal_call_id) {
            throw new Error(
                `Modal http_generate returned unexpected payload: ${JSON.stringify(data)}`,
            );
        }
        return data;
    }

    /** Poll http_status until the job finishes, errors, or times out. */
    private async poll(call_id: string, modal_call_id: string): Promise<string> {
        const start = Date.now();
        const url = `${this.statusUrl}?call_id=${encodeURIComponent(call_id)}&modal_call_id=${encodeURIComponent(modal_call_id)}`;

        while (true) {
            if (Date.now() - start > this.timeoutMs) {
                throw new Error(
                    `Modal generation timed out after ${this.timeoutMs}ms (call_id=${call_id})`,
                );
            }

            const res = await this.fetchFn(url, {
                method: "GET",
                headers: { "x-audio2chart-token": this.token },
            });

            if (!res.ok && res.status !== 410) {
                const body = await safeText(res);
                throw new Error(
                    `Modal http_status failed: ${res.status} ${res.statusText} ${body}`,
                );
            }

            const data = (await res.json()) as StatusResponse;

            if (data.progress && this.onProgress) {
                this.onProgress(data.progress);
            }

            if (data.status === "done") {
                if (typeof data.chart !== "string") {
                    throw new Error("Modal http_status reported done but no chart text");
                }
                return data.chart;
            }
            if (data.status === "error") {
                throw new Error(`Modal generation failed: ${data.error ?? "unknown error"}`);
            }

            await sleep(this.pollIntervalMs);
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(res: Response): Promise<string> {
    try {
        return await res.text();
    } catch {
        return "";
    }
}
