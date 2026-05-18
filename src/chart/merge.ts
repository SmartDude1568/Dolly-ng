/**
 * .chart file merger.
 *
 * Combines multiple parsed .chart files into a single chart containing all
 * instrument tracks.  The first chart's [Song], [SyncTrack], and [Events]
 * sections are used as the base; instrument tracks from all charts are
 * collected into the merged output.
 *
 * When two charts contain the same instrument section (e.g. both have
 * [ExpertSingle]), the later chart's version wins by default, or a custom
 * conflict strategy can be provided.
 */

import type { Chart, ChartSection, SongMeta } from "./parse.js";

export type ConflictStrategy = "last-wins" | "first-wins" | "error";

export interface MergeOptions {
    /**
     * How to handle two charts that both define the same instrument section.
     * - "last-wins" (default): the later chart's section replaces the earlier one.
     * - "first-wins": the earlier chart's section is kept.
     * - "error": throw an error on conflict.
     */
    conflictStrategy?: ConflictStrategy;
    /**
     * Optional overrides for [Song] metadata in the merged output.
     * These are applied after selecting the base chart's metadata.
     */
    songOverrides?: Partial<SongMeta>;
}

/**
 * Merge multiple charts into one.
 *
 * @param charts - Two or more parsed Chart objects to merge.
 * @param options - Merge configuration.
 * @returns A new Chart with combined instrument tracks.
 * @throws If fewer than 2 charts are provided, or on conflict when strategy is "error".
 */
export function mergeCharts(charts: Chart[], options: MergeOptions = {}): Chart {
    if (charts.length === 0) {
        throw new Error("mergeCharts requires at least one chart");
    }

    const strategy = options.conflictStrategy ?? "last-wins";
    const base = charts[0]!;

    // Start with the base chart's Song, SyncTrack, and Events
    const mergedSong: SongMeta = { ...base.song };
    const mergedSyncTrack: ChartSection = cloneSection(base.syncTrack);
    const mergedEvents: ChartSection = cloneSection(base.events);
    const mergedTracks = new Map<string, ChartSection>();

    // Copy base tracks
    for (const [name, section] of base.tracks) {
        mergedTracks.set(name, cloneSection(section));
    }

    // Merge subsequent charts' instrument tracks
    for (let i = 1; i < charts.length; i++) {
        const chart = charts[i]!;
        for (const [name, section] of chart.tracks) {
            if (mergedTracks.has(name)) {
                switch (strategy) {
                    case "error":
                        throw new Error(
                            `Conflict: section [${name}] exists in multiple charts (chart index 0 and ${i})`,
                        );
                    case "first-wins":
                        // Keep existing
                        break;
                    case "last-wins":
                        mergedTracks.set(name, cloneSection(section));
                        break;
                }
            } else {
                mergedTracks.set(name, cloneSection(section));
            }
        }
    }

    // Apply song metadata overrides
    if (options.songOverrides) {
        for (const [key, value] of Object.entries(options.songOverrides)) {
            if (value !== undefined) {
                mergedSong[key] = value;
            }
        }
    }

    return {
        song: mergedSong,
        syncTrack: mergedSyncTrack,
        events: mergedEvents,
        tracks: mergedTracks,
    };
}

function cloneSection(section: ChartSection): ChartSection {
    return {
        name: section.name,
        events: section.events.map((e) => ({
            position: e.position,
            typeCode: e.typeCode,
            values: [...e.values],
        })),
    };
}
