/**
 * Base interface for stem splitting APIs (e.g. LALAL.ai, AudioShake).
 *
 * Each implementation defines its own stem literal union via the
 * generic parameter, so supported stems are scoped per-backend.
 */

/** A single stem result containing the stem type and its output path. */
export interface StemResult<S extends string = string> {
    stem: S;
    path: string;
}

/** The result of a split operation. */
export interface SplitResult<S extends string = string> {
    /** The original audio file that was split. */
    sourcePath: string;
    /** The stems that were produced. */
    stems: StemResult<S>[];
}

/** Base interface that any stem splitter must implement. */
export interface StemSplitter<S extends string = string> {
    /** Human-readable name of the splitter backend. */
    readonly name: string;

    /** Returns the set of stems this backend supports. */
    supportedStems(): S[];

    /**
     * Split an audio file into the requested stems.
     *
     * @param audioPath - Path to the source audio file.
     * @param stems     - Which stems to extract. Every entry must be in
     *                    {@link supportedStems}.
     * @returns The split result containing paths to each produced stem file.
     */
    split(audioPath: string, stems: S[]): Promise<SplitResult<S>>;
}
