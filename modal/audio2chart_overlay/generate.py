import argparse
import os

from chart import tempo as tempo_utils
from chart.tokenizer import SimpleTokenizerGuitar
from chart import postprocess
from chart.chart_writer import fill_chart


DEFAULT_BPM = 200.0


def build_parser():
    parser = argparse.ArgumentParser(
        description="Convert an audio file into a Guitar Hero-style chart using Charter."
    )

    # Required argument
    parser.add_argument(
        "audio_path",
        type=str,
        help="Path to the input audio file (must be >= 30 seconds)."
    )

    # Optional model + sampling args
    parser.add_argument(
        "--model_name",
        type=str,
        default="3podi/charter-v1.0-40-M-best-acc",
        help="Model identifier or path. (default: 3podi/charter-v1.0-40-M-best-acc)"
    )
    parser.add_argument("--temperature", type=float, default=0.5, help="Sampling temperature.")
    parser.add_argument("--top_k", type=int, default=32, help="Top-k sampling parameter.")

    # Optional metadata
    parser.add_argument("--name", type=str, default=None, help="Song title.")
    parser.add_argument("--artist", type=str, default=None, help="Artist name.")
    parser.add_argument("--album", type=str, default=None, help="Album name.")
    parser.add_argument("--genre", type=str, default=None, help="Genre.")
    parser.add_argument("--charter", type=str, default=None, help="Charter name.")
    parser.add_argument("--bpm", type=float, default=None,
                        help="Tempo you know the song has. With --tempo auto it picks the beat "
                             "octave; with --tempo fixed it is the constant tempo "
                             f"(default: beat-tracked; {DEFAULT_BPM:g} if beats cannot be tracked).")
    parser.add_argument("--resolution", type=int, default=480, help="Chart resolution.")

    # Tempo map and musical snapping
    parser.add_argument(
        "--tempo", choices=["auto", "fixed"], default="auto",
        help="'auto' beat-tracks the audio and writes a matching SyncTrack; "
             "'fixed' writes one constant tempo at --bpm (legacy behaviour)."
    )
    parser.add_argument(
        "--beat-audio", type=str, default=None,
        help="Audio to beat-track instead of the input, normally the full mix when the input "
             "is a single stem (beat tracking on one stem is unreliable)."
    )
    parser.add_argument(
        "--align-phase", action=argparse.BooleanOptionalAction, default=True,
        help="With --tempo fixed, start the constant tempo on the song's first real beat "
             "(a one-beat lead-in marker) instead of at t=0 (default: on)."
    )
    parser.add_argument(
        "--snap-divisions", type=str,
        default=",".join(str(d) for d in tempo_utils.DEFAULT_DIVISIONS),
        help="Comma-separated beat subdivisions notes may snap to (0 disables snapping)."
    )
    parser.add_argument(
        "--snap-tolerance-ms", type=float,
        default=tempo_utils.DEFAULT_SNAP_TOLERANCE_S * 1000,
        help="Maximum distance a note may be moved when snapping."
    )

    # Chart features added on top of the model's raw notes
    parser.add_argument(
        "--difficulties", type=str, default="expert,hard,medium,easy",
        help="Comma-separated difficulties to write. Expert is always written; the "
             "others are reduced from it."
    )
    parser.add_argument(
        "--sustains", action=argparse.BooleanOptionalAction, default=True,
        help="Hold notes through the gap before the next note (default: on)."
    )
    parser.add_argument(
        "--bpm-tolerance", type=float, default=0.015,
        help="With --tempo fixed, how far (as a fraction) the tempo may move from --bpm to "
             "fit the song's real beats; 0 keeps --bpm exactly (default: 0.015)."
    )
    parser.add_argument(
        "--star-power", action=argparse.BooleanOptionalAction, default=True,
        help="Add star power phrases (default: on)."
    )
    parser.add_argument(
        "--sections", choices=["auto", "fixed", "none"], default="auto",
        help="'auto' segments the audio into practice sections, 'fixed' uses "
             "8-measure blocks, 'none' writes no sections."
    )
    parser.add_argument(
        "--unsupported", choices=["drop", "keep"], default="drop",
        help="What to do with a note that has no audio onset within --onset-snap-ms: "
             "'drop' it or 'keep' it where the model put it (default: drop)."
    )
    parser.add_argument(
        "--trim-silence", action=argparse.BooleanOptionalAction, default=True,
        help="Drop notes past the end of the audio or in silence (default: on)."
    )
    parser.add_argument(
        "--onset-snap-ms", type=float, default=60.0,
        help="Move each note onto the audio onset it describes if one is within this many "
             "ms, and drop notes with no onset that close (0 disables; default: 60)."
    )
    parser.add_argument(
        "--fill-onsets-ms", type=float, default=500.0,
        help="Also chart an audible onset the model skipped, using the frets of the nearest "
             "model note if one is within this many ms (0 disables; default: 500)."
    )
    parser.add_argument(
        "--playable", action=argparse.BooleanOptionalAction, default=True,
        help="Thin every track to what a hand can play: strum speed, hand travel and "
             "per-difficulty note rates (default: on)."
    )
    parser.add_argument(
        "--dynamics", action=argparse.BooleanOptionalAction, default=True,
        help="Make the note density follow the loudness of the audio (default: on)."
    )

    # Output path (optional)
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Destination folder for output. Defaults to ./<song_name>/notes.chart"
    )
    return parser


