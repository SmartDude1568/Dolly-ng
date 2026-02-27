#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { DummySplitter, type DummyStem } from "./split/dummy.js";
import { LalalSplitter, type LalalStem } from "./split/lalal.js";
import type { StemSplitter } from "./split.js";
import { CachedSplitter } from "./cache.js";
import { Audio2Chart } from "./chart.js";

interface CliOptions {
    audioFile: string;
    splitter: "dummy" | "lalal";
    stems: string[];
    outputDir: string;
    apiKey?: string;
    cacheDir?: string;
    noCache?: boolean;
    chart?: boolean;
    chartVendor?: string;
    modelName?: string;
    temperature?: number;
    topK?: number;
    songName?: string;
    songArtist?: string;
    songGenre?: string;
    charterName?: string;
}

function printUsage(): void {
    console.log(`
Dolly - Audio Stem Splitter CLI

Usage:
  npx tsx src/index.ts <audio-file> [options]

Options:
  --splitter <name>   Splitter to use: dummy, lalal (default: dummy)
  --stems <list>      Comma-separated list of stems to extract
  --output <dir>      Output directory (default: ./output)
  --api-key <key>     API key for lalal splitter (or set LALAL_API_KEY env var)
  --cache-dir <dir>   Cache directory (default: <output>/.cache)
  --no-cache          Disable caching
  --list-stems        List available stems for the selected splitter
  --chart             Enable chart generation after splitting
  --chart-vendor <dir> Where to install audio2chart (default: ./vendor)
  --model-name <name> HuggingFace model for chart generation
  --temperature <f>   Sampling temperature for chart generation
  --top-k <int>       Top-k filtering for chart generation
  --song-name <name>  Song name for chart metadata
  --song-artist <name> Artist name for chart metadata
  --song-genre <name> Genre for chart metadata
  --charter-name <name> Charter name for chart metadata
  --help              Show this help message

Examples:
  # List available stems for dummy splitter
  npx tsx src/index.ts --splitter dummy --list-stems

  # Split with dummy splitter
  npx tsx src/index.ts song.mp3 --splitter dummy --stems vocals,drums --output ./out

  # Split with lalal splitter
  npx tsx src/index.ts song.mp3 --splitter lalal --stems vocals,drum --api-key YOUR_KEY

  # Split and generate charts
  npx tsx src/index.ts song.mp3 --splitter dummy --stems vocals --chart
`);
}

function parseArgs(args: string[]): CliOptions & { listStems?: boolean; help?: boolean } {
    const options: CliOptions & { listStems?: boolean; help?: boolean } = {
        audioFile: "",
        splitter: "dummy",
        stems: [],
        outputDir: "./output",
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;

        if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else if (arg === "--splitter") {
            const value = args[++i];
            if (value !== "dummy" && value !== "lalal") {
                console.error(`Error: Unknown splitter "${value}". Use "dummy" or "lalal".`);
                process.exit(1);
            }
            options.splitter = value;
        } else if (arg === "--stems") {
            const value = args[++i];
            if (!value) {
                console.error("Error: --stems requires a value");
                process.exit(1);
            }
            options.stems = value.split(",").map(s => s.trim());
        } else if (arg === "--output") {
            const value = args[++i];
            if (!value) {
                console.error("Error: --output requires a value");
                process.exit(1);
            }
            options.outputDir = value;
        } else if (arg === "--api-key") {
            const value = args[++i];
            if (!value) {
                console.error("Error: --api-key requires a value");
                process.exit(1);
            }
            options.apiKey = value;
        } else if (arg === "--cache-dir") {
            const value = args[++i];
            if (!value) {
                console.error("Error: --cache-dir requires a value");
                process.exit(1);
            }
            options.cacheDir = value;
        } else if (arg === "--no-cache") {
            options.noCache = true;
        } else if (arg === "--chart") {
            options.chart = true;
        } else if (arg === "--chart-vendor") {
            const value = args[++i];
            if (!value) {
                console.error("Error: --chart-vendor requires a value");
                process.exit(1);
            }
            options.chartVendor = value;
        } else if (arg === "--model-name") {
            const value = args[++i];
            if (!value) {
                console.error("Error: --model-name requires a value");
                process.exit(1);
            }
            options.modelName = value;
        } else if (arg === "--temperature") {
            const value = args[++i];
            if (!value) {
                console.error("Error: --temperature requires a value");
                process.exit(1);
            }
            options.temperature = parseFloat(value);
        } else if (arg === "--top-k") {
            const value = args[++i];
            if (!value) {
                console.error("Error: --top-k requires a value");
                process.exit(1);
            }
            options.topK = parseInt(value, 10);
        } else if (arg === "--song-name") {
            const value = args[++i];
            if (!value) {
                console.error("Error: --song-name requires a value");
                process.exit(1);
            }
            options.songName = value;
        } else if (arg === "--song-artist") {
            const value = args[++i];
            if (!value) {
                console.error("Error: --song-artist requires a value");
                process.exit(1);
            }
            options.songArtist = value;
        } else if (arg === "--song-genre") {
            const value = args[++i];
            if (!value) {
                console.error("Error: --song-genre requires a value");
                process.exit(1);
            }
            options.songGenre = value;
        } else if (arg === "--charter-name") {
            const value = args[++i];
            if (!value) {
                console.error("Error: --charter-name requires a value");
                process.exit(1);
            }
            options.charterName = value;
        } else if (arg === "--list-stems") {
            options.listStems = true;
        } else if (!arg.startsWith("-") && !options.audioFile) {
            options.audioFile = arg;
        } else {
            console.error(`Error: Unknown argument "${arg}"`);
            process.exit(1);
        }
    }

    return options;
}

