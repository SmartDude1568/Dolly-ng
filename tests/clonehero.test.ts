/**
 * Unit tests for Clone Hero install/detection helpers (src/clonehero.ts).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as assert from "node:assert";
import { fileURLToPath } from "node:url";
import { findCloneHeroSongsDir, ensureSongsDir, installSng } from "../src/clonehero.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, "fixtures", "clonehero");

const COMPANY = "srylain Inc_";
const APP_NAME = "Clone Hero";

async function runTests(): Promise<void> {
    fs.mkdirSync(TEST_DIR, { recursive: true });

    let passed = 0;
    let failed = 0;

    async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
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

    console.log("ensureSongsDir");

    await test("should create a missing directory (recursively)", () => {
        const dir = path.join(TEST_DIR, "a", "b", "Songs");
        ensureSongsDir(dir);
        assert.ok(fs.existsSync(dir));
    });

    await test("should be idempotent on an existing directory", () => {
        const dir = path.join(TEST_DIR, "exists", "Songs");
        ensureSongsDir(dir);
        assert.doesNotThrow(() => ensureSongsDir(dir));
    });

    console.log("\ninstallSng");

    await test("should copy a .sng into the songs dir and return the dest path", () => {
        const src = path.join(TEST_DIR, "MySong.sng");
        fs.writeFileSync(src, Buffer.from("SNGPKG-fake"));
        const songsDir = path.join(TEST_DIR, "install", "Songs");
        const dest = installSng(src, songsDir);
        assert.strictEqual(dest, path.join(songsDir, "MySong.sng"));
        assert.ok(fs.existsSync(dest));
        assert.deepStrictEqual(fs.readFileSync(dest), fs.readFileSync(src));
    });

    await test("should create the songs dir if it does not exist", () => {
        const src = path.join(TEST_DIR, "Another.sng");
        fs.writeFileSync(src, "data");
        const songsDir = path.join(TEST_DIR, "fresh", "deep", "Songs");
        const dest = installSng(src, songsDir);
        assert.ok(fs.existsSync(dest));
    });

    console.log("\nfindCloneHeroSongsDir");

    await test("should locate the songs dir on the current platform via env override", () => {
        // Build the platform-appropriate candidate under a temp HOME/APPDATA so
        // the detector finds it without depending on a real CH install.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ch-detect-"));
        const saved = { ...process.env };
        let expected: string;
        try {
            if (process.platform === "win32") {
                const appData = path.join(root, "AppData", "Roaming");
                const localLow = path.join(path.dirname(appData), "LocalLow");
                process.env.APPDATA = appData;
                expected = path.join(localLow, COMPANY, APP_NAME, "Songs");
            } else if (process.platform === "darwin") {
                process.env.HOME = root;
                expected = path.join(root, "Library", "Application Support", COMPANY, APP_NAME, "Songs");
            } else {
                process.env.XDG_CONFIG_HOME = path.join(root, ".config");
                expected = path.join(root, ".config", "unity3d", COMPANY, APP_NAME, "Songs");
            }
            fs.mkdirSync(expected, { recursive: true });
            const found = findCloneHeroSongsDir();
            assert.strictEqual(found, expected);
        } finally {
            // Restore env (delete keys we may have added, then reassign).
            for (const k of ["APPDATA", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "LOCALAPPDATA"]) {
                if (k in saved) process.env[k] = saved[k]!;
                else delete process.env[k];
            }
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await test("should return null when no installation exists", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ch-none-"));
        const saved = { ...process.env };
        try {
            // Point every search root at an empty temp dir.
            process.env.APPDATA = path.join(root, "AppData", "Roaming");
            process.env.LOCALAPPDATA = path.join(root, "AppData", "Local");
            process.env.HOME = root;
            process.env.XDG_CONFIG_HOME = path.join(root, ".config");
            process.env.XDG_DATA_HOME = path.join(root, ".local", "share");
            const found = findCloneHeroSongsDir();
            assert.strictEqual(found, null);
        } finally {
            for (const k of ["APPDATA", "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "LOCALAPPDATA"]) {
                if (k in saved) process.env[k] = saved[k]!;
                else delete process.env[k];
            }
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    // Cleanup
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
        console.log("Warning: could not fully clean up clonehero test fixtures.");
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
    console.error("Test runner error:", error);
    process.exit(1);
});
