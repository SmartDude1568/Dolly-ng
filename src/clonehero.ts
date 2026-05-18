/**
 * Clone Hero installation and songs-directory detection.
 *
 * Checks OS-specific default paths and returns the first one that exists.
 * Returns null if no installation can be found.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const COMPANY = "srylain Inc_";
const APP_NAME = "Clone Hero";
const SONGS_SUBDIR = "Songs";

/**
 * Try to locate the Clone Hero songs directory.
 *
 * Search order:
 *  1. Windows: %LOCALAPPDATA%/../LocalLow/<company>/<app>/Songs
 *  2. macOS:   ~/Library/Application Support/<company>/<app>/Songs
 *  3. Linux:   ~/.config/unity3d/<company>/<app>/Songs
 *              ~/.local/share/<company>/<app>/Songs
 *
 * @returns Absolute path to the Songs directory, or null if not found.
 */
export function findCloneHeroSongsDir(): string | null {
    const home = os.homedir();
    const platform = process.platform;

    let candidates: string[];

    if (platform === "win32") {
        // Unity on Windows writes to LocalLow, not AppData/Local or Roaming.
        const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
        const localLow = path.join(path.dirname(appData), "LocalLow");
        const localApp = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
        candidates = [
            path.join(localLow, COMPANY, APP_NAME, SONGS_SUBDIR),
            path.join(localApp, COMPANY, APP_NAME, SONGS_SUBDIR),
        ];
    } else if (platform === "darwin") {
        candidates = [
            path.join(home, "Library", "Application Support", COMPANY, APP_NAME, SONGS_SUBDIR),
        ];
    } else {
        // Linux / other Unix
        const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
        const xdgData = process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
        candidates = [
            path.join(xdgConfig, "unity3d", COMPANY, APP_NAME, SONGS_SUBDIR),
            path.join(xdgData, COMPANY, APP_NAME, SONGS_SUBDIR),
        ];
    }

    for (const dir of candidates) {
        if (fs.existsSync(dir)) {
            return dir;
        }
    }

    return null;
}

/**
 * Ensure the given directory exists; create it (and parents) if not.
 */
export function ensureSongsDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}

/**
 * Copy a .sng file into the Clone Hero songs directory.
 *
 * @param sngPath     Path to the .sng file to copy.
 * @param songsDir    Destination songs directory (from findCloneHeroSongsDir).
 * @returns           Final path of the copied file.
 */
export function installSng(sngPath: string, songsDir: string): string {
    ensureSongsDir(songsDir);
    const filename = path.basename(sngPath);
    const dest = path.join(songsDir, filename);
    fs.copyFileSync(sngPath, dest);
    return dest;
}