def _build_tempo(args, log):
    """The tempo map the chart is written against: `(tempo_map, sync_events | None)`.

    `--tempo auto` follows the tracked beats. A given `--bpm` is then a hint about which
    octave the beats are in; if the tracker and the hint disagree the chart falls back to
    one constant tempo fitted to `--bpm`, so a confirmed tempo is never overridden.
    `--tempo fixed` is one constant tempo from `--bpm`, aligned to the real beats.
    """
    resolution = args.resolution
    beat_path = args.beat_audio or args.audio_path
    bpm = args.bpm or None

    beat_times = None
    if args.tempo == "auto" or args.align_phase:
        try:
            beat_times, tracked_bpm = tempo_utils.estimate_beats(beat_path)
        except RuntimeError as error:
            log(f"Beat tracking failed ({error}); falling back to fixed {bpm or DEFAULT_BPM} BPM")

    if beat_times is not None and args.tempo == "auto":
        beats = beat_times if bpm is None else tempo_utils.match_beats_to_bpm(beat_times, bpm)
        if beats is not None:
            sync_events = tempo_utils.build_tempo_map(beats, resolution=resolution)
            log(f"Tempo: ~{tracked_bpm:.1f} BPM, "
                f"{len(sync_events)} sync marker(s) from {len(beats)} beats")
            return tempo_utils.TempoMap(sync_events, resolution=resolution), sync_events
        log(f"Tracked tempo ({tracked_bpm:.1f} BPM) disagrees with --bpm {bpm}; "
            f"using a constant tempo fitted to --bpm")

    if beat_times is not None and (bpm or args.tempo == "fixed"):
        try:
            fitted_bpm, phase, fit = tempo_utils.fit_fixed_grid(
                beat_times, bpm or DEFAULT_BPM, tolerance=args.bpm_tolerance)
            sync_events = tempo_utils.fixed_tempo_events(fitted_bpm, phase, resolution)
            log(f"Tempo: fixed {fitted_bpm} BPM (asked for {bpm or DEFAULT_BPM}), first beat at "
                f"{phase * 1000:.0f} ms (beat fit {fit:.2f})")
            return tempo_utils.TempoMap(sync_events, resolution=resolution), sync_events
        except ValueError as error:
            log(f"Beat phase unavailable ({error}); the grid starts at t=0")
    return tempo_utils.fixed_tempo_map(bpm or DEFAULT_BPM, resolution), None


