#!/usr/bin/env python3
"""Identify a song with Shazam (via the ShazamIO client) and print its metadata as JSON.

Usage:  identify_song.py <audio.wav>

Prints one JSON object on stdout, or the literal `null` when Shazam has no match:
    {"title": ..., "artist": ..., "album": ..., "genre": ..., "year": ..., "cover_url": ...}
Any field Shazam does not provide is omitted. Exit status is non-zero (message on stderr)
when the lookup itself failed (network error, unreadable audio, shazamio not installed).

Dolly cuts a short mono 44.1 kHz WAV snippet with ffmpeg first, so this script never has to
decode arbitrary formats (ShazamIO's own decoder rejects some, e.g. AAC in .m4a).

Install:  pip install shazamio
"""

import asyncio
import json
import re
import sys


def metadata_value(track, wanted):
    """Text of the first SONG-section metadata row titled `wanted` (e.g. "Album"), or None."""
    for section in track.get("sections") or []:
        if section.get("type") != "SONG":
            continue
        for row in section.get("metadata") or []:
            if row.get("title") == wanted and row.get("text"):
                return row["text"]
    return None


def summarize(result):
    track = (result or {}).get("track")
    if not track or not track.get("title") or not track.get("subtitle"):
        return None
    summary = {"title": track["title"], "artist": track["subtitle"]}

    album = metadata_value(track, "Album")
    if album:
        summary["album"] = album

    genre = (track.get("genres") or {}).get("primary")
    if genre:
        summary["genre"] = genre

    released = metadata_value(track, "Released")
    year = re.search(r"\d{4}", released or "")
    if year:
        summary["year"] = year.group(0)

    images = track.get("images") or {}
    cover = images.get("coverarthq") or images.get("coverart")
    if cover:
        summary["cover_url"] = cover
    return summary


async def recognize(path):
    from shazamio import Shazam

    return await Shazam().recognize(path)


def main(argv):
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        result = asyncio.run(recognize(argv[1]))
    except Exception as error:  # noqa: BLE001 - report any failure to the caller as text
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(json.dumps(summarize(result)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
