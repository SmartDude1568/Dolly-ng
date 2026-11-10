SONG_TEMPLATE = """[Song]
{{
  Name = "{name}"
  Artist = "{artist}"
  Charter = "{charter}"
  Album = "{album}"
  Year = ", {year}"
  Offset = 0
  Resolution = {resolution}
  Player2 = bass
  Difficulty = 3
  PreviewStart = 0
  PreviewEnd = 0
  Genre = "{genre}"
  MediaType = "cd"
  MusicStream = "song.ogg"
}}
"""

DEFAULT_METADATA = {
    "name": "audio2chart",
    "artist": "audio2chart",
    "charter": "audio2chart",
    "album": "audio2chart",
    "genre": "audio2chart",
    "year": "2022",
    "resolution": 480,
    "bpm": 200,
}


def _sync_track(sync_events):
    lines = ["[SyncTrack]", "{", "  0 = TS 4"]
    for tick, bpm_milli in sync_events:
        lines.append(f"  {int(tick)} = B {int(bpm_milli)}")
    lines.append("}")
    return "\n".join(lines)


def _events_block(sections):
    lines = ["[Events]", "{"]
    for tick, text in sorted(sections):
        lines.append(f'  {int(tick)} = E "{text}"')
    lines.append("}")
    return lines


def fill_chart(tracks: dict, metadata: dict, sync_events=None, sections=None) -> str:
    """Render a `.chart` file with one `[<Difficulty>Single]` track per entry.

    `tracks` maps a difficulty name ("Expert", "Hard", ...) to its note tuples.
    `sync_events` is a list of `(tick, bpm_milli)` tuples as produced by
    `chart.tempo.build_tempo_map`. When omitted, the legacy single-marker track at
    `metadata["bpm"]` is written instead. `sections` is a list of
    `(tick, "section <name>")` events written to `[Events]`.
    """
    fields = dict(DEFAULT_METADATA)
    fields.update({key: value for key, value in metadata.items() if value})

    if sync_events is None:
        sync_events = [(0, int(round(float(fields["bpm"]) * 1000)))]
    if not sync_events or sync_events[0][0] != 0:
        raise ValueError("Sync track must contain an event at tick 0")

    lines = [SONG_TEMPLATE.format(**fields), _sync_track(sync_events), ""]
    if sections:
        lines += _events_block(sections) + [""]
    for difficulty, notes in tracks.items():
        note_lines = "\n".join(f"  {t} = {typ} {a} {b}" for (t, typ, a, b) in notes)
        lines += [f"[{difficulty}Single]", "{", note_lines, "}", ""]
    return "\n".join(lines)


def fill_expert_single(notes: list[tuple], metadata: dict, sync_events=None) -> str:
    """Render a single-difficulty (Expert) `.chart` file."""
    return fill_chart({"Expert": notes}, metadata, sync_events=sync_events)