def assemble_chart(seqs, args, grid_ms, pad_token_id, log=print):
    """Turn the model's token sequence into the text of a `.chart` file."""
    tokenizer = SimpleTokenizerGuitar()
    tempo_map, sync_events = _build_tempo(args, log)

    divisions = tuple(
        int(d) for d in args.snap_divisions.split(",") if d.strip() and int(d) > 0
    )
    if divisions:
        log(f"Snapping to 1/{max(divisions)}-beat resolution "
            f"within {args.snap_tolerance_ms:.0f} ms")

    analysis = None
    if args.sustains or args.trim_silence or args.playable or args.onset_snap_ms > 0:
        try:
            analysis = postprocess.load_analysis(args.audio_path)
        except Exception as error:
            log(f"Audio analysis unavailable ({error}); no onset alignment, silence "
                f"trimming or sustains")

    # Notes on the model's time grid, moved onto the audio onsets they describe.
    times, tokens = [], []
    for index, token in enumerate(seqs):
        if token != pad_token_id:
            times.append(index * grid_ms / 1000)
            tokens.append(token)
    if analysis is not None and args.onset_snap_ms > 0:
        before = len(tokens)
        times, tokens = postprocess.align_to_onsets(
            times, tokens, analysis.onsets, tolerance_s=args.onset_snap_ms / 1000.0,
            drop_unsupported=args.unsupported == "drop", fill_s=args.fill_onsets_ms / 1000.0)
        log(f"Onset alignment: {before} model notes -> {len(tokens)} notes on audio onsets")

    ticked_notes = tempo_utils.notes_to_ticks(
        tokens,
        times,
        tempo_map,
        pad_token=pad_token_id,
        divisions=divisions,
        tolerance_s=args.snap_tolerance_ms / 1000.0,
    )
    difficulties = [d.strip().capitalize() for d in args.difficulties.split(",") if d.strip()]
    tracks = postprocess.build_tracks(
        ticked_notes,
        tokenizer,
        tempo_map,
        difficulties=difficulties,
        sustains=args.sustains,
        star_power=args.star_power,
        envelope=analysis.envelope if analysis is not None else None,
        trim_silence=args.trim_silence,
        playable=args.playable,
        dynamics=args.dynamics,
        strength=analysis.strength_at if analysis is not None else None,
        # A tempo map with no tracked beats puts beat one at t=0 (or at the phase it was
        # given); find where the beats really fall from the notes themselves.
        align_to_notes=sync_events is None,
    )
    log("Tracks: " + ", ".join(f"{d} ({sum(1 for n in notes if n[1] == 'N')} notes)"
                               for d, notes in tracks.items()))

    sections = None
    expert_notes = [note[0] for note in tracks["Expert"] if note[1] == "N"]
    last_tick = max(expert_notes, default=0)
    sections_mode = args.sections
    if sections_mode == "auto":
        try:
            sections = postprocess.detect_sections(args.audio_path, tempo_map, last_tick)
        except Exception as error:
            log(f"Section detection failed ({error}); using fixed 8-measure sections")
            sections_mode = "fixed"
    if sections_mode == "fixed":
        sections = postprocess.fixed_sections(tempo_map, last_tick)

    model_tag = args.model_name.split("/")[-1]
    default_charter = args.charter or f"audio2chart/{model_tag}-{args.temperature}-{args.top_k}"
    song_name = args.name or os.path.splitext(os.path.basename(args.audio_path))[0]
    metadata = {
        "name": song_name,
        "artist": args.artist or "audio2chart",
        "album": args.album or "audio2chart",
        "genre": args.genre or "audio2chart",
        "charter": default_charter,
        "bpm": args.bpm or DEFAULT_BPM,
        "resolution": args.resolution
    }
    return fill_chart(tracks, metadata=metadata, sync_events=sync_events, sections=sections)


def main():
    args = build_parser().parse_args()

    # Imported here so the post-processing above stays usable without torch installed.
    import torch
    from inference.engine import Charter

    print(f"Loading model: {args.model_name}")
    model = Charter.from_pretrained(args.model_name)

    print(f"Generating chart for: {args.audio_path}")
    seqs = model.generate(
        args.audio_path,
        temperature=args.temperature,
        top_k=args.top_k
    )
    seqs = torch.cat(seqs).flatten().cpu().tolist()

    filled_text = assemble_chart(
        seqs, args, model.config.grid_ms, model.config.pad_token_id)

    song_name = args.name or os.path.splitext(os.path.basename(args.audio_path))[0]
    output_folder = args.output or os.path.join(os.getcwd(), song_name)
    os.makedirs(output_folder, exist_ok=True)
    output_path = os.path.join(output_folder, "notes.chart")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(filled_text)

    print(f"Chart saved to: {output_path}")


if __name__ == "__main__":
    main()
