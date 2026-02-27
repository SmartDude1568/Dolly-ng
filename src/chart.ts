import * as fs from "node:fs";
import * as path from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import type { ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

const defaultExecFileAsync = promisify(nodeExecFile);

/** Async execFile signature for dependency injection. */
export type ExecFileFn = (
    file: string,
    args: readonly string[],
    options?: ExecFileOptions,
) => Promise<{ stdout: string; stderr: string }>;

const REPO_URL = "https://github.com/3podi/audio2chart.git";
const REPO_DIR_NAME = "audio2chart";
const VENV_DIR_NAME = "audio2chart-venv";
const MARKER_FILE = "setup-complete.marker";
const EXEC_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface Audio2ChartOptions {
    vendorDir: string;
    outputDir: string;
    modelName?: string | undefined;
    temperature?: number | undefined;
    topK?: number | undefined;
    name?: string | undefined;
    artist?: string | undefined;
    album?: string | undefined;
    genre?: string | undefined;
    charter?: string | undefined;
    /** Override execFile for testing. */
    execFile?: ExecFileFn;
}

export interface ChartResult {
    sourcePath: string;
    chartPath: string;
}

export class Audio2Chart {
    private readonly vendorDir: string;
    private readonly outputDir: string;
    private readonly modelName?: string | undefined;
    private readonly temperature?: number | undefined;
    private readonly topK?: number | undefined;
    private readonly name?: string | undefined;
    private readonly artist?: string | undefined;
    private readonly album?: string | undefined;
    private readonly genre?: string | undefined;
    private readonly charter?: string | undefined;
    private readonly execFileAsync: ExecFileFn;
    private setupDone = false;

    constructor(options: Audio2ChartOptions) {
        this.vendorDir = path.resolve(options.vendorDir);
        this.outputDir = path.resolve(options.outputDir);
        this.modelName = options.modelName;
        this.temperature = options.temperature;
        this.topK = options.topK;
        this.name = options.name;
        this.artist = options.artist;
        this.album = options.album;
        this.genre = options.genre;
        this.charter = options.charter;
        this.execFileAsync = options.execFile ?? defaultExecFileAsync;
    }

    private get repoDir(): string {
        return path.join(this.vendorDir, REPO_DIR_NAME);
    }

    private get venvDir(): string {
        return path.join(this.vendorDir, VENV_DIR_NAME);
    }

    private get markerPath(): string {
        return path.join(this.venvDir, MARKER_FILE);
    }

    /** Returns the path to the venv Python binary (platform-dependent). */
    getPythonPath(): string {
        if (process.platform === "win32") {
            return path.join(this.venvDir, "Scripts", "python.exe");
        }
        return path.join(this.venvDir, "bin", "python");
    }

    /** Clone the audio2chart repo if it doesn't already exist. */
    async ensureRepo(): Promise<void> {
        const generatePy = path.join(this.repoDir, "generate.py");
        if (fs.existsSync(generatePy)) {
            return;
        }

        fs.mkdirSync(this.vendorDir, { recursive: true });

        try {
            await this.execFileAsync("git", ["clone", REPO_URL, this.repoDir], {
                timeout: EXEC_TIMEOUT_MS,
            });
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes("ENOENT")) {
                throw new Error(
                    "git is not installed or not in PATH. Please install git and try again.",
                );
            }
            throw new Error(`Failed to clone audio2chart repository: ${msg}`);
        }
    }

    /** Resolve the system Python command (tries python3 first, then python). */
    private async findSystemPython(): Promise<string> {
        for (const cmd of ["python3", "python"]) {
            try {
                await this.execFileAsync(cmd, ["--version"], { timeout: 10_000 });
                return cmd;
            } catch {
                // try next
            }
        }
        throw new Error(
            "Python is not installed or not in PATH. Please install Python 3 and try again.",
        );
    }

    /** Create the venv and install requirements if not already done. */
    async ensureVenv(): Promise<void> {
        if (fs.existsSync(this.markerPath)) {
            return;
        }

        const pythonCmd = await this.findSystemPython();

        // Create venv
        await this.execFileAsync(pythonCmd, ["-m", "venv", this.venvDir], {
            timeout: EXEC_TIMEOUT_MS,
        });

        // Install requirements
        const venvPython = this.getPythonPath();
        const requirementsPath = path.join(this.repoDir, "requirements.txt");

        await this.execFileAsync(
            venvPython,
            ["-m", "pip", "install", "-r", requirementsPath],
            { cwd: this.repoDir, timeout: EXEC_TIMEOUT_MS },
        );

        // Write marker file on success
        fs.writeFileSync(this.markerPath, new Date().toISOString());
    }

    /** Build the argument list for generate.py. */
    buildArgs(audioPath: string): string[] {
        const generatePy = path.join(this.repoDir, "generate.py");
        const args = [generatePy, audioPath, "--output", this.outputDir];

        if (this.modelName !== undefined) {
            args.push("--model-name", this.modelName);
        }
        if (this.temperature !== undefined) {
            args.push("--temperature", String(this.temperature));
        }
        if (this.topK !== undefined) {
            args.push("--top-k", String(this.topK));
        }
        if (this.name !== undefined) {
            args.push("--name", this.name);
        }
        if (this.artist !== undefined) {
            args.push("--artist", this.artist);
        }
        if (this.album !== undefined) {
            args.push("--album", this.album);
        }
        if (this.genre !== undefined) {
            args.push("--genre", this.genre);
        }
        if (this.charter !== undefined) {
            args.push("--charter", this.charter);
        }

        return args;
    }

    /** Generate a .chart file from an audio file. */
    async generate(audioPath: string): Promise<ChartResult> {
        const resolvedAudioPath = path.resolve(audioPath);

        if (!fs.existsSync(resolvedAudioPath)) {
            throw new Error(`Audio file not found: ${resolvedAudioPath}`);
        }

        if (!this.setupDone) {
            await this.ensureRepo();
            await this.ensureVenv();
            this.setupDone = true;
        }

        const venvPython = this.getPythonPath();
        const args = this.buildArgs(resolvedAudioPath);

        try {
            await this.execFileAsync(venvPython, args, {
                cwd: this.repoDir,
                timeout: EXEC_TIMEOUT_MS,
            });
        } catch (error) {
            const stderr =
                error && typeof error === "object" && "stderr" in error
                    ? (error as { stderr: string }).stderr
                    : "";
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(
                `generate.py failed: ${stderr || msg}`,
            );
        }

        // Find the .chart file in the output directory
        fs.mkdirSync(this.outputDir, { recursive: true });
        const files = fs.readdirSync(this.outputDir);
        const chartFile = files.find((f) => f.endsWith(".chart"));

        if (!chartFile) {
            throw new Error(
                `No .chart file found in output directory ${this.outputDir} after running generate.py`,
            );
        }

        return {
            sourcePath: resolvedAudioPath,
            chartPath: path.join(this.outputDir, chartFile),
        };
    }
}
