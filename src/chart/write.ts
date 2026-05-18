/**
 * .chart file writer.
 *
 * Serializes a {@link Chart} structure back into valid .chart text.
 */

import type { Chart, ChartSection, TrackEvent, SongMeta } from "./parse.js";

/**
 * Serialize a {@link Chart} to a .chart format string.
 *
 * Section order: [Song], [SyncTrack], [Events], then instrument tracks
 * in alphabetical order for deterministic output.
 */
export function writeChart(chart: Chart): string {
    const parts: string[] = [];

    parts.push(writeSongSection(chart.song));
    parts.push(writeTrackSection(chart.syncTrack));
    parts.push(writeTrackSection(chart.events));

    // Sort instrument tracks alphabetically for stable output
    const trackNames = [...chart.tracks.keys()].sort();
    for (const name of trackNames) {
        parts.push(writeTrackSection(chart.tracks.get(name)!));
    }

    return parts.join("\n");
}

function writeSongSection(meta: SongMeta): string {
    const lines = ["[Song]", "{"];

    // Determine which values need quoting (strings with spaces or that were
    // originally quoted). For safety, quote everything except bare numbers
    // and known unquoted values like "None".
    for (const [key, value] of Object.entries(meta)) {
        const needsQuotes = needsQuoting(key, value);
        const formatted = needsQuotes ? `"${value}"` : value;
        lines.push(`  ${key} = ${formatted}`);
    }

    lines.push("}");
    return lines.join("\n");
}

/** Keys whose values are numeric and should not be quoted. */
const NUMERIC_KEYS = new Set([
    "Resolution", "Difficulty", "PreviewStart", "PreviewEnd",
    "Offset", "Length", "GuitarVolume", "GuitarVol",
    "BandVolume", "BandVol", "HoPo",
]);

function needsQuoting(key: string, value: string): boolean {
    if (NUMERIC_KEYS.has(key)) return false;
    if (value === "None") return false;
    // If it looks like a plain number, don't quote
    if (/^-?\d+(\.\d+)?$/.test(value)) return false;
    return true;
}

function writeTrackSection(section: ChartSection): string {
    const lines = [`[${section.name}]`, "{"];

    for (const ev of section.events) {
        lines.push(`  ${formatEvent(ev)}`);
    }

    lines.push("}");
    return lines.join("\n");
}

function formatEvent(ev: TrackEvent): string {
    if (ev.typeCode === "E") {
        // Text events: quote the value
        return `${ev.position} = E "${ev.values[0] ?? ""}"`;
    }
    const valuePart = ev.values.length > 0 ? " " + ev.values.join(" ") : "";
    return `${ev.position} = ${ev.typeCode}${valuePart}`;
}
