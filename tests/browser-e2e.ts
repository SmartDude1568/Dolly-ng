/**
 * End-to-end browser test for the Dolly web app.
 *
 * Drives the real UI with Playwright/Chromium:
 *   register -> login -> upload test.mp3 -> start conversion
 *   -> wait for the pipeline (LALAL split + Modal audio2chart + SNG pack)
 *   -> download the .sng and verify it is a valid SNGPKG archive.
 *
 * Usage:
 *   npx tsx tests/browser-e2e.ts
 *
 * Env:
 *   BASE_URL      (default http://localhost:3000)
 *   INSTRUMENTS   (default "guitar,bass,drums")
 *   HEADLESS      (default "true"; set "false" to watch)
 *   E2E_TIMEOUT_MS (default 1200000 = 20 min)
 */

import { chromium, type Browser, type Page } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const INSTRUMENTS = process.env.INSTRUMENTS ?? "guitar,bass,drums";
const HEADLESS = (process.env.HEADLESS ?? "true") !== "false";
const TIMEOUT_MS = parseInt(process.env.E2E_TIMEOUT_MS ?? "1200000", 10);

const ARTIFACT_DIR = path.resolve("output/e2e");
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const email = `e2e_${Date.now()}@dolly.test`;
const password = "password12345";

async function shot(page: Page, name: string): Promise<void> {
    const p = path.join(ARTIFACT_DIR, `${name}.png`);
    await page.screenshot({ path: p, fullPage: true });
    console.log(`  📸 ${p}`);
}

function step(msg: string): void {
    console.log(`\n▶ ${msg}`);
}

async function main(): Promise<void> {
    const browser: Browser = await chromium.launch({ headless: HEADLESS });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.on("console", (m) => console.log(`    [browser:${m.type()}] ${m.text()}`));

    try {
        step(`Opening ${BASE_URL}`);
        await page.goto(BASE_URL, { waitUntil: "networkidle" });
        await shot(page, "01-home");

        step(`Registering ${email}`);
        await page.fill('#register-form input[name="email"]', email);
        await page.fill('#register-form input[name="password"]', password);
        await page.fill('#register-form input[name="display_name"]', "E2E Tester");
        await page.click('#register-form button[type="submit"]');
        await page.waitForFunction(
            () => document.getElementById("message")?.textContent?.includes("Registered"),
            { timeout: 15000 },
        );
        console.log("  ✓ registered");

        step("Logging in");
        await page.fill('#login-form input[name="email"]', email);
        await page.fill('#login-form input[name="password"]', password);
        await page.click('#login-form button[type="submit"]');
        await page.waitForSelector("#app-section:not([hidden])", { timeout: 15000 });
        console.log("  ✓ logged in (app section visible)");
        await shot(page, "02-logged-in");

        step("Uploading test.mp3");
        const mp3 = path.resolve("test.mp3");
        if (!fs.existsSync(mp3)) throw new Error(`test.mp3 not found at ${mp3}`);
        await page.setInputFiles('#upload-form input[name="file"]', mp3);
        await page.fill('#upload-form input[name="name"]', "test.mp3");
        await page.click('#upload-form button[type="submit"]');
        await page.waitForFunction(
            () => document.getElementById("message")?.textContent?.includes("Uploaded"),
            { timeout: 30000 },
        );
        const fileId = await page.inputValue('#conversion-form input[name="input_file_id"]');
        console.log(`  ✓ uploaded; conversion form auto-filled with file_id=${fileId}`);
        if (!fileId) throw new Error("file_id was not auto-filled after upload");
        await shot(page, "03-uploaded");

        step(`Starting conversion (instruments: ${INSTRUMENTS})`);
        await page.fill('#conversion-form input[name="instruments"]', INSTRUMENTS);
        await page.selectOption('#conversion-form select[name="difficulty"]', "expert");
        await page.click('#conversion-form button[type="submit"]');
        await page.waitForFunction(
            () => document.getElementById("message")?.textContent?.includes("Conversion started"),
            { timeout: 15000 },
        );
        console.log("  ✓ conversion started");
        await shot(page, "04-conversion-started");

        step("Waiting for conversion to complete (this runs the real pipeline)…");
        const downloadBtn = page.locator("#conversion-list button.download-link").first();
        const t0 = Date.now();
        // Poll the visible task summary while we wait, for live progress.
        let lastSummary = "";
        while (Date.now() - t0 < TIMEOUT_MS) {
            if (await downloadBtn.count() > 0 && await downloadBtn.isVisible()) break;
            const summary = (await page.locator("#conversion-list li").first().textContent()) ?? "";
            if (summary !== lastSummary) {
                console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${summary.trim()}`);
                lastSummary = summary;
            }
            // Nudge a refresh in case the auto-poll timer is idle.
            await page.click("#refresh-conversions").catch(() => {});
            await page.waitForTimeout(4000);
        }
        if (!(await downloadBtn.count())) {
            await shot(page, "99-timeout");
            throw new Error("Conversion did not complete before timeout");
        }
        console.log(`  ✓ conversion completed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        await shot(page, "05-completed");

        step("Downloading .sng");
        const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 30000 }),
            downloadBtn.click(),
        ]);
        const suggested = download.suggestedFilename();
        const savePath = path.join(ARTIFACT_DIR, suggested);
        await download.saveAs(savePath);
        const buf = fs.readFileSync(savePath);
        const magic = buf.toString("ascii", 0, 6);
        console.log(`  ✓ downloaded ${suggested} (${buf.length} bytes), magic="${magic}"`);
        if (magic !== "SNGPKG") throw new Error(`Downloaded file is not a valid .sng (magic=${magic})`);
        await shot(page, "06-downloaded");

        console.log("\n✅ E2E PASSED");
        console.log(`   user:   ${email}`);
        console.log(`   file:   ${fileId}`);
        console.log(`   sng:    ${savePath} (${buf.length} bytes)`);
    } finally {
        await browser.close();
    }
}

main().catch((err) => {
    console.error("\n❌ E2E FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
});
