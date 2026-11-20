/**
 * Song identification: ask Shazam what a song is, so Dolly can fill in the chart's
 * title / artist / album / genre / year and ship the album cover inside the .sng.
 *
 * Shazam has no official public API, so this uses the open-source ShazamIO client through
 * `scripts/identify_song.py`. A short mono WAV snippet is cut with the bundled ffmpeg first
 * (ShazamIO's own decoder rejects some formats), then handed to the script. Everything here
 * is best-effort: no Python, no shazamio, no network, no match, a bad cover image — each
 * yields `null`/no cover, and the caller carries on with its defaults. Identification must
 * never be able to fail a conversion.
 *
 * Environment:
 *   SONG_IDENTIFY=off   disable identification entirely
 *   SHAZAM_PYTHON       Python interpreter that has `shazamio` installed (default `python3`)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
// ffmpeg-static exports the binary path (CJS `export =`).
const FFMPEG_PATH: string = require("ffmpeg-static");

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/identify_song.py", import.meta.url));

/** Where in the song the snippet starts, and how long it is. Shazam needs a few seconds. */
const SNIPPET_START_SEC = 20;
const SNIPPET_LENGTH_SEC = 12;
const SHAZAM_TIMEOUT_MS = 90_000;
const COVER_TIMEOUT_MS = 15_000;
const MAX_COVER_BYTES = 5 * 1024 * 1024;
/** Apple's image CDN serves any size; the default Shazam URL is a small 400x400. */
const COVER_SIZE = 1000;

/** What Shazam says the song is. Every field but title/artist may be absent. */
export interface SongMatch {
    title: string;
    artist: string;
    album?: string | undefined;
    genre?: string | undefined;
    year?: string | undefined;
    coverUrl?: string | undefined;
}

/** Album art ready to be packed into the .sng (Clone Hero reads album.png / album.jpg). */
export interface CoverArt {
    name: "album.jpg" | "album.png";
    data: Buffer;
}

/** A matched song plus its downloaded cover, if one could be fetched. */
export interface SongIdentity {
    title: string;
    artist: string;
    album?: string | undefined;
    genre?: string | undefined;
    year?: string | undefined;
    cover?: CoverArt | undefined;
}

/** Song fields the user typed in; each one, when present, beats the identified value. */
export interface UserSongMetadata {
    title?: string | undefined;
    artist?: string | undefined;
    album?: string | undefined;
    genre?: string | undefined;
    year?: string | undefined;
}

/** The final, fully-resolved song fields written to notes.chart and the .sng metadata. */
export interface ResolvedSongMetadata {
    title: string;
    artist: string;
    album: string;
    genre: string;
    year?: string | undefined;
}

/** What Dolly used before identification existed; kept as the fallback for unknown songs. */
export const DEFAULT_SONG_FIELDS = { artist: "Dolly", album: "audio2chart", genre: "Rock" } as const;

/**
 * `.chart` [Song] values are written as `Key = "value"` with no escaping, so a `"` or a
 * newline in a title would corrupt the section. Collapse all whitespace (incl. newlines) to
 * single spaces and turn double quotes into single quotes.
 */
export const cleanText = (v: string): string => v.replace(/\s+/g, " ").replace(/"/g, "'").trim();

const nonEmpty = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const c = cleanText(v);
    return c === "" ? undefined : c;
};

const USER_META_KEYS = ["title", "artist", "album", "genre", "year"] as const;

/**
 * Validate the optional `metadata` object a client may send with a conversion. Fields are
 * strings of 1-200 characters (year: four digits); unknown keys are rejected so a typo does
 * not silently do nothing. `undefined`/`null` means "nothing typed".
 */
export function validateUserSongMetadata(
    raw: unknown,
): { ok: true; value: UserSongMetadata | undefined } | { ok: false; message: string } {
    if (raw === undefined || raw === null) return { ok: true, value: undefined };
    if (typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, message: "metadata must be an object" };
    }
    const out: UserSongMetadata = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!(USER_META_KEYS as readonly string[]).includes(key)) {
            return { ok: false, message: `metadata.${key} is not a supported field (${USER_META_KEYS.join(", ")})` };
        }
        if (typeof value !== "string") return { ok: false, message: `metadata.${key} must be a string` };
        const v = cleanText(value);
        if (v === "") continue; // blank = "let Shazam fill it"
        if (v.length > 200) return { ok: false, message: `metadata.${key} must be at most 200 characters` };
        if (key === "year" && !/^\d{4}$/.test(v)) return { ok: false, message: "metadata.year must be a 4-digit year" };
        out[key as (typeof USER_META_KEYS)[number]] = v;
    }
    return { ok: true, value: Object.keys(out).length > 0 ? out : undefined };
}

