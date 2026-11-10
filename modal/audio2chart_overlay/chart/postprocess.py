"""Rule-based post-processing that turns raw model output into a fuller chart.

The released model only predicts *which frets are hit when* on a 40 ms grid. Everything
else a player expects from a Clone Hero chart - sustains, star power, sections and
easier difficulties - is added here from the decoded notes, the tempo map and,
optionally, the audio. None of it needs a retrain.

Notes are handled as `Group`s (one per onset). `build_tracks` is the entry point: it takes
the `(tick, token, duration, attrs)` tuples from `chart.tempo.notes_to_ticks` and returns
the decoded `.chart` note lines for each requested difficulty.
"""

import bisect
import math
from dataclasses import dataclass, replace

DIFFICULTIES = ("Expert", "Hard", "Medium", "Easy")
OPEN = 7

# scan-chart flags notes <= 15 ms apart as `brokenNote`; stay clear of that.
MIN_NOTE_GAP_S = 0.020

# Fraction of a difficulty's minimum note gap that still counts as meeting it.
GAP_SLACK = 0.9


@dataclass(frozen=True)
class Group:
    """All notes sharing one onset tick."""

    tick: int
    lanes: tuple
    length: int = 0
    star: bool = False


@dataclass(frozen=True)
class DifficultyRule:
    """How an easier difficulty is carved out of Expert."""

    min_gap_beats: float
    min_gap_s: float
    max_chord: int
    lane_map: dict


# Easier tracks keep fewer, more widely spaced notes on fewer frets. Gaps are enforced
# in both beats and seconds so a fast song still gets a playable Easy.
RULES = {
    "Hard": DifficultyRule(0.25, 0.10, 3, {0: 0, 1: 1, 2: 2, 3: 3, 4: 4}),
    "Medium": DifficultyRule(0.5, 0.22, 2, {0: 0, 1: 1, 2: 2, 3: 2, 4: 3}),
    "Easy": DifficultyRule(1.0, 0.45, 1, {0: 0, 1: 1, 2: 1, 3: 2, 4: 2}),
}


# ---------------------------------------------------------------------------
# Token <-> Group conversion
# ---------------------------------------------------------------------------

def to_groups(ticked_notes, tokenizer):
    """`(tick, token, duration, attrs)` tuples -> `Group`s."""
    return [
        Group(int(tick), tuple(tokenizer.reverse_map[token]), int(duration), bool(attrs.get("isS", False)))
        for tick, token, duration, attrs in ticked_notes
    ]


def to_ticked(groups, tokenizer):
    """`Group`s -> the tuple form `SimpleTokenizerGuitar.decode` consumes."""
    attrs = {"is5": False, "is6": False}
    return [
        (g.tick, tokenizer.mapping_noteseqs2int[tuple(sorted(g.lanes))], g.length, {**attrs, "isS": g.star})
        for g in groups
    ]


# ---------------------------------------------------------------------------
# Clean-up
# ---------------------------------------------------------------------------

def sanitize(groups, tempo_map):
    """Fix the unplayable shapes snapping and sampling can leave behind.

    - A 5-fret chord is `invalidChord`; drop its lowest fret.
    - Onsets under `MIN_NOTE_GAP_S` apart are `brokenNote`. They are the same onset
      smeared across two grid slots, so merge them into one chord when that stays a
      valid chord, otherwise drop the later note.
    """
    cleaned = []
    for group in groups:
        lanes = group.lanes[1:] if len(group.lanes) == 5 else group.lanes
        previous = cleaned[-1] if cleaned else None
        if previous is not None:
            gap = tempo_map.tick_to_seconds(group.tick) - tempo_map.tick_to_seconds(previous.tick)
            if gap < MIN_NOTE_GAP_S and (OPEN in lanes) == (OPEN in previous.lanes):
                merged = tuple(sorted(set(previous.lanes) | set(lanes)))
                if OPEN not in merged and len(merged) <= 4:
                    cleaned[-1] = replace(previous, lanes=merged)
                continue
        cleaned.append(replace(group, lanes=lanes))
    return cleaned


