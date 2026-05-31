/**
 * One-shot client for the deployed Modal-hosted audio2chart service.
 *
 * The live endpoint (see modaltest.ts / modaltest.cjs) is synchronous:
 *   POST <endpoint>  multipart form with field `audio` (+ optional metadata)
 *   200 -> the raw .chart file bytes in the response body
 *
 * This differs from the spawn/poll client in modal.ts (which targets a
 * different deployment shape). The worker and /charts route use THIS client
 * because it matches the URL configured in MODAL_GENERATE_URL.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface Audio2ChartModalOptions {
    /** Deployed http endpoint, e.g. https://...modal.run */
    endpointUrl: string;
    /** Optional shared secret; sent as x-audio2chart-token if provided. */
    token?: string | undefined;

    // ---- generation options forwarded as form fields ----
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

    /** Total request timeout in ms (default 15 min — cold starts are slow). */
    timeoutMs?: number | undefined;
    /** Override fetch for testing. */
    fetchFn?: typeof fetch | undefined;
}

/** Per-call overrides for metadata that varies by stem/instrument. */
export interface GenerateOverrides {
    name?: string | undefined;
    artist?: string | undefined;
    charter?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export class Audio2ChartModal {
    private readonly endpointUrl: string;
    private readonly token: string | undefined;
    private readonly opts: Audio2ChartModalOptions;
    private readonly timeoutMs: number;
    private readonly fetchFn: typeof fetch;

    constructor(options: Audio2ChartModalOptions) {
        if (!options.endpointUrl) {
            throw new Error("Audio2ChartModal requires endpointUrl");
        }
        this.endpointUrl = options.endpointUrl;
        this.token = options.token;
        this.opts = options;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.fetchFn = options.fetchFn ?? fetch;
    }

    /**
     * Generate a .chart from a local audio file and return its text.
     */
    async generateText(audioPath: string, overrides: GenerateOverrides = {}): Promise<string> {
        const resolved = path.resolve(audioPath);
        if (!fs.existsSync(resolved)) {
            throw new Error(`Audio file not found: ${resolved}`);
        }

        const buf = fs.readFileSync(resolved);
        const bytes = new Uint8Array(buf.byteLength);
        bytes.set(buf);
        const blob = new Blob([bytes], { type: "application/octet-stream" });

        const form = new FormData();
        form.append("audio", blob, path.basename(resolved));

        const o = this.opts;
        const name = overrides.name ?? o.name;
        const artist = overrides.artist ?? o.artist;
        const charter = overrides.charter ?? o.charter;
        if (o.modelName !== undefined) form.append("model_name", o.modelName);
        if (o.temperature !== undefined) form.append("temperature", String(o.temperature));
        if (o.topK !== undefined) form.append("top_k", String(o.topK));
        if (o.bpm !== undefined) form.append("bpm", String(o.bpm));
        if (o.resolution !== undefined) form.append("resolution", String(o.resolution));
        if (name !== undefined) form.append("name", name);
        if (artist !== undefined) form.append("artist", artist);
        if (o.album !== undefined) form.append("album", o.album);
        if (o.genre !== undefined) form.append("genre", o.genre);
        if (charter !== undefined) form.append("charter", charter);

        const headers: Record<string, string> = {};
        if (this.token) headers["x-audio2chart-token"] = this.token;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let res: Response;
        try {
            res = await this.fetchFn(this.endpointUrl, {
                method: "POST",
                headers,
                body: form,
                signal: controller.signal,
            });
        } catch (err) {
            if (controller.signal.aborted) {
                throw new Error(`audio2chart request timed out after ${this.timeoutMs}ms`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`audio2chart failed: ${res.status} ${res.statusText} ${body}`.trim());
        }

        const text = await res.text();
        if (!text.includes("[Song]")) {
            throw new Error(
                `audio2chart returned unexpected payload (no [Song] section): ${text.slice(0, 200)}`,
            );
        }
        return text;
    }

    /**
     * Generate a .chart and write it to disk under outputDir.
     */
    async generate(
        audioPath: string,
        outputDir: string,
        overrides: GenerateOverrides = {},
    ): Promise<{ sourcePath: string; chartPath: string; text: string }> {
        const text = await this.generateText(audioPath, overrides);
        fs.mkdirSync(outputDir, { recursive: true });
        const songName =
            overrides.name ??
            this.opts.name ??
            path.basename(audioPath, path.extname(audioPath));
        const chartPath = path.join(outputDir, `${sanitize(songName)}.chart`);
        fs.writeFileSync(chartPath, text, "utf8");
        return { sourcePath: path.resolve(audioPath), chartPath, text };
    }
}

function sanitize(name: string): string {
    return name.replace(/[^a-z0-9_\-. ]/gi, "_").trim() || "song";
}
