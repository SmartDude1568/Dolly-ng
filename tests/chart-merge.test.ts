import * as assert from "node:assert";
import { parseChart, type Chart } from "../src/chart/parse.js";
import { writeChart } from "../src/chart/write.js";
import { mergeCharts } from "../src/chart/merge.js";

// ── Sample .chart content ──────────────────────────────────────────────────

const GUITAR_CHART = `[Song]
{
  Name = "Test Song"
  Artist = "Test Artist"
  Charter = "Dolly"
  Resolution = 192
  Offset = 0
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
  768 = B 140000
}
[Events]
{
  768 = E "section Intro"
  3840 = E "section Verse"
  9216 = E "end"
}
[ExpertSingle]
{
  768 = N 0 0
  768 = N 1 0
  960 = N 2 0
  1152 = N 3 192
  1344 = N 4 0
}
[HardSingle]
{
  768 = N 0 0
  960 = N 1 0
  1152 = N 2 192
}`;

const DRUMS_CHART = `[Song]
{
  Name = "Test Song"
  Artist = "Test Artist"
  Charter = "Dolly"
  Resolution = 192
  Offset = 0
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
  768 = B 140000
}
[Events]
{
  768 = E "section Intro"
  3840 = E "section Verse"
  9216 = E "end"
}
[ExpertDrums]
{
  768 = N 0 0
  768 = N 1 0
  960 = N 2 0
  960 = N 3 0
  1152 = N 0 0
  1152 = N 4 0
}`;

const BASS_CHART = `[Song]
{
  Name = "Test Song"
  Artist = "Test Artist"
  Charter = "Dolly"
  Resolution = 192
  Offset = 0
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
}
[Events]
{
  768 = E "section Intro"
}
[ExpertDoubleBass]
{
  768 = N 0 192
  960 = N 1 0
  1152 = N 0 0
}`;

