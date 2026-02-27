import * as path from "node:path";
import type { StemSplitter, SplitResult } from "../split.js";

export type DummyStem =
    | "vocals"
    | "instrumental"
    | "drums"
    | "bass"
    | "guitar"
    | "piano"
    | "other";

const SUPPORTED_STEMS: DummyStem[] = [
    "vocals",
    "instrumental",
    "drums",
    "bass",
    "guitar",
    "piano",
    "other",
];

/**
 * Dummy stem splitter that doesn't perform any real processing.
 * Useful for testing pipelines without hitting a real API.
 *
 * For each requested stem it returns a fabricated output path
 * under a configurable output directory.
 */
export class DummySplitter implements StemSplitter<DummyStem> {
    readonly name = "dummy";
    private outputDir: string;

    constructor(outputDir: string) {
        this.outputDir = outputDir;
    }

    supportedStems(): DummyStem[] {
        return SUPPORTED_STEMS;
    }

    async split(audioPath: string, stems: DummyStem[]): Promise<SplitResult<DummyStem>> {
        const unsupported = stems.filter(s => !SUPPORTED_STEMS.includes(s));
        if (unsupported.length > 0) {
            throw new Error(
                `Unsupported stems: ${unsupported.join(", ")}`,
            );
        }

        const baseName = path.basename(audioPath, path.extname(audioPath));

        return {
            sourcePath: audioPath,
            stems: stems.map(stem => ({
                stem,
                path: path.join(this.outputDir, `${baseName}_${stem}.wav`),
            })),
        };
    }
}
