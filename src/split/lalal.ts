import * as fs from "node:fs";
import * as path from "node:path";
import type { StemSplitter, SplitResult } from "../split.js";

export type LalalStem =
    | "vocals"
    | "voice"
    | "drum"
    | "bass"
    | "piano"
    | "electric_guitar"
    | "acoustic_guitar"
    | "synthesizer"
    | "strings"
    | "wind";

const SUPPORTED_STEMS: LalalStem[] = [
    "vocals",
    "voice",
    "drum",
    "bass",
    "piano",
    "electric_guitar",
    "acoustic_guitar",
    "synthesizer",
    "strings",
    "wind",
];

const LALAL_API_BASE = "https://www.lalal.ai";

// ── Internal API response types ─────────────────────────────────────────────

interface UploadResponse {
    status: "success" | "error";
    id?: string;
    error?: string;
}

interface SplitResponse {
    status: "success" | "error";
    error?: string;
}

interface FileCheckResult {
    status: "success" | "error";
    split?: {
        stem: string;
        stem_track: string;
        stem_track_size: number;
        back_track: string;
        back_track_size: number;
    };
    task?: {
        state: "success" | "error" | "progress" | "cancelled";
        error?: string;
        progress?: number;
    };
    error?: string;
}

interface CheckResponse {
    status: "success" | "error";
    result?: Record<string, FileCheckResult>;
    error?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function uploadFile(filePath: string, apiKey: string): Promise<string> {
    const fileName = path.basename(filePath);
    const fileStream = fs.createReadStream(filePath);

    const response = await fetch(`${LALAL_API_BASE}/api/upload/`, {
        method: "POST",
        headers: {
            "Authorization": `license ${apiKey}`,
            "Content-Disposition": `attachment; filename="${fileName}"`,
            "Content-Type": "application/octet-stream",
        },
        body: fileStream,
        duplex: "half",
    } as RequestInit);

    if (!response.ok) {
        throw new Error(`LALAL upload failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as UploadResponse;
    if (data.status === "error") {
        throw new Error(`LALAL upload error: ${data.error ?? "Unknown error"}`);
    }
    if (!data.id) {
        throw new Error("LALAL upload succeeded but no file ID was returned");
    }

    return data.id;
}

async function requestSplit(fileId: string, stem: LalalStem, apiKey: string): Promise<void> {
    const params = JSON.stringify([{ id: fileId, stem }]);
    const body = new URLSearchParams();
    body.append("params", params);

    const response = await fetch(`${LALAL_API_BASE}/api/split/`, {
        method: "POST",
        headers: {
            "Authorization": `license ${apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
    });

    if (!response.ok) {
        throw new Error(`LALAL split request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as SplitResponse;
    if (data.status === "error") {
        throw new Error(`LALAL split error: ${data.error ?? "Unknown error"}`);
    }
}

async function checkStatus(fileId: string, apiKey: string): Promise<FileCheckResult> {
    const body = new URLSearchParams();
    body.append("id", fileId);

    const response = await fetch(`${LALAL_API_BASE}/api/check/`, {
        method: "POST",
        headers: {
            "Authorization": `license ${apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
    });

    if (!response.ok) {
        throw new Error(`LALAL status check failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as CheckResponse;
    if (data.status === "error") {
        throw new Error(`LALAL status check error: ${data.error ?? "Unknown error"}`);
    }
    if (!data.result) {
        throw new Error("LALAL status check returned no result data");
    }

    const fileResult = data.result[fileId];
    if (!fileResult) {
        throw new Error(`No result found for file ID: ${fileId}`);
    }
    if (fileResult.status === "error") {
        throw new Error(`LALAL file error: ${fileResult.error ?? "Unknown error"}`);
    }

    return fileResult;
}

async function pollUntilComplete(
    fileId: string,
    apiKey: string,
    pollIntervalMs: number,
): Promise<string> {
    while (true) {
        const result = await checkStatus(fileId, apiKey);

        if (result.split) {
            return result.split.stem_track;
        }

        if (result.task) {
            if (result.task.state === "error") {
                throw new Error(`LALAL processing failed: ${result.task.error ?? "Unknown error"}`);
            }
            if (result.task.state === "cancelled") {
                throw new Error("LALAL processing was cancelled");
            }
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
}

async function downloadFile(url: string, destPath: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to download stem: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(destPath, buffer);
}

// ── Implementation ──────────────────────────────────────────────────────────

export interface LalalSplitterOptions {
    apiKey: string;
    outputDir: string;
    /** Milliseconds between status polls. Defaults to 3000. */
    pollIntervalMs?: number;
}

export class LalalSplitter implements StemSplitter<LalalStem> {
    readonly name = "lalal";
    private apiKey: string;
    private outputDir: string;
    private pollIntervalMs: number;

    constructor(options: LalalSplitterOptions) {
        this.apiKey = options.apiKey;
        this.outputDir = options.outputDir;
        this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    }

    supportedStems(): LalalStem[] {
        return SUPPORTED_STEMS;
    }

    async split(audioPath: string, stems: LalalStem[]): Promise<SplitResult<LalalStem>> {
        const unsupported = stems.filter(s => !SUPPORTED_STEMS.includes(s));
        if (unsupported.length > 0) {
            throw new Error(`Unsupported LALAL stems: ${unsupported.join(", ")}`);
        }

        const fileId = await uploadFile(audioPath, this.apiKey);
        const baseName = path.basename(audioPath, path.extname(audioPath));

        const results: SplitResult<LalalStem> = {
            sourcePath: audioPath,
            stems: [],
        };

        for (const stem of stems) {
            await requestSplit(fileId, stem, this.apiKey);
            const stemUrl = await pollUntilComplete(fileId, this.apiKey, this.pollIntervalMs);

            const destPath = path.join(this.outputDir, `${baseName}_${stem}.wav`);
            await downloadFile(stemUrl, destPath);

            results.stems.push({ stem, path: destPath });
        }

        return results;
    }
}
