import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { StemSplitter, SplitResult } from "./split.js";

interface CacheManifest {
    [key: string]: string | undefined;
}

export interface CachedSplitterOptions<S extends string> {
    inner: StemSplitter<S>;
    cacheDir: string;
}

export class CachedSplitter<S extends string> implements StemSplitter<S> {
    readonly name: string;
    private inner: StemSplitter<S>;
    private cacheDir: string;
    private manifestPath: string;

    constructor(options: CachedSplitterOptions<S>) {
        this.inner = options.inner;
        this.cacheDir = options.cacheDir;
        this.name = `${options.inner.name} (cached)`;
        this.manifestPath = path.join(options.cacheDir, "cache-manifest.json");
    }

    supportedStems(): S[] {
        return this.inner.supportedStems();
    }

    async split(audioPath: string, stems: S[]): Promise<SplitResult<S>> {
        const hash = await hashFile(audioPath);
        const manifest = this.loadManifest();

        const cached: { stem: S; path: string }[] = [];
        const uncached: S[] = [];

        for (const stem of stems) {
            const key = `${hash}:${this.inner.name}:${stem}`;
            const cachedPath = manifest[key];
            if (cachedPath && fs.existsSync(cachedPath)) {
                cached.push({ stem, path: cachedPath });
            } else {
                uncached.push(stem);
            }
        }

        if (cached.length > 0) {
            console.log(`Cache hit for stems: ${cached.map(c => c.stem).join(", ")}`);
        }
        if (uncached.length > 0) {
            console.log(`Cache miss for stems: ${uncached.join(", ")}`);
        }

        let freshResults: Map<S, string> = new Map();
        if (uncached.length > 0) {
            const result = await this.inner.split(audioPath, uncached);
            for (const stemResult of result.stems) {
                freshResults.set(stemResult.stem, stemResult.path);
                manifest[`${hash}:${this.inner.name}:${stemResult.stem}`] = stemResult.path;
            }
            this.saveManifest(manifest);
        }

        // Combine results in original stem order
        const combinedStems = stems.map(stem => {
            const cachedEntry = cached.find(c => c.stem === stem);
            if (cachedEntry) {
                return { stem, path: cachedEntry.path };
            }
            const freshPath = freshResults.get(stem);
            if (freshPath) {
                return { stem, path: freshPath };
            }
            throw new Error(`No result for stem "${stem}" — this should not happen`);
        });

        return {
            sourcePath: audioPath,
            stems: combinedStems,
        };
    }

    private loadManifest(): CacheManifest {
        try {
            const data = fs.readFileSync(this.manifestPath, "utf-8");
            return JSON.parse(data) as CacheManifest;
        } catch {
            return {};
        }
    }

    private saveManifest(manifest: CacheManifest): void {
        fs.mkdirSync(this.cacheDir, { recursive: true });
        fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
    }
}

function hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        const stream = fs.createReadStream(filePath);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
    });
}