# ---------------------------------------------------------------------------
# Difficulty reduction
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Grid:
    """The beat grid notes are judged against: where beats fall and how loosely.

    `phase` is the tick of a beat modulo the resolution, `tolerance` how many ticks a note
    may sit from a grid point and still count as on it. Notes straight from the model sit
    on a 40 ms grid rather than the musical one, so exact tick equality would call almost
    every note off-beat.
    """

    resolution: int
    phase: int = 0
    tolerance: int = 0

    def strength(self, tick):
        """How metrically important a tick is: beat > half beat > 16th/triplet > other."""
        offset = (tick - self.phase) % self.resolution

        def near(step):
            distance = offset % step
            return min(distance, step - distance) <= self.tolerance

        if near(self.resolution):
            return 3
        if near(self.resolution // 2):
            return 2
        if near(self.resolution // 4) or near(self.resolution // 3):
            return 1
        return 0


def default_grid(tempo_map, phase=0, tolerance_s=0.03):
    """A `Grid` whose tolerance is `tolerance_s` at the opening tempo (capped at 1/12 beat)."""
    ticks = int(round(tempo_map.seconds_to_tick(tolerance_s)))
    return Grid(tempo_map.resolution, phase, max(1, min(ticks, tempo_map.resolution // 12)))


def estimate_grid_phase(groups, tempo_map, min_notes=16):
    """Find where the beats fall when the tempo map is a fixed BPM from tick 0.

    A constant-BPM chart assumes beat one sits at t=0, but songs rarely start on the
    beat, so the grid is offset. Pick the offset that puts the most notes on beats, then
    half beats, then 16ths. Returns a tick in `[0, resolution)`; 0 when there are too few
    notes to say.
    """
    if len(groups) < min_notes:
        return 0
    base = default_grid(tempo_map)
    step = max(1, base.tolerance // 2)
    best_phase, best_score = 0, -1
    for phase in range(0, base.resolution, step):
        grid = Grid(base.resolution, phase, base.tolerance)
        score = sum(grid.strength(g.tick) for g in groups)
        if score > best_score:
            best_phase, best_score = phase, score
    return best_phase


def _reduce_lanes(lanes, rule):
    if lanes == (OPEN,):
        return lanes
    mapped = sorted({rule.lane_map[lane] for lane in lanes if lane in rule.lane_map})
    if not mapped:
        return None
    if 0 in mapped and 4 in mapped:  # Hard forbids green+orange
        mapped.remove(0)
    if 0 in mapped and 3 in mapped and rule.max_chord <= 2:  # Medium forbids green+blue
        mapped.remove(0)
    return tuple(mapped[-rule.max_chord:])


def reduce_groups(groups, tempo_map, difficulty, grid=None):
    """Derive the next easier track from the groups of the track above it.

    Notes are admitted strongest-beat-first, so downbeats survive and off-beat filler is
    what gets dropped; a note is only admitted if it is far enough from every note already
    kept. Lanes are then squeezed into the difficulty's fret range.
    """
    grid = grid or default_grid(tempo_map)
    rule = RULES[difficulty]
    resolution = tempo_map.resolution
    # Snapping leaves onsets a tick or two off their grid points, so a note exactly one
    # unit from the last would otherwise miss the threshold by a tick and be dropped.
    min_ticks = int(resolution * rule.min_gap_beats * GAP_SLACK)
    times = [tempo_map.tick_to_seconds(g.tick) for g in groups]

    order = sorted(range(len(groups)),
                   key=lambda i: (-grid.strength(groups[i].tick), -len(groups[i].lanes), i))
    kept = []  # sorted list of indices into `groups`
    kept_ticks = []
    for i in order:
        tick = groups[i].tick
        pos = bisect.bisect_left(kept_ticks, tick)
        neighbours = [j for j in (pos - 1, pos) if 0 <= j < len(kept)]
        if all(abs(tick - kept_ticks[j]) >= min_ticks
               and abs(times[i] - times[kept[j]]) >= rule.min_gap_s * GAP_SLACK for j in neighbours):
            kept.insert(pos, i)
            kept_ticks.insert(pos, tick)

    reduced = []
    for i in kept:
        lanes = _reduce_lanes(groups[i].lanes, rule)
        if lanes:
            reduced.append(Group(groups[i].tick, lanes))

    # A track with every note of the one above it is no easier, and enchor.us flags an
    # exact copy as `difficultyNotReduced`. That happens on gentle material where no rule
    # above bites, so thin out every other note on the weakest beat position.
    unchanged = len(reduced) == len(groups)
    if unchanged and len(reduced) > 20:
        strengths = {grid.strength(g.tick) for g in reduced}
        if len(strengths) > 1:
            weakest = min(strengths)
            weak = [i for i, g in enumerate(reduced) if grid.strength(g.tick) == weakest]
            drop = set(weak[1::2])
            reduced = [g for i, g in enumerate(reduced) if i not in drop]
    return reduced


# ---------------------------------------------------------------------------
# Sustains
# ---------------------------------------------------------------------------

# A note whose onset frame is quieter than this (0..1, dB between the stem's 10th and 95th
# percentile loudness) is charted over silence. `chart.scoring` calls < 0.05 silent; the
# margin keeps a one-frame rounding difference from tipping a note back over the line.
SILENCE_LOUDNESS = 0.07

# Same analysis settings as `chart.scoring.extract_audio_features`, so the onsets and
# loudness a chart is built against are the ones it is later judged against.
ANALYSIS_SAMPLE_RATE = 22050
ANALYSIS_HOP = 220


class AudioEnvelope:
    """Frame-wise loudness, used to avoid sustaining notes over decayed or silent audio."""

    def __init__(self, rms, hop_s):
        self.rms = list(rms)
        self.hop_s = float(hop_s)
        self._loudness = None

    def _frames(self, start_s, end_s):
        first = max(0, int(start_s / self.hop_s))
        last = min(len(self.rms), max(first + 1, int(end_s / self.hop_s) + 1))
        return self.rms[first:last]

    def holds(self, start_s, end_s, ratio=0.3):
        """True when the sound after an onset stays at least `ratio` of its onset level."""
        onset = self._frames(start_s - 0.03, start_s + 0.12)
        body = sorted(self._frames(start_s + 0.12, end_s))
        if not onset or not body:
            return False
        return body[len(body) // 2] >= ratio * max(onset)

    @property
    def duration_s(self):
        return len(self.rms) * self.hop_s

    @property
    def loudness(self):
        """Per frame 0..1: RMS in dB, with the 10th percentile at 0 and the 95th at 1."""
        if self._loudness is None:
            db = [20.0 * math.log10(v + 1e-8) for v in self.rms]
            ordered = sorted(db)
            if not ordered:
                self._loudness = []
            else:
                low = ordered[int(0.10 * (len(ordered) - 1))]
                high = ordered[int(0.95 * (len(ordered) - 1))]
                span = high - low
                self._loudness = [
                    1.0 if span < 1e-6 else min(1.0, max(0.0, (v - low) / span)) for v in db
                ]
        return self._loudness

    def sounds_at(self, onset_s, floor=SILENCE_LOUDNESS):
        """True when the audio is audible at `onset_s` (and has not ended)."""
        if onset_s < 0 or onset_s >= self.duration_s:
            return False
        return self.loudness[int(onset_s / self.hop_s)] >= floor


@dataclass
class AudioAnalysis:
    """What the post-processors need to know about the audio a chart is built from."""

    envelope: AudioEnvelope
    onsets: list      # onset peak times in seconds, ascending
    onset_env: list   # z-scored onset strength per frame
    hop_s: float

    def strength_at(self, seconds):
        """Onset strength around `seconds` (peak within +/-30 ms); higher = clearer attack."""
        first = max(0, int((seconds - 0.03) / self.hop_s))
        last = min(len(self.onset_env), int((seconds + 0.03) / self.hop_s) + 1)
        return max(self.onset_env[first:last], default=0.0)


def load_analysis(audio_path, sample_rate=ANALYSIS_SAMPLE_RATE, hop_length=ANALYSIS_HOP):
    """Loudness envelope and onset peaks of an audio file (requires librosa and scipy)."""
    import librosa
    import numpy as np
    from scipy.signal import find_peaks

    wav, sr = librosa.load(audio_path, sr=sample_rate, mono=True)
    raw = librosa.onset.onset_strength(y=wav, sr=sr, hop_length=hop_length)
    env = (raw - raw.mean()) / (raw.std() + 1e-9)
    fps = sr / hop_length
    peaks, _ = find_peaks(env, height=1.0, distance=max(1, int(0.05 * fps)))
    rms = librosa.feature.rms(y=wav, hop_length=hop_length)[0]
    return AudioAnalysis(
        envelope=AudioEnvelope(rms.tolist(), hop_length / sr),
        onsets=(peaks / fps).tolist(),
        onset_env=env.astype(np.float32).tolist(),
        hop_s=hop_length / sr,
    )


def load_envelope(audio_path, sample_rate=ANALYSIS_SAMPLE_RATE, hop_length=ANALYSIS_HOP):
    """Build an `AudioEnvelope` from an audio file (requires librosa)."""
    import librosa

    wav, sr = librosa.load(audio_path, sr=sample_rate, mono=True)
    rms = librosa.feature.rms(y=wav, hop_length=hop_length)[0]
    return AudioEnvelope(rms.tolist(), hop_length / sr)


def gate_silence(groups, tempo_map, envelope, floor=SILENCE_LOUDNESS):
    """Drop notes the audio cannot have produced.

    The model always fills whole 30 s windows, so it charts the padding after the audio
    ends, and it charts quiet passages of a stem (a guitar that is not playing) as if
    they were loud. A note is kept only if the audio is audible at its onset.
    """
    return [
        g for g in groups
        if envelope.sounds_at(tempo_map.tick_to_seconds(g.tick), floor)
    ]


# ---------------------------------------------------------------------------
# Onset alignment
# ---------------------------------------------------------------------------

def align_to_onsets(times, tokens, onsets, tolerance_s=0.06, drop_unsupported=True, fill_s=0.0):
    """Put the model's notes on the audio onsets they describe.

    The model places notes on a 40 ms grid and often a little off the attack it means, so
    each note moves to the nearest detected onset within `tolerance_s`. A note with no
    onset that close has nothing in the audio behind it and is dropped (or, with
    `drop_unsupported=False`, left where the model put it). An onset is claimed once, by
    the closest note, so two predictions for one attack become one note.

    With `fill_s`, an audible onset that no note claimed gets a note too, carrying the frets
    of the nearest model note within `fill_s` seconds: the model decides *what* is played
    around there, the audio decides *when*. An onset with no model note that near stays
    empty, so a part the model left silent is not charted.

    `times` (seconds, ascending) and `tokens` are parallel; returns the same pair, with
    `times` strictly ascending.
    """
    def nearest(points, target):
        i = bisect.bisect_left(points, target)
        candidates = [j for j in (i - 1, i) if 0 <= j < len(points)]
        return min(candidates, key=lambda j: abs(points[j] - target), default=None)

    claimed = {}  # onset index -> (distance, token)
    loose = []    # (time, token) of notes kept without an onset
    for time_s, token in zip(times, tokens):
        j = nearest(onsets, time_s)
        if j is not None and abs(onsets[j] - time_s) <= tolerance_s:
            distance = abs(onsets[j] - time_s)
            if j not in claimed or distance < claimed[j][0]:
                claimed[j] = (distance, token)
        elif not drop_unsupported:
            loose.append((time_s, token))

    events = [(onsets[j], token) for j, (_, token) in claimed.items()] + loose
    if fill_s > 0 and times:
        for j, onset in enumerate(onsets):
            if j in claimed:
                continue
            k = nearest(times, onset)
            if k is not None and abs(times[k] - onset) <= fill_s:
                events.append((onset, tokens[k]))

    events.sort(key=lambda event: event[0])
    out_times, out_tokens = [], []
    for time_s, token in events:
        if out_times and time_s - out_times[-1] < MIN_NOTE_GAP_S:
            continue
        out_times.append(time_s)
        out_tokens.append(token)
    return out_times, out_tokens


# ---------------------------------------------------------------------------
# Dynamics
# ---------------------------------------------------------------------------

# A chart sparser than this (notes per second, first to last note) is too thin to be Expert.
DYNAMICS_MIN_NPS = 2.0


def shape_to_dynamics(groups, tempo_map, envelope, strength=None, bin_s=4.0, active=0.15,
                      gamma=1.0, min_nps=DYNAMICS_MIN_NPS):
    """Make the note density follow the song's loudness.

    A chart that is as busy in a quiet verse as in the chorus ignores the music. The song
    is cut into `bin_s` bins; the busiest ordinary bins set a reference density, and a bin
    whose loudness is a fraction `f` of the reference loudness may hold only `f ** gamma`
    of the reference density. Within an over-full bin the notes with the weakest attack go.

    Shaping never thins the chart below `min_nps`: the reference density is raised until
    the track keeps that rate (or nothing is left to drop).
    """
    if not groups:
        return []
    loudness = envelope.loudness
    hop = envelope.hop_s
    times = [tempo_map.tick_to_seconds(g.tick) for g in groups]
    weight = [strength(t) if strength else 0.0 for t in times]

    bins = int(envelope.duration_s // bin_s) + 1
    level = []
    for b in range(bins):
        frames = loudness[int(b * bin_s / hop):max(int(b * bin_s / hop) + 1, int((b + 1) * bin_s / hop))]
        level.append(sum(frames) / len(frames) if frames else 0.0)
    members = [[] for _ in range(bins)]
    for i, t in enumerate(times):
        members[min(bins - 1, int(t // bin_s))].append(i)

    live = sorted(len(members[b]) for b in range(bins) if level[b] > active and members[b])
    live_levels = sorted(level[b] for b in range(bins) if level[b] > active)
    if len(live) < 3:
        return list(groups)
    reference_level = max(live_levels[int(0.85 * (len(live_levels) - 1))], 1e-6)
    span = max(times[-1] - times[0], 1.0)

    def shaped(reference_count):
        dropped = set()
        for b in range(bins):
            budget = int(round(reference_count * min(1.0, level[b] / reference_level) ** gamma))
            if len(members[b]) > budget:
                ranked = sorted(members[b], key=lambda i: weight[i])
                dropped.update(ranked[:len(members[b]) - budget])
        return [g for i, g in enumerate(groups) if i not in dropped]

    reference_count = live[int(0.85 * (len(live) - 1))]
    ceiling = max(live)
    while True:
        kept = shaped(reference_count)
        if len(kept) >= min_nps * span or reference_count >= ceiling:
            return kept
        reference_count += 1


# ---------------------------------------------------------------------------
# Playability
# ---------------------------------------------------------------------------

# (average notes/s, peak notes in any 1 s window) a track may reach, per difficulty.
PLAY_LIMITS = {
    "Expert": (7.5, 13),
    "Hard": (4.2, 8),
    "Medium": (2.6, 5),
    "Easy": (1.6, 3),
}

# A fretting hand cannot strum faster than this, or jump BIG_JUMP frets / change chords
# faster than MIN_JUMP_GAP_S. Slightly stricter than the figures `chart.scoring` penalises.
MIN_STRUM_GAP_S = 0.07
MIN_JUMP_GAP_S = 0.12
BIG_JUMP = 3
NPS_WINDOW_S = 0.99
AVG_NPS_MARGIN = 0.97


def _top_fret(lanes):
    frets = [lane for lane in lanes if lane != OPEN]
    return max(frets) if frets else None


def limit_playable(groups, tempo_map, difficulty, strength=None):
    """Thin a track until a hand can play it: strum speed, hand travel and note rates.

    When two notes cannot both be played, the one with the clearer attack (`strength`, a
    callable taking seconds; chord size when absent) survives. Chords played in quick
    succession are reduced to a single note rather than dropped.
    """
    if not groups:
        return []
    avg_cap, peak_cap = PLAY_LIMITS[difficulty]
    times = [tempo_map.tick_to_seconds(g.tick) for g in groups]
    weight = [strength(t) if strength else float(len(g.lanes)) for t, g in zip(times, groups)]

    kept, lanes = [], {}
    for i, group in enumerate(groups):
        current = group.lanes
        while kept:
            previous = kept[-1]
            gap = times[i] - times[previous]
            conflict = gap < MIN_STRUM_GAP_S
            if not conflict and gap < MIN_JUMP_GAP_S:
                if len(current) >= 2 and len(lanes[previous]) >= 2 and OPEN not in current:
                    current = (max(current),)
                top_now, top_before = _top_fret(current), _top_fret(lanes[previous])
                conflict = (top_now is not None and top_before is not None
                            and abs(top_now - top_before) >= BIG_JUMP)
            if not conflict:
                break
            if weight[i] > weight[previous]:
                kept.pop()
            else:
                current = None
                break
        if current is not None:
            kept.append(i)
            lanes[i] = current

    def crowding(pos):
        """Distance to the nearest neighbouring kept note; thinning the tightest spot first."""
        before = times[kept[pos]] - times[kept[pos - 1]] if pos > 0 else float("inf")
        after = times[kept[pos + 1]] - times[kept[pos]] if pos + 1 < len(kept) else float("inf")
        return min(before, after)

    # Peak rate: while any one-second window holds too many groups, drop its weakest
    # (the most crowded of equally weak ones). The first and last note stay, so thinning
    # cannot shorten the track and so inflate its average rate.
    while True:
        violation = None
        start = 0
        for pos, i in enumerate(kept):
            while times[kept[start]] < times[i] - NPS_WINDOW_S:
                start += 1
            if pos - start + 1 > peak_cap:
                violation = (start, pos)
                break
        if violation is None:
            break
        first, last = violation
        candidates = [p for p in range(first, last + 1) if 0 < p < len(kept) - 1]
        if not candidates:
            break
        weakest = min(candidates, key=lambda p: (weight[kept[p]], crowding(p)))
        del kept[weakest]

    # Average rate: shed the weakest groups overall until under the band.
    if len(kept) > 2:
        span = max(times[kept[-1]] - times[kept[0]], 1.0)
        excess = len(kept) - int(avg_cap * AVG_NPS_MARGIN * span)
        if excess > 0:
            interior = sorted(range(1, len(kept) - 1), key=lambda p: (weight[kept[p]], crowding(p)))
            drop = set(interior[:excess])
            kept = [i for p, i in enumerate(kept) if p not in drop]

    return [replace(groups[i], lanes=lanes[i]) for i in kept]


def add_sustains(
    groups,
    tempo_map,
    envelope=None,
    min_gap_beats=1.0,
    min_gap_s=0.35,
    rest_beats=0.25,
    max_beats=16,
    min_sustain_s=0.12,
):
    """Hold a note through the rest before the next one.

    A note is sustained when at least `min_gap_beats` (and `min_gap_s`) of space follows
    it. The sustain ends `rest_beats` before the next onset, on a 16th-note boundary, and
    is skipped if it would be a `babySustain` (<100 ms) or if `envelope` says the audio
    has already died away.
    """
    resolution = tempo_map.resolution
    quantum = max(1, resolution // 4)
    rest = int(resolution * rest_beats)
    out = []
    for i, group in enumerate(groups):
        length = 0
        if i + 1 < len(groups) and OPEN not in group.lanes:
            start_s = tempo_map.tick_to_seconds(group.tick)
            next_tick = groups[i + 1].tick
            gap = next_tick - group.tick
            gap_s = tempo_map.tick_to_seconds(next_tick) - start_s
            if gap >= min_gap_beats * resolution and gap_s >= min_gap_s:
                end = (min(next_tick - rest, group.tick + max_beats * resolution) // quantum) * quantum
                candidate = end - group.tick
                end_s = tempo_map.tick_to_seconds(end)
                if (candidate > 0 and end_s - start_s >= min_sustain_s
                        and tempo_map.tick_to_seconds(next_tick) - end_s > 0.05
                        and (envelope is None or envelope.holds(start_s, end_s))):
                    length = candidate
        out.append(replace(group, length=length))
    return out


# `chart.scoring` stops crediting sustains when more than half the notes are held; a chart
# that holds most of its notes is also no longer a picked part.
MAX_SUSTAINED_FRACTION = 0.4


def cap_sustains(groups, max_fraction=MAX_SUSTAINED_FRACTION):
    """Keep at most `max_fraction` of the notes held, shedding the shortest sustains first."""
    held = [i for i, g in enumerate(groups) if g.length > 0]
    excess = len(held) - int(max_fraction * len(groups))
    if excess <= 0:
        return list(groups)
    shortest = set(sorted(held, key=lambda i: groups[i].length)[:excess])
    return [replace(g, length=0) if i in shortest else g for i, g in enumerate(groups)]


# ---------------------------------------------------------------------------
# Star power
# ---------------------------------------------------------------------------

def star_power_windows(
    groups,
    tempo_map,
    phrase_measures=2,
    min_notes=6,
    target_gap_s=24.0,
    phase=0,
):
    """Pick `(start_tick, end_tick)` star power phrases, aligned to measures.

    The song is cut into blocks roughly `target_gap_s` long. Each block (except the
    intro block) gets one phrase: the `phrase_measures`-long window holding the most
    notes, kept at least a measure clear of the block edges so neighbouring phrases never
    touch. Windows with fewer than `min_notes` notes are skipped.
    """
    if not groups:
        return []
    measure = tempo_map.resolution * 4
    # Work in a frame where the beat grid starts at tick 0, then shift the result back.
    last_tick = groups[-1].tick - phase
    measure_count = max(1, last_tick // measure + 1)
    seconds_per_measure = tempo_map.tick_to_seconds(measure_count * measure) / measure_count
    period = max(phrase_measures + 4, min(16, round(target_gap_s / max(seconds_per_measure, 1e-6))))
    ticks = [g.tick - phase for g in groups]

    windows = []
    for block in range(1, measure_count // period + 1):
        best = None
        for start in range(block * period + 1, block * period + period - phrase_measures):
            lo, hi = start * measure, (start + phrase_measures) * measure
            count = bisect.bisect_left(ticks, hi) - bisect.bisect_left(ticks, lo)
            if count >= min_notes and (best is None or count > best[0]):
                best = (count, lo, hi)
        if best:
            windows.append((best[1] + phase, best[2] + phase))
    return windows


def apply_star_power(groups, windows):
    """Mark the notes inside each window as star power.

    `SimpleTokenizerGuitar.decode` fuses consecutive star notes into one phrase, so a
    window is skipped if no unmarked note separates it from the previous phrase. A window
    holding a single note is skipped too: it would decode to a zero-length phrase, which
    scan-chart reports as `emptyStarPower`.
    """
    ticks = [g.tick for g in groups]
    marked = list(groups)
    previous_end = None
    for start, end in windows:
        lo, hi = bisect.bisect_left(ticks, start), bisect.bisect_left(ticks, end)
        if hi - lo < 2 or lo == previous_end:
            continue
        for i in range(lo, hi):
            marked[i] = replace(marked[i], star=True)
        previous_end = hi
    return marked


# ---------------------------------------------------------------------------
# Sections
# ---------------------------------------------------------------------------

def _section_events(ticks):
    return [(tick, f"section Section {i + 1}") for i, tick in enumerate(ticks)]


def fixed_sections(tempo_map, last_tick, measures=8):
    """Evenly spaced sections, used when audio analysis is unavailable."""
    step = tempo_map.resolution * 4 * measures
    return _section_events(range(0, max(last_tick, 1), step))


def detect_sections(
    audio_path,
    tempo_map,
    last_tick,
    seconds_per_section=25.0,
    bin_s=1.0,
    min_measures=4,
):
    """Segment the audio by timbre/harmony change and snap boundaries to measures.

    Returns `(tick, "section <name>")` events for the `[Events]` track.
    """
    import librosa
    import numpy as np

    wav, sr = librosa.load(audio_path, sr=22050, mono=True)
    hop = 512
    features = np.vstack([
        librosa.feature.mfcc(y=wav, sr=sr, hop_length=hop, n_mfcc=13),
        librosa.feature.chroma_stft(y=wav, sr=sr, hop_length=hop) * 4.0,
    ])
    per_bin = max(1, round(bin_s * sr / hop))
    edges = np.arange(0, features.shape[1], per_bin)
    binned = np.add.reduceat(features, edges, axis=1) / np.diff(np.append(edges, features.shape[1]))
    binned = (binned - binned.mean(axis=1, keepdims=True)) / (binned.std(axis=1, keepdims=True) + 1e-8)

    count = max(2, round(len(wav) / sr / seconds_per_section))
    count = min(count, binned.shape[1])
    bounds = librosa.segment.agglomerative(binned, count)

    measure = tempo_map.resolution * 4
    last_measure = last_tick // measure
    measures = {0}
    for index in sorted(int(b) for b in bounds):
        tick = tempo_map.seconds_to_tick(index * per_bin * hop / sr)
        measure_index = int(round(tick / measure))
        if min_measures <= measure_index <= last_measure - min_measures:
            measures.add(measure_index)

    kept = []
    for measure_index in sorted(measures):
        if not kept or measure_index - kept[-1] >= min_measures:
            kept.append(measure_index)
    return _section_events([m * measure for m in kept])


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def build_tracks(
    ticked_notes,
    tokenizer,
    tempo_map,
    difficulties=DIFFICULTIES,
    sustains=True,
    star_power=True,
    envelope=None,
    align_to_notes=False,
    trim_silence=True,
    playable=True,
    strength=None,
    dynamics=True,
):
    """Expand Expert model output into decoded note lines per difficulty.

    Returns `{difficulty: [(tick, "N"|"S", value, length), ...]}` in the order given.
    Expert is always produced; the other difficulties are reduced from it.

    Set `align_to_notes` when the tempo map is a fixed BPM from tick 0 rather than tracked
    beats: the beat grid's phase is then estimated from the notes themselves so that
    "downbeat" and "measure" mean something.

    With `trim_silence` and an `envelope`, notes the audio cannot have produced (past the
    end of the audio, or in silence) are dropped before anything is derived from them.

    With `dynamics` and an `envelope`, the note density follows the loudness of the audio
    (`shape_to_dynamics`).

    With `playable`, every track is thinned to what a hand can play (`limit_playable`);
    `strength` (seconds -> onset strength) decides which of two clashing notes survives.
    """
    unknown = [d for d in difficulties if d not in DIFFICULTIES]
    if unknown:
        raise ValueError(f"Unknown difficulties: {unknown}")

    expert = sanitize(to_groups(ticked_notes, tokenizer), tempo_map)
    if trim_silence and envelope is not None:
        expert = gate_silence(expert, tempo_map, envelope)
    if dynamics and envelope is not None:
        expert = shape_to_dynamics(expert, tempo_map, envelope, strength)
    if playable:
        expert = limit_playable(expert, tempo_map, "Expert", strength)
    phase = estimate_grid_phase(expert, tempo_map) if align_to_notes else 0
    grid = default_grid(tempo_map, phase)
    windows = star_power_windows(expert, tempo_map, phase=phase) if star_power else []

    tracks = {}
    current = expert
    for difficulty in DIFFICULTIES:
        # Each difficulty is reduced from the one above it, so lower tracks are always
        # subsets in time and the note counts can only fall.
        if difficulty != "Expert":
            current = reduce_groups(current, tempo_map, difficulty, grid)
            if playable:
                current = limit_playable(current, tempo_map, difficulty, strength)
        if difficulty not in difficulties and difficulty != "Expert":
            continue
        groups = [replace(g, length=0, star=False) for g in current]
        if sustains:
            groups = cap_sustains(add_sustains(groups, tempo_map, envelope))
        if windows:
            groups = apply_star_power(groups, windows)
        tracks[difficulty] = tokenizer.decode(to_ticked(groups, tokenizer))

    ordered = [d for d in DIFFICULTIES if d in tracks]
    return {d: tracks[d] for d in ordered}
