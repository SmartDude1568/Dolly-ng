import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";
import { fileURLToPath } from "node:url";
import { Audio2Chart, type ExecFileFn } from "../src/chart";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "fixtures", "chart");
const VENDOR_DIR = path.join(TEST_DIR, "vendor");
const OUTPUT_DIR = path.join(TEST_DIR, "output");

// ── Mock execFile helper ──────────────────────────────────────────────────

interface ExecCall {
    file: string;
    args: readonly string[];
}

function createMockExec(
    handler: (call: ExecCall) => { stdout?: string; stderr?: string; error?: Error },
): { execFile: ExecFileFn; calls: ExecCall[] } {
    const calls: ExecCall[] = [];
    const execFile: ExecFileFn = async (file, args) => {
        const call = { file, args };
        calls.push(call);
        const result = handler(call);
        if (result.error) {
            throw result.error;
        }
        return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    };
    return { execFile, calls };
}

// ── Test runner ─────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
    console.log("Setting up chart test fixtures...\n");
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(VENDOR_DIR, { recursive: true });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const DUMMY_AUDIO = path.join(TEST_DIR, "input.wav");
    fs.writeFileSync(DUMMY_AUDIO, "fake-wav-content");

    let passed = 0;
    let failed = 0;

    async function test(name: string, fn: () => Promise<void>): Promise<void> {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (error) {
            console.log(`✗ ${name}`);
            console.log(`    Error: ${error instanceof Error ? error.message : error}`);
            failed++;
        }
    }

    // ── getPythonPath tests ────────────────────────────────────────────

    console.log("getPythonPath");

    await test("should return correct python path for current platform", async () => {
        const chart = new Audio2Chart({ vendorDir: VENDOR_DIR, outputDir: OUTPUT_DIR });
        const pythonPath = chart.getPythonPath();
        if (process.platform === "win32") {
            assert.ok(pythonPath.includes("Scripts" + path.sep + "python.exe"),
                `Expected Scripts/python.exe in path, got: ${pythonPath}`);
        } else {
            assert.ok(pythonPath.includes("bin" + path.sep + "python"),
                `Expected bin/python in path, got: ${pythonPath}`);
        }
    });

    // ── buildArgs tests ─────────────────────────────────────────────────

    console.log("\nbuildArgs");

    await test("should include all provided options", async () => {
        const chart = new Audio2Chart({
            vendorDir: VENDOR_DIR,
            outputDir: OUTPUT_DIR,
            modelName: "my-model",
            temperature: 0.8,
            topK: 50,
            name: "Test Song",
            artist: "Test Artist",
            album: "Test Album",
            genre: "Rock",
            charter: "TestCharter",
        });
        const args = chart.buildArgs("/audio/song.wav");

        assert.ok(args.includes("--model-name"), "Should include --model-name");
        assert.ok(args.includes("my-model"), "Should include model value");
        assert.ok(args.includes("--temperature"), "Should include --temperature");
        assert.ok(args.includes("0.8"), "Should include temperature value");
        assert.ok(args.includes("--top-k"), "Should include --top-k");
        assert.ok(args.includes("50"), "Should include top-k value");
        assert.ok(args.includes("--name"), "Should include --name");
        assert.ok(args.includes("Test Song"), "Should include name value");
        assert.ok(args.includes("--artist"), "Should include --artist");
        assert.ok(args.includes("Test Artist"), "Should include artist value");
        assert.ok(args.includes("--album"), "Should include --album");
        assert.ok(args.includes("Test Album"), "Should include album value");
        assert.ok(args.includes("--genre"), "Should include --genre");
        assert.ok(args.includes("Rock"), "Should include genre value");
        assert.ok(args.includes("--charter"), "Should include --charter");
        assert.ok(args.includes("TestCharter"), "Should include charter value");
    });

    await test("should omit undefined options", async () => {
        const chart = new Audio2Chart({
            vendorDir: VENDOR_DIR,
            outputDir: OUTPUT_DIR,
        });
        const args = chart.buildArgs("/audio/song.wav");

        assert.ok(!args.includes("--model-name"), "Should not include --model-name");
        assert.ok(!args.includes("--temperature"), "Should not include --temperature");
        assert.ok(!args.includes("--top-k"), "Should not include --top-k");
        assert.ok(!args.includes("--name"), "Should not include --name");
        assert.ok(!args.includes("--artist"), "Should not include --artist");
        assert.ok(!args.includes("--album"), "Should not include --album");
        assert.ok(!args.includes("--genre"), "Should not include --genre");
        assert.ok(!args.includes("--charter"), "Should not include --charter");

        // Should still have generate.py, audioPath, --output, outputDir
        assert.ok(args.some(a => a.endsWith("generate.py")), "Should include generate.py");
        assert.ok(args.includes("/audio/song.wav"), "Should include audio path");
        assert.ok(args.includes("--output"), "Should include --output");
    });

    // ── ensureRepo tests ────────────────────────────────────────────────

    console.log("\nensureRepo");

    await test("should call git clone when repo is missing", async () => {
        const tempVendor = path.join(TEST_DIR, "vendor-clone-test");
        fs.mkdirSync(tempVendor, { recursive: true });

        const { execFile, calls } = createMockExec((call) => {
            if (call.file === "git") {
                // Simulate clone by creating the directory with generate.py
                const cloneIdx = call.args.indexOf("clone");
                const repoDir = call.args[cloneIdx + 2]!;
                fs.mkdirSync(repoDir as string, { recursive: true });
                fs.writeFileSync(path.join(repoDir as string, "generate.py"), "# fake");
            }
            return { stdout: "" };
        });

        const chart = new Audio2Chart({ vendorDir: tempVendor, outputDir: OUTPUT_DIR, execFile });

        try {
            await chart.ensureRepo();

            assert.strictEqual(calls.length, 1, "Should have called execFile once");
            assert.strictEqual(calls[0]!.file, "git", "Should call git");
            assert.ok(calls[0]!.args.includes("clone"), "Should include 'clone' argument");
        } finally {
            fs.rmSync(tempVendor, { recursive: true, force: true });
        }
    });

    await test("should skip clone when generate.py already exists", async () => {
        const tempVendor = path.join(TEST_DIR, "vendor-skip-test");
        const repoDir = path.join(tempVendor, "audio2chart");
        fs.mkdirSync(repoDir, { recursive: true });
        fs.writeFileSync(path.join(repoDir, "generate.py"), "# already here");

        const { execFile, calls } = createMockExec(() => {
            throw new Error("Should not have called execFile");
        });

        const chart = new Audio2Chart({ vendorDir: tempVendor, outputDir: OUTPUT_DIR, execFile });

        try {
            await chart.ensureRepo();
            assert.strictEqual(calls.length, 0, "Should not call execFile");
        } finally {
            fs.rmSync(tempVendor, { recursive: true, force: true });
        }
    });

    // ── ensureVenv tests ────────────────────────────────────────────────

    console.log("\nensureVenv");

    await test("should create venv and install requirements", async () => {
        const tempVendor = path.join(TEST_DIR, "vendor-venv-test");
        const repoDir = path.join(tempVendor, "audio2chart");
        fs.mkdirSync(repoDir, { recursive: true });
        fs.writeFileSync(path.join(repoDir, "requirements.txt"), "torch\n");

        let callIndex = 0;
        const { execFile, calls } = createMockExec((call) => {
            callIndex++;
            if (callIndex === 1) {
                // python3 --version
                return { stdout: "Python 3.11.0" };
            }
            if (callIndex === 2) {
                // python -m venv — create the venv dir so marker can be written
                const venvDir = call.args[call.args.length - 1]!;
                fs.mkdirSync(venvDir as string, { recursive: true });
                return { stdout: "" };
            }
            // pip install
            return { stdout: "" };
        });

        const chart = new Audio2Chart({ vendorDir: tempVendor, outputDir: OUTPUT_DIR, execFile });

        try {
            await chart.ensureVenv();

            assert.ok(calls.length >= 3, `Expected at least 3 calls, got ${calls.length}`);
            // Verify marker file was written
            const markerPath = path.join(tempVendor, "audio2chart-venv", "setup-complete.marker");
            assert.ok(fs.existsSync(markerPath), "Marker file should be created");
        } finally {
            fs.rmSync(tempVendor, { recursive: true, force: true });
        }
    });

    await test("should skip venv setup when marker file exists", async () => {
        const tempVendor = path.join(TEST_DIR, "vendor-marker-test");
        const venvDir = path.join(tempVendor, "audio2chart-venv");
        fs.mkdirSync(venvDir, { recursive: true });
        fs.writeFileSync(path.join(venvDir, "setup-complete.marker"), "done");

        const { execFile, calls } = createMockExec(() => {
            throw new Error("Should not have called execFile");
        });

        const chart = new Audio2Chart({ vendorDir: tempVendor, outputDir: OUTPUT_DIR, execFile });

        try {
            await chart.ensureVenv();
            assert.strictEqual(calls.length, 0, "Should not call execFile");
        } finally {
            fs.rmSync(tempVendor, { recursive: true, force: true });
        }
    });

    // ── generate tests ──────────────────────────────────────────────────

    console.log("\ngenerate");

    await test("should orchestrate setup + execution and return ChartResult", async () => {
        const tempVendor = path.join(TEST_DIR, "vendor-gen-test");
        const tempOutput = path.join(TEST_DIR, "output-gen-test");
        const repoDir = path.join(tempVendor, "audio2chart");
        const venvDir = path.join(tempVendor, "audio2chart-venv");

        // Pre-create repo and marker so setup is skipped
        fs.mkdirSync(repoDir, { recursive: true });
        fs.writeFileSync(path.join(repoDir, "generate.py"), "# fake");
        fs.mkdirSync(venvDir, { recursive: true });
        fs.writeFileSync(path.join(venvDir, "setup-complete.marker"), "done");
        fs.mkdirSync(tempOutput, { recursive: true });

        const { execFile } = createMockExec(() => {
            // Simulate generate.py creating a .chart file
            fs.writeFileSync(path.join(tempOutput, "input.chart"), "[Song]\nName=Test");
            return { stdout: "Done" };
        });

        const chart = new Audio2Chart({ vendorDir: tempVendor, outputDir: tempOutput, execFile });

        try {
            const result = await chart.generate(DUMMY_AUDIO);

            assert.strictEqual(result.sourcePath, path.resolve(DUMMY_AUDIO));
            assert.ok(result.chartPath.endsWith(".chart"), "chartPath should end with .chart");
            assert.ok(fs.existsSync(result.chartPath), "Chart file should exist");
        } finally {
            fs.rmSync(tempVendor, { recursive: true, force: true });
            fs.rmSync(tempOutput, { recursive: true, force: true });
        }
    });

    await test("should throw when audio file is missing", async () => {
        const { execFile } = createMockExec(() => ({ stdout: "" }));
        const chart = new Audio2Chart({ vendorDir: VENDOR_DIR, outputDir: OUTPUT_DIR, execFile });

        let threw = false;
        try {
            await chart.generate("/nonexistent/audio.wav");
        } catch (error) {
            threw = true;
            assert.ok(
                error instanceof Error && error.message.includes("Audio file not found"),
                `Error should mention missing file, got: ${error instanceof Error ? error.message : error}`,
            );
        }
        assert.ok(threw, "Should throw for missing audio file");
    });

    await test("should throw when subprocess fails", async () => {
        const tempVendor = path.join(TEST_DIR, "vendor-fail-test");
        const tempOutput = path.join(TEST_DIR, "output-fail-test");
        const repoDir = path.join(tempVendor, "audio2chart");
        const venvDir = path.join(tempVendor, "audio2chart-venv");

        fs.mkdirSync(repoDir, { recursive: true });
        fs.writeFileSync(path.join(repoDir, "generate.py"), "# fake");
        fs.mkdirSync(venvDir, { recursive: true });
        fs.writeFileSync(path.join(venvDir, "setup-complete.marker"), "done");
        fs.mkdirSync(tempOutput, { recursive: true });

        const { execFile } = createMockExec(() => {
            const err = new Error("Process exited with code 1") as Error & { stderr: string };
            err.stderr = "RuntimeError: model not found";
            return { error: err };
        });

        const chart = new Audio2Chart({ vendorDir: tempVendor, outputDir: tempOutput, execFile });

        try {
            let threw = false;
            try {
                await chart.generate(DUMMY_AUDIO);
            } catch (error) {
                threw = true;
                assert.ok(
                    error instanceof Error && error.message.includes("generate.py failed"),
                    `Error should mention generate.py failure, got: ${error instanceof Error ? error.message : error}`,
                );
            }
            assert.ok(threw, "Should throw on subprocess failure");
        } finally {
            fs.rmSync(tempVendor, { recursive: true, force: true });
            fs.rmSync(tempOutput, { recursive: true, force: true });
        }
    });

    await test("should throw when output .chart file not found", async () => {
        const tempVendor = path.join(TEST_DIR, "vendor-nochart-test");
        const tempOutput = path.join(TEST_DIR, "output-nochart-test");
        const repoDir = path.join(tempVendor, "audio2chart");
        const venvDir = path.join(tempVendor, "audio2chart-venv");

        fs.mkdirSync(repoDir, { recursive: true });
        fs.writeFileSync(path.join(repoDir, "generate.py"), "# fake");
        fs.mkdirSync(venvDir, { recursive: true });
        fs.writeFileSync(path.join(venvDir, "setup-complete.marker"), "done");
        fs.mkdirSync(tempOutput, { recursive: true });

        const { execFile } = createMockExec(() => {
            // Don't create any .chart file
            return { stdout: "Done" };
        });

        const chart = new Audio2Chart({ vendorDir: tempVendor, outputDir: tempOutput, execFile });

        try {
            let threw = false;
            try {
                await chart.generate(DUMMY_AUDIO);
            } catch (error) {
                threw = true;
                assert.ok(
                    error instanceof Error && error.message.includes("No .chart file found"),
                    `Error should mention missing .chart file, got: ${error instanceof Error ? error.message : error}`,
                );
            }
            assert.ok(threw, "Should throw when .chart file is missing");
        } finally {
            fs.rmSync(tempVendor, { recursive: true, force: true });
            fs.rmSync(tempOutput, { recursive: true, force: true });
        }
    });

    // Cleanup
    console.log("\nCleaning up chart test fixtures...");
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        console.log("Warning: could not fully clean up test fixtures.");
    }

    // Summary
    console.log(`\n${passed} passed, ${failed} failed`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch((error) => {
    console.error("Test runner error:", error);
    process.exit(1);
});