function getSupportedStems(splitterName: "dummy" | "lalal"): string[] {
    switch (splitterName) {
        case "dummy":
            return new DummySplitter("").supportedStems();
        case "lalal":
            return new LalalSplitter({ apiKey: "", outputDir: "" }).supportedStems();
    }
}

function createSplitter(
    splitterName: "dummy" | "lalal",
    outputDir: string,
    apiKey?: string,
): StemSplitter {
    switch (splitterName) {
        case "dummy":
            return new DummySplitter(outputDir);
        case "lalal": {
            const key = apiKey ?? process.env.LALAL_API_KEY;
            if (!key) {
                console.error("Error: LALAL splitter requires an API key.");
                console.error("Provide --api-key or set LALAL_API_KEY environment variable.");
                process.exit(1);
            }
            return new LalalSplitter({ apiKey: key, outputDir });
        }
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        printUsage();
        process.exit(0);
    }

    const options = parseArgs(args);

    if (options.help) {
        printUsage();
        process.exit(0);
    }

    if (options.listStems) {
        console.log(`Available stems for "${options.splitter}" splitter:`);
        for (const stem of getSupportedStems(options.splitter)) {
            console.log(`  - ${stem}`);
        }
        process.exit(0);
    }

    // Create splitter for processing
    let splitter: StemSplitter = createSplitter(
        options.splitter,
        options.outputDir,
        options.apiKey,
    );

    if (!options.noCache) {
        const cacheDir = options.cacheDir ?? path.join(options.outputDir, ".cache");
        splitter = new CachedSplitter({ inner: splitter, cacheDir });
    }

    // Validate audio file
    if (!options.audioFile) {
        console.error("Error: No audio file specified.");
        printUsage();
        process.exit(1);
    }

    if (!fs.existsSync(options.audioFile)) {
        console.error(`Error: Audio file not found: ${options.audioFile}`);
        process.exit(1);
    }

    // Validate stems
    if (options.stems.length === 0) {
        console.error("Error: No stems specified. Use --stems to specify which stems to extract.");
        console.log(`Available stems: ${splitter.supportedStems().join(", ")}`);
        process.exit(1);
    }

    const supportedStems = splitter.supportedStems();
    const invalidStems = options.stems.filter(s => !supportedStems.includes(s));
    if (invalidStems.length > 0) {
        console.error(`Error: Invalid stems: ${invalidStems.join(", ")}`);
        console.log(`Available stems: ${supportedStems.join(", ")}`);
        process.exit(1);
    }

    // Ensure output directory exists
    if (!fs.existsSync(options.outputDir)) {
        fs.mkdirSync(options.outputDir, { recursive: true });
    }

    // Perform split
    const audioPath = path.resolve(options.audioFile);
    console.log(`Splitting: ${audioPath}`);
    console.log(`Splitter:  ${splitter.name}`);
    console.log(`Stems:     ${options.stems.join(", ")}`);
    console.log(`Output:    ${path.resolve(options.outputDir)}`);
    console.log();

    try {
        const result = await splitter.split(audioPath, options.stems);

        console.log("Split complete! Output files:");
        for (const stemResult of result.stems) {
            console.log(`  ${stemResult.stem}: ${stemResult.path}`);
        }

        // Chart generation
        if (options.chart) {
            console.log("\nGenerating charts...");
            const chartGenerator = new Audio2Chart({
                vendorDir: options.chartVendor ?? "./vendor",
                outputDir: options.outputDir,
                modelName: options.modelName,
                temperature: options.temperature,
                topK: options.topK,
                name: options.songName,
                artist: options.songArtist,
                genre: options.songGenre,
                charter: options.charterName,
            });

            for (const stemResult of result.stems) {
                try {
                    const chartResult = await chartGenerator.generate(stemResult.path);
                    console.log(`  ${stemResult.stem}: ${chartResult.chartPath}`);
                } catch (chartError) {
                    console.error(
                        `  Error generating chart for ${stemResult.stem}:`,
                        chartError instanceof Error ? chartError.message : chartError,
                    );
                }
            }
        }
    } catch (error) {
        console.error("Error during split:", error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

main();