/**
 * Validate the script's JSON. Returns null for Shazam's "no match" (`null`) and for any
 * payload that is not an object with a title and an artist.
 */
export function parseMatch(raw: unknown): SongMatch | null {
    if (raw === null || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const title = nonEmpty(o.title);
    const artist = nonEmpty(o.artist);
    if (!title || !artist) return null;
    const year = nonEmpty(o.year);
    return {
        title,
        artist,
        album: nonEmpty(o.album),
        genre: nonEmpty(o.genre),
        year: year && /^\d{4}$/.test(year) ? year : undefined,
        coverUrl: nonEmpty(o.cover_url),
    };
}

/**
 * Merge song fields. Precedence per field: what the user typed, then what Shazam found,
 * then Dolly's old defaults. `fallbackTitle` (the uploaded filename) is used only when
 * neither the user nor Shazam gave a title.
 */
export function resolveSongMetadata(
    user: UserSongMetadata | undefined,
    identity: SongIdentity | null,
    fallbackTitle: string,
): ResolvedSongMetadata {
    // Every source goes through nonEmpty (cleanText) so nothing unsafe reaches notes.chart,
    // including the file name and identities that did not come through parseMatch.
    const year = nonEmpty(user?.year) ?? nonEmpty(identity?.year);
    return {
        title: nonEmpty(user?.title) ?? nonEmpty(identity?.title) ?? nonEmpty(fallbackTitle) ?? "Dolly Song",
        artist: nonEmpty(user?.artist) ?? nonEmpty(identity?.artist) ?? DEFAULT_SONG_FIELDS.artist,
        album: nonEmpty(user?.album) ?? nonEmpty(identity?.album) ?? DEFAULT_SONG_FIELDS.album,
        genre: nonEmpty(user?.genre) ?? nonEmpty(identity?.genre) ?? DEFAULT_SONG_FIELDS.genre,
        year,
    };
}

/** Swap the size segment of an Apple image URL (`.../400x400cc.jpg`) for a larger one. */
export function enlargeCoverUrl(url: string, size = COVER_SIZE): string {
    return url.replace(/\/\d+x\d+(cc|bb)?\.(jpg|png)$/i, (_m, mode: string | undefined, ext: string) =>
        `/${size}x${size}${mode ?? "cc"}.${ext}`,
    );
}

/** JPEG or PNG by magic bytes; anything else (HTML error page, WebP, …) is not usable. */
function imageName(data: Buffer): CoverArt["name"] | null {
    if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "album.jpg";
    if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return "album.png";
    }
    return null;
}

async function downloadImage(url: string, fetchFn: typeof fetch): Promise<CoverArt | null> {
    if (!url.startsWith("https://")) return null;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(COVER_TIMEOUT_MS) });
    if (!res.ok) return null;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_COVER_BYTES) return null;
    const name = imageName(data);
    return name ? { name, data } : null;
}

/**
 * Download the cover image. Tries a larger rendition first and falls back to the URL as
 * given. Returns null on any failure (non-https, HTTP error, too big, not a JPEG/PNG).
 */
export async function fetchCoverArt(url: string, fetchFn: typeof fetch = fetch): Promise<CoverArt | null> {
    const large = enlargeCoverUrl(url);
    for (const candidate of large === url ? [url] : [large, url]) {
        try {
            const cover = await downloadImage(candidate, fetchFn);
            if (cover) return cover;
        } catch {
            /* try the next candidate */
        }
    }
    return null;
}

/** Cut a short mono 44.1 kHz WAV out of the song. */
async function cutSnippet(audioPath: string, outWav: string): Promise<void> {
    await execFileAsync(
        FFMPEG_PATH,
        [
            "-y", "-v", "error",
            "-ss", String(SNIPPET_START_SEC), "-t", String(SNIPPET_LENGTH_SEC),
            "-i", audioPath,
            "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", outWav,
        ],
        { timeout: 60_000 },
    );
}

export interface IdentifyOptions {
    /** Directory for the temporary snippet. */
    workDir: string;
    /** Interpreter with shazamio installed. Default: $SHAZAM_PYTHON or `python3`. */
    pythonBin?: string | undefined;
    /** Script to run. Default: scripts/identify_song.py. */
    scriptPath?: string | undefined;
    fetchFn?: typeof fetch | undefined;
}

