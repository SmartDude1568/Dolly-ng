import * as assert from "node:assert";
import { parseChart, type Chart } from "../src/chart/parse.js";
import {
    remapChartTracks,
    countSectionNotes,
    enforceTempo,
    selectInstrumentsWithNotes,
    songIniDiffFields,
} from "../src/server/worker.js";

/** Minimal audio2chart-style chart with a single [ExpertSingle] track. */
function guitarChart(noteLines: string): string {
    return `[Song]
{
  Name = "T"
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
${noteLines}
}`;
}

/** Build a remapped charted-instrument entry the way the worker does. */
function charted(instrument: string, stem: string, section: string, chartText: string, drums = false) {
    return {
        instrument,
        entry: { stem, section, chName: instrument },
        section,
        chart: remapChartTracks(parseChart(chartText), section, drums),
    };
}

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

    // ── Dropped-guitar bug regression ────────────────────────────────────

    await test("countSectionNotes counts only N events on the target track", () => {
        const chart = remapChartTracks(
            parseChart(guitarChart("  768 = N 0 0\n  960 = N 1 0\n  1344 = S 2 384")),
            "ExpertSingle",
        );
        // Two notes; the S (star power) phrase is not counted.
        assert.strictEqual(countSectionNotes(chart, "ExpertSingle"), 2);
        // A track that does not exist has zero notes.
        assert.strictEqual(countSectionNotes(chart, "ExpertDrums"), 0);
    });

    await test("remapChartTracks of a note-less source yields a note-less track", () => {
        // audio2chart can return a track with only phrases / no notes.
        const empty = remapChartTracks(parseChart(guitarChart("  1344 = S 2 384")), "ExpertSingle");
        assert.strictEqual(countSectionNotes(empty, "ExpertSingle"), 0);
    });

    await test("selectInstrumentsWithNotes drops a note-less guitar but keeps bass + drums", () => {
        // The exact Carissa shape: guitar charted empty, the rhythm section did not.
        const items = [
            charted("guitar", "electric_guitar", "ExpertSingle", guitarChart("  1344 = S 2 384")),
            charted("bass", "bass", "ExpertDoubleBass", guitarChart("  768 = N 0 0")),
            charted("drums", "drum", "ExpertDrums", guitarChart("  768 = N 0 0"), true),
        ];
        const { kept, dropped } = selectInstrumentsWithNotes(items);
        assert.deepStrictEqual(kept.map((c) => c.instrument), ["bass", "drums"]);
        assert.deepStrictEqual(dropped.map((c) => c.instrument), ["guitar"]);
    });

    await test("selectInstrumentsWithNotes keeps a guitar that has notes", () => {
        const items = [charted("guitar", "electric_guitar", "ExpertSingle", guitarChart("  768 = N 0 0"))];
        const { kept, dropped } = selectInstrumentsWithNotes(items);
        assert.strictEqual(kept.length, 1);
        assert.strictEqual(dropped.length, 0);
    });

    await test("song.ini advertises only instruments that produced notes", () => {
        // A dropped guitar must NOT be advertised, or Clone Hero hides the song's
        // (real) parts looking for a guitar track that isn't there.
        const produced = new Set(["bass", "drums"]);
        const fields = songIniDiffFields(produced, "5");
        assert.strictEqual(fields.diff_guitar, "-1", "dropped guitar is not advertised");
        assert.strictEqual(fields.diff_bass, "5");
        assert.strictEqual(fields.diff_drums, "5");
        assert.strictEqual(fields.diff_keys, "-1");
    });

    await test("song.ini advertises a guitar that produced notes", () => {
        const fields = songIniDiffFields(new Set(["guitar", "bass", "drums", "keys"]), "5");
        assert.deepStrictEqual(fields, {
            diff_guitar: "5",
            diff_bass: "5",
            diff_drums: "5",
            diff_keys: "5",
        });
    });

    // ── Multi-difficulty audio2chart payloads ────────────────────────────

    /** A chart like the updated audio2chart returns: one track per difficulty. */
    const MULTI_DIFFICULTY_CHART = `[Song]
{
  Name = "T"
  Resolution = 192
}
[SyncTrack]
{
  0 = TS 4
  0 = B 120000
}
[Events]
{
  0 = E "section Section 1"
}
[ExpertSingle]
{
  768 = N 0 0
  960 = N 1 96
  1152 = N 7 0
  1344 = S 2 384
}
[HardSingle]
{
  768 = N 0 0
  1152 = N 2 0
}
[MediumSingle]
{
  768 = N 1 0
}
[EasySingle]
{
  768 = N 0 0
}`;

    await test("remap carries every generated difficulty onto the instrument's track", () => {
        const remapped = remapChartTracks(parseChart(MULTI_DIFFICULTY_CHART), "HardDoubleBass");
        assert.deepStrictEqual(
            [...remapped.tracks.keys()].sort(),
            ["EasyDoubleBass", "ExpertDoubleBass", "HardDoubleBass", "MediumDoubleBass"],
        );
        // Each track keeps its own notes rather than being a relabelled Expert.
        assert.strictEqual(countSectionNotes(remapped, "ExpertDoubleBass"), 3);
        assert.strictEqual(countSectionNotes(remapped, "HardDoubleBass"), 2);
        assert.strictEqual(countSectionNotes(remapped, "MediumDoubleBass"), 1);
        assert.strictEqual(remapped.events.events.length, 1, "sections survive the remap");
    });

    await test("remap of a legacy Expert-only payload still honours the requested difficulty", () => {
        const remapped = remapChartTracks(
            parseChart(guitarChart("  768 = N 0 0\n  960 = N 1 0")),
            "EasyDoubleBass",
        );
        assert.deepStrictEqual([...remapped.tracks.keys()], ["EasyDoubleBass"]);
        assert.strictEqual(countSectionNotes(remapped, "EasyDoubleBass"), 2);
    });

    await test("drum remap legalises lanes on every difficulty track", () => {
        const remapped = remapChartTracks(parseChart(MULTI_DIFFICULTY_CHART), "ExpertDrums", true);
        assert.strictEqual(remapped.tracks.size, 4);
        for (const [name, section] of remapped.tracks) {
            for (const ev of section.events) {
                if (ev.typeCode !== "N") continue;
                const lane = Number(ev.values[0]);
                assert.ok(lane >= 0 && lane <= 4, `illegal drum lane ${lane} in ${name}`);
            }
        }
    });

    await test("a multi-difficulty instrument is kept when its requested track has notes", () => {
        const items = [charted("bass", "bass", "HardDoubleBass", MULTI_DIFFICULTY_CHART)];
        const { kept, dropped } = selectInstrumentsWithNotes(items);
        assert.strictEqual(kept.length, 1);
        assert.strictEqual(dropped.length, 0);
    });

    // ── SyncTrack vs. the confirmed BPM ──────────────────────────────────

    const chartWithTempos = (events: string): Chart =>
        parseChart(`[Song]
{
  Name = "T"
  Resolution = 192
}
[SyncTrack]
{
${events}
}
[ExpertSingle]
{
  768 = N 0 0
}`);
    const tempos = (chart: Chart): string[] =>
        chart.syncTrack.events.filter((e) => e.typeCode === "B").map((e) => `${e.position}:${e.values[0]}`);

    await test("a tempo map that follows the beats near the confirmed BPM is kept", () => {
        // One-beat lead-in, then the beats drifting a little around 120 BPM.
        const chart = chartWithTempos("  0 = TS 4\n  0 = B 96000\n  192 = B 119500\n  384 = B 121250");
        enforceTempo(chart, 120);
        assert.deepStrictEqual(tempos(chart), ["0:96000", "192:119500", "384:121250"]);
    });

    await test("a tempo map far from the confirmed BPM is replaced by one constant tempo", () => {
        const chart = chartWithTempos("  0 = TS 4\n  0 = B 200000\n  768 = B 210000");
        enforceTempo(chart, 120);
        assert.deepStrictEqual(tempos(chart), ["0:120000"]);
    });

    await test("a chart with no time signature gets 4/4 whether its tempo is kept or replaced", () => {
        for (const events of ["  0 = B 120500", "  0 = B 200000"]) {
            const chart = chartWithTempos(events);
            enforceTempo(chart, 120);
            assert.ok(
                chart.syncTrack.events.some((e) => e.typeCode === "TS" && e.position === 0 && e.values[0] === "4"),
                `no 4/4 for ${events}`,
            );
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch((error) => {
    console.error("Test runner error:", error);
    process.exit(1);
});
