import * as assert from "node:assert";
import { parseChart } from "../src/chart/parse.js";
import { remapChartTracks } from "../src/server/worker.js";

const GUITAR_CHART_WITH_BLUE_ORANGE_CHORD = `[Song]
{
  Name = "Drum Remap"
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
}
[Events]
{
}
[ExpertSingle]
{
  768 = N 3 0
  768 = N 4 0
  960 = N 3 0
  960 = N 4 192
  1152 = N 2 0
  1152 = N 7 0
  1344 = S 2 384
}`;

async function runTests(): Promise<void> {
    let passed = 0;
    let failed = 0;

    async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
        try {
            await fn();
            console.log(`ok - ${name}`);
            passed++;
        } catch (error) {
            console.log(`not ok - ${name}`);
            console.log(`    Error: ${error instanceof Error ? error.message : error}`);
            failed++;
        }
    }

    await test("drum remap dedupes blue/orange chords that collapse onto lane 4", () => {
        const chart = parseChart(GUITAR_CHART_WITH_BLUE_ORANGE_CHORD);
        const remapped = remapChartTracks(chart, "ExpertDrums", true);
        const events = remapped.tracks.get("ExpertDrums")!.events;

        const duplicateLane4 = events.filter(
            (ev) => ev.position === 768 && ev.typeCode === "N" && ev.values[0] === "4",
        );
        assert.strictEqual(duplicateLane4.length, 1);
        assert.deepStrictEqual(duplicateLane4[0]!.values, ["4", "0"]);
    });

    await test("drum remap keeps distinct notes at the same position", () => {
        const chart = parseChart(GUITAR_CHART_WITH_BLUE_ORANGE_CHORD);
        const remapped = remapChartTracks(chart, "ExpertDrums", true);
        const events = remapped.tracks.get("ExpertDrums")!.events;

        assert.ok(events.some((ev) => ev.position === 960 && ev.typeCode === "N" && ev.values.join(" ") === "4 0"));
        assert.ok(events.some((ev) => ev.position === 960 && ev.typeCode === "N" && ev.values.join(" ") === "4 192"));
        assert.ok(events.some((ev) => ev.position === 1152 && ev.typeCode === "N" && ev.values.join(" ") === "3 0"));
        assert.ok(events.some((ev) => ev.position === 1152 && ev.typeCode === "N" && ev.values.join(" ") === "0 0"));
        assert.ok(events.some((ev) => ev.position === 1344 && ev.typeCode === "S"));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
    console.error("Test runner error:", error);
    process.exit(1);
});