// ── Test runner ────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
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

    // ── Parser tests ───────────────────────────────────────────────────

    console.log("parseChart");

    await test("should parse [Song] metadata", () => {
        const chart = parseChart(GUITAR_CHART);
        assert.strictEqual(chart.song.Name, "Test Song");
        assert.strictEqual(chart.song.Artist, "Test Artist");
        assert.strictEqual(chart.song.Charter, "Dolly");
        assert.strictEqual(chart.song.Resolution, "192");
        assert.strictEqual(chart.song.Offset, "0");
    });

    await test("should parse [SyncTrack] events", () => {
        const chart = parseChart(GUITAR_CHART);
        assert.strictEqual(chart.syncTrack.events.length, 3);

        const ts = chart.syncTrack.events[0]!;
        assert.strictEqual(ts.position, 0);
        assert.strictEqual(ts.typeCode, "TS");
        assert.deepStrictEqual(ts.values, ["4"]);

        const bpm1 = chart.syncTrack.events[1]!;
        assert.strictEqual(bpm1.typeCode, "B");
        assert.deepStrictEqual(bpm1.values, ["120000"]);

        const bpm2 = chart.syncTrack.events[2]!;
        assert.strictEqual(bpm2.position, 768);
        assert.deepStrictEqual(bpm2.values, ["140000"]);
    });

    await test("should parse [Events] with quoted text", () => {
        const chart = parseChart(GUITAR_CHART);
        assert.strictEqual(chart.events.events.length, 3);

        const intro = chart.events.events[0]!;
        assert.strictEqual(intro.position, 768);
        assert.strictEqual(intro.typeCode, "E");
        assert.deepStrictEqual(intro.values, ["section Intro"]);
    });

    await test("should parse instrument tracks", () => {
        const chart = parseChart(GUITAR_CHART);
        assert.strictEqual(chart.tracks.size, 2);
        assert.ok(chart.tracks.has("ExpertSingle"));
        assert.ok(chart.tracks.has("HardSingle"));

        const expert = chart.tracks.get("ExpertSingle")!;
        assert.strictEqual(expert.events.length, 5);

        const note = expert.events[0]!;
        assert.strictEqual(note.position, 768);
        assert.strictEqual(note.typeCode, "N");
        assert.deepStrictEqual(note.values, ["0", "0"]);
    });

    await test("should parse sustain notes with non-zero length", () => {
        const chart = parseChart(GUITAR_CHART);
        const expert = chart.tracks.get("ExpertSingle")!;
        const sustain = expert.events[3]!;
        assert.strictEqual(sustain.position, 1152);
        assert.deepStrictEqual(sustain.values, ["3", "192"]);
    });

    await test("should handle empty input", () => {
        const chart = parseChart("");
        assert.deepStrictEqual(chart.song, {});
        assert.strictEqual(chart.syncTrack.events.length, 0);
        assert.strictEqual(chart.events.events.length, 0);
        assert.strictEqual(chart.tracks.size, 0);
    });

    // ── Writer tests ───────────────────────────────────────────────────

    console.log("\nwriteChart");

    await test("should produce valid .chart output", () => {
        const chart = parseChart(GUITAR_CHART);
        const output = writeChart(chart);

        // Should contain all sections
        assert.ok(output.includes("[Song]"), "Should have [Song]");
        assert.ok(output.includes("[SyncTrack]"), "Should have [SyncTrack]");
        assert.ok(output.includes("[Events]"), "Should have [Events]");
        assert.ok(output.includes("[ExpertSingle]"), "Should have [ExpertSingle]");
        assert.ok(output.includes("[HardSingle]"), "Should have [HardSingle]");
    });

    await test("should quote string metadata values", () => {
        const chart = parseChart(GUITAR_CHART);
        const output = writeChart(chart);
        assert.ok(output.includes('Name = "Test Song"'), "Name should be quoted");
        assert.ok(output.includes('Artist = "Test Artist"'), "Artist should be quoted");
    });

    await test("should not quote numeric metadata values", () => {
        const chart = parseChart(GUITAR_CHART);
        const output = writeChart(chart);
        assert.ok(output.includes("Resolution = 192"), "Resolution should not be quoted");
        assert.ok(output.includes("Offset = 0"), "Offset should not be quoted");
    });

    await test("should quote text events", () => {
        const chart = parseChart(GUITAR_CHART);
        const output = writeChart(chart);
        assert.ok(output.includes('768 = E "section Intro"'), "Events should be quoted");
    });

    await test("should round-trip parse -> write -> parse", () => {
        const original = parseChart(GUITAR_CHART);
        const written = writeChart(original);
        const reparsed = parseChart(written);

        // Song metadata
        assert.strictEqual(reparsed.song.Name, original.song.Name);
        assert.strictEqual(reparsed.song.Resolution, original.song.Resolution);

        // SyncTrack
        assert.strictEqual(reparsed.syncTrack.events.length, original.syncTrack.events.length);
        for (let i = 0; i < original.syncTrack.events.length; i++) {
            assert.deepStrictEqual(reparsed.syncTrack.events[i], original.syncTrack.events[i]);
        }

        // Events
        assert.strictEqual(reparsed.events.events.length, original.events.events.length);

        // Tracks
        assert.strictEqual(reparsed.tracks.size, original.tracks.size);
        for (const [name, section] of original.tracks) {
            const reparsedSection = reparsed.tracks.get(name);
            assert.ok(reparsedSection, `Track ${name} should exist after round-trip`);
            assert.strictEqual(reparsedSection!.events.length, section.events.length);
            for (let i = 0; i < section.events.length; i++) {
                assert.deepStrictEqual(reparsedSection!.events[i], section.events[i]);
            }
        }
    });

    // ── Merger tests ───────────────────────────────────────────────────

    console.log("\nmergeCharts");

    await test("should merge guitar and drums into one chart", () => {
        const guitar = parseChart(GUITAR_CHART);
        const drums = parseChart(DRUMS_CHART);
        const merged = mergeCharts([guitar, drums]);

        // Should have tracks from both
        assert.ok(merged.tracks.has("ExpertSingle"), "Should have ExpertSingle from guitar");
        assert.ok(merged.tracks.has("HardSingle"), "Should have HardSingle from guitar");
        assert.ok(merged.tracks.has("ExpertDrums"), "Should have ExpertDrums from drums");
        assert.strictEqual(merged.tracks.size, 3);
    });

    await test("should use first chart's Song metadata as base", () => {
        const guitar = parseChart(GUITAR_CHART);
        const drums = parseChart(DRUMS_CHART);
        const merged = mergeCharts([guitar, drums]);

        assert.strictEqual(merged.song.Name, "Test Song");
        assert.strictEqual(merged.song.Charter, "Dolly");
    });

    await test("should use first chart's SyncTrack", () => {
        const guitar = parseChart(GUITAR_CHART);
        const bass = parseChart(BASS_CHART);
        const merged = mergeCharts([guitar, bass]);

        // Guitar has 3 sync events, bass has 2 — should use guitar's
        assert.strictEqual(merged.syncTrack.events.length, 3);
    });

    await test("should use first chart's Events", () => {
        const guitar = parseChart(GUITAR_CHART);
        const bass = parseChart(BASS_CHART);
        const merged = mergeCharts([guitar, bass]);

        assert.strictEqual(merged.events.events.length, 3);
    });

    await test("should merge three charts", () => {
        const guitar = parseChart(GUITAR_CHART);
        const drums = parseChart(DRUMS_CHART);
        const bass = parseChart(BASS_CHART);
        const merged = mergeCharts([guitar, drums, bass]);

        assert.ok(merged.tracks.has("ExpertSingle"));
        assert.ok(merged.tracks.has("HardSingle"));
        assert.ok(merged.tracks.has("ExpertDrums"));
        assert.ok(merged.tracks.has("ExpertDoubleBass"));
        assert.strictEqual(merged.tracks.size, 4);
    });

    await test("should apply song metadata overrides", () => {
        const guitar = parseChart(GUITAR_CHART);
        const drums = parseChart(DRUMS_CHART);
        const merged = mergeCharts([guitar, drums], {
            songOverrides: { Name: "Overridden Name", Charter: "MergeBot" },
        });

        assert.strictEqual(merged.song.Name, "Overridden Name");
        assert.strictEqual(merged.song.Charter, "MergeBot");
        // Non-overridden values should persist
        assert.strictEqual(merged.song.Artist, "Test Artist");
    });

    await test("should handle conflict with last-wins (default)", () => {
        // Create two charts that both have ExpertSingle
        const chart1 = parseChart(GUITAR_CHART);
        const chart2Text = GUITAR_CHART.replace(
            "768 = N 0 0\n  768 = N 1 0",
            "768 = N 4 0",
        );
        const chart2 = parseChart(chart2Text);

        const merged = mergeCharts([chart1, chart2]);
        const expert = merged.tracks.get("ExpertSingle")!;

        // chart2 has fewer events — if last-wins, we should see chart2's version
        assert.ok(expert.events.length < chart1.tracks.get("ExpertSingle")!.events.length);
    });

    await test("should handle conflict with first-wins", () => {
        const chart1 = parseChart(GUITAR_CHART);
        const chart2Text = GUITAR_CHART.replace(
            "768 = N 0 0\n  768 = N 1 0",
            "768 = N 4 0",
        );
        const chart2 = parseChart(chart2Text);

        const merged = mergeCharts([chart1, chart2], { conflictStrategy: "first-wins" });
        const expert = merged.tracks.get("ExpertSingle")!;

        // Should keep chart1's version (5 events)
        assert.strictEqual(expert.events.length, 5);
    });

    await test("should throw on conflict with error strategy", () => {
        const chart1 = parseChart(GUITAR_CHART);
        const chart2 = parseChart(GUITAR_CHART);

        let threw = false;
        try {
            mergeCharts([chart1, chart2], { conflictStrategy: "error" });
        } catch (error) {
            threw = true;
            assert.ok(
                error instanceof Error && error.message.includes("Conflict"),
                `Should mention conflict, got: ${error instanceof Error ? error.message : error}`,
            );
        }
        assert.ok(threw, "Should throw on conflict");
    });

    await test("should handle single chart input", () => {
        const guitar = parseChart(GUITAR_CHART);
        const merged = mergeCharts([guitar]);
        assert.strictEqual(merged.tracks.size, 2);
        assert.strictEqual(merged.song.Name, "Test Song");
    });

    await test("should throw on empty array", () => {
        let threw = false;
        try {
            mergeCharts([]);
        } catch {
            threw = true;
        }
        assert.ok(threw, "Should throw on empty array");
    });

    await test("merged chart should produce valid .chart output", () => {
        const guitar = parseChart(GUITAR_CHART);
        const drums = parseChart(DRUMS_CHART);
        const bass = parseChart(BASS_CHART);
        const merged = mergeCharts([guitar, drums, bass], {
            songOverrides: { Charter: "Dolly Merger" },
        });
        const output = writeChart(merged);

        // Verify it can be re-parsed
        const reparsed = parseChart(output);
        assert.strictEqual(reparsed.tracks.size, 4);
        assert.strictEqual(reparsed.song.Charter, "Dolly Merger");
        assert.ok(reparsed.tracks.has("ExpertSingle"));
        assert.ok(reparsed.tracks.has("HardSingle"));
        assert.ok(reparsed.tracks.has("ExpertDrums"));
        assert.ok(reparsed.tracks.has("ExpertDoubleBass"));
    });

    // ── Summary ────────────────────────────────────────────────────────

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
    console.error("Test runner error:", error);
    process.exit(1);
});
