/**
 * .chart file parser and data types.
 *
 * Parses the text-based .chart format (similar to .ini) into a structured
 * representation.  See Format-Overview.md for the full specification.
 */

// ── Data types ─────────────────────────────────────────────────────────────

/** A key = value entry in the [Song] section. */
export interface SongMeta {
    [key: string]: string;
}

/** A single track event: `<Position> = <TypeCode> <...Values>` */
export interface TrackEvent {
    position: number;
    typeCode: string;
    values: string[];
}

/** A parsed instrument/sync/events section. */
export interface ChartSection {
    name: string;
    events: TrackEvent[];
}

/** Top-level parsed .chart file. */
export interface Chart {
    song: SongMeta;
    syncTrack: ChartSection;
    events: ChartSection;
    /** Instrument track sections, keyed by section name (e.g. "ExpertSingle"). */
    tracks: Map<string, ChartSection>;
}

// ── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parse a .chart file string into a {@link Chart} structure.
 *
 * Handles:
 * - Named entries in [Song] (`Key = Value` or `Key = "Quoted value"`)
 * - Track events in all other sections (`Position = TypeCode Value...`)
 * - Unknown sections are preserved as instrument tracks
 */
export function parseChart(text: string): Chart {
    const song: SongMeta = {};
    let syncTrack: ChartSection = { name: "SyncTrack", events: [] };
    let events: ChartSection = { name: "Events", events: [] };
    const tracks = new Map<string, ChartSection>();

    const sections = parseSections(text);

    for (const [name, lines] of sections) {
        if (name === "Song") {
            for (const line of lines) {
                const match = line.match(/^\s*(\S+)\s*=\s*(.*?)\s*$/);
                if (!match) continue;
                const key = match[1]!;
                let value = match[2]!;
                // Strip surrounding quotes if present
                if (value.startsWith('"') && value.endsWith('"')) {
                    value = value.slice(1, -1);
                }
                song[key] = value;
            }
        } else {
            const section: ChartSection = { name, events: [] };
            for (const line of lines) {
                const ev = parseTrackEvent(line);
                if (ev) section.events.push(ev);
            }

            if (name === "SyncTrack") {
                syncTrack = section;
            } else if (name === "Events") {
                events = section;
            } else {
                tracks.set(name, section);
            }
        }
    }

    return { song, syncTrack, events, tracks };
}

/**
 * Split raw text into named sections, returning an array of [name, lines[]].
 */
function parseSections(text: string): [string, string[]][] {
    const sections: [string, string[]][] = [];
    let currentName: string | null = null;
    let currentLines: string[] = [];
    let insideBraces = false;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();

        // Section header: [SectionName]
        const headerMatch = line.match(/^\[(.+)\]$/);
        if (headerMatch && !insideBraces) {
            currentName = headerMatch[1]!;
            currentLines = [];
            continue;
        }

        if (line === "{") {
            insideBraces = true;
            continue;
        }

        if (line === "}") {
            if (currentName !== null) {
                sections.push([currentName, currentLines]);
            }
            currentName = null;
            currentLines = [];
            insideBraces = false;
            continue;
        }

        if (insideBraces && line.length > 0) {
            currentLines.push(line);
        }
    }

    return sections;
}

/**
 * Parse a single track event line: `Position = TypeCode Value1 Value2 ...`
 *
 * For E (text event) lines the value may be quoted, so we handle that
 * specially to avoid splitting on spaces inside quotes.
 */
function parseTrackEvent(line: string): TrackEvent | null {
    const match = line.match(/^\s*(\d+)\s*=\s*(\S+)\s*(.*?)\s*$/);
    if (!match) return null;

    const position = parseInt(match[1]!, 10);
    const typeCode = match[2]!;
    const rest = match[3]!;

    let values: string[];
    if (typeCode === "E") {
        // Text events: keep the whole value as one entry (may be quoted)
        let text = rest;
        if (text.startsWith('"') && text.endsWith('"')) {
            text = text.slice(1, -1);
        }
        values = [text];
    } else {
        values = rest.split(/\s+/).filter(Boolean);
    }

    return { position, typeCode, values };
}