/** Whether identification is switched off via SONG_IDENTIFY=off. */
export function identificationEnabled(): boolean {
    return (process.env.SONG_IDENTIFY ?? "").toLowerCase() !== "off";
}

/**
 * Identify the song in `audioPath`. Returns the match with its cover art, or null when
 * identification is disabled or Shazam has no match. THROWS on infrastructure failures
 * (ffmpeg error, Python or shazamio missing, network down) so the caller can log why;
 * callers must treat a throw as "unknown song", never as a conversion failure.
 */
export async function identifySong(audioPath: string, opts: IdentifyOptions): Promise<SongIdentity | null> {
    if (!identificationEnabled()) return null;

    fs.mkdirSync(opts.workDir, { recursive: true });
    const snippet = path.join(opts.workDir, "identify_snippet.wav");
    try {
        await cutSnippet(audioPath, snippet);
        const python = opts.pythonBin ?? process.env.SHAZAM_PYTHON ?? "python3";
        let stdout: string;
        try {
            ({ stdout } = await execFileAsync(python, [opts.scriptPath ?? SCRIPT_PATH, snippet], {
                timeout: SHAZAM_TIMEOUT_MS,
                maxBuffer: 1024 * 1024,
            }));
        } catch (err) {
            // Node's message is just "Command failed: …"; the useful part (e.g. a missing
            // `shazamio` module) is the script's last stderr line.
            const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim().split("\n").pop();
            throw new Error(stderr || (err instanceof Error ? err.message : String(err)));
        }
        const match = parseMatch(JSON.parse(stdout));
        if (!match) return null;

        const cover = match.coverUrl ? await fetchCoverArt(match.coverUrl, opts.fetchFn) : null;
        return {
            title: match.title,
            artist: match.artist,
            album: match.album,
            genre: match.genre,
            year: match.year,
            cover: cover ?? undefined,
        };
    } finally {
        fs.rmSync(snippet, { force: true });
    }
}

// ── Per-conversion cache ────────────────────────────────────────────────

interface CachedIdentity {
    /** null = Shazam was asked and had no match; don't ask again on resume. */
    match: Omit<SongIdentity, "cover"> | null;
    coverFile?: string;
}

const CACHE_FILE = "song_identity.json";

/**
 * Look the song up once per conversion and remember the answer (including "no match") in
 * `workDir`, so a resumed conversion neither repeats the network lookup nor changes its
 * metadata between runs. Lookup failures are NOT cached: a retry may succeed.
 */
export async function identifyWithCache(
    lookup: () => Promise<SongIdentity | null>,
    workDir: string,
    log: (msg: string) => void,
): Promise<SongIdentity | null> {
    const cachePath = path.join(workDir, CACHE_FILE);
    if (fs.existsSync(cachePath)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as CachedIdentity;
            if (cached.match === null) return null;
            const identity: SongIdentity = { ...cached.match };
            if (cached.coverFile) {
                const coverPath = path.join(workDir, cached.coverFile);
                if (fs.existsSync(coverPath)) {
                    identity.cover = { name: cached.coverFile as CoverArt["name"], data: fs.readFileSync(coverPath) };
                }
            }
            log(`using cached song identity: ${identity.artist} - ${identity.title}`);
            return identity;
        } catch {
            /* unreadable cache: look the song up again */
        }
    }

    let identity: SongIdentity | null;
    try {
        identity = await lookup();
    } catch (err) {
        log(`song identification unavailable (${err instanceof Error ? err.message.split("\n")[0] : err}); using defaults`);
        return null;
    }

    const { cover, ...match } = identity ?? { cover: undefined };
    try {
        fs.mkdirSync(workDir, { recursive: true });
        const record: CachedIdentity = { match: identity ? (match as Omit<SongIdentity, "cover">) : null };
        if (cover) {
            fs.writeFileSync(path.join(workDir, cover.name), cover.data);
            record.coverFile = cover.name;
        }
        fs.writeFileSync(cachePath, JSON.stringify(record), "utf8");
    } catch (err) {
        // The cache only saves a repeat lookup on resume; failing to write it is not an error.
        log(`could not cache song identity (${err instanceof Error ? err.message : err})`);
    }

    if (identity) log(`identified: ${identity.artist} - ${identity.title}${cover ? " (with cover art)" : ""}`);
    else log("song not recognised; using defaults");
    return identity;
}
