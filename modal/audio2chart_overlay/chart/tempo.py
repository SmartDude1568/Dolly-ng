"""Beat tracking, tempo-map construction, and musical snapping for generated charts.

The generation path used to emit every chart at a fixed 200 BPM, which leaves the
measure lines meaningless and makes Clone Hero's HOPO detection - measured in ticks
relative to the resolution - fire at musically wrong intervals. This module estimates
the real tempo of the source audio, builds a `[SyncTrack]` that follows it, and snaps
predicted onsets onto musical subdivisions of that grid.
"""

import bisect
import math

from chart.time_conversion import preprocess_bpm_segments, tick_to_seconds


MIN_BPM = 30.0
MAX_BPM = 400.0

# Subdivisions of a beat that notes are allowed to snap to. 1/8 of a beat is a 32nd
# note; at 200 BPM that is 37.5 ms, about the model's own time grid, so anything
# finer would snap to noise rather than to musical structure.
DEFAULT_DIVISIONS = (1, 2, 3, 4, 6, 8)

# Half the 40 ms generation grid, plus slack for beat-tracker error.
DEFAULT_SNAP_TOLERANCE_S = 0.025

# How far the tempo map may drift from a tracked beat before a new marker is emitted.
DEFAULT_MAX_DRIFT_S = 0.010


# Same beat tracker call as `chart.scoring.extract_audio_features`, so the beats a chart is
# written against are the beats it is later judged against.
BEAT_HOP = 220


def estimate_beats(audio_path, sample_rate=22050, hop_length=BEAT_HOP):
    """Beat-track an audio file.

    Returns `(beat_times, tempo)` where `beat_times` is a sorted list of beat
    positions in seconds. Raises `RuntimeError` if librosa is unavailable or the
    track yields too few beats to build a tempo map from.
    """
    try:
        import librosa
    except ImportError as error:  # pragma: no cover - depends on the install
        raise RuntimeError("librosa is required for beat tracking") from error

    wav, sr = librosa.load(audio_path, sr=sample_rate, mono=True)
    envelope = librosa.onset.onset_strength(y=wav, sr=sr, hop_length=hop_length)
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=envelope, sr=sr, hop_length=hop_length
    )
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length).tolist()

    if len(beat_times) < 4:
        raise RuntimeError(
            f"Beat tracking found only {len(beat_times)} beats; too few for a tempo map"
        )

    tempo = float(tempo if not hasattr(tempo, "__len__") else tempo[0])
    return beat_times, tempo


def _clamp_bpm(bpm):
    return min(MAX_BPM, max(MIN_BPM, bpm))


def _leading_beat_count(first_beat, first_interval):
    """Whole beats to place between tick 0 and the first tracked beat.

    A chart always starts at tick 0 = time 0, but the first tracked beat rarely lands
    there. Rather than offsetting the audio, the gap is covered by a leading tempo
    marker spanning a whole number of beats.
    """
    if first_beat <= 1e-6:
        return 0
    lower = max(1, math.ceil(first_beat * MIN_BPM / 60.0))
    upper = math.floor(first_beat * MAX_BPM / 60.0)
    if upper < 1:
        # First beat is within a single beat of t=0 even at the maximum tempo.
        return 0
    estimate = round(first_beat / first_interval) if first_interval > 0 else 1
    return min(max(estimate, lower), min(upper, lower + 64))


def build_tempo_map(
    beat_times,
    resolution=480,
    max_drift_s=DEFAULT_MAX_DRIFT_S,
):
    """Build `[SyncTrack]` BPM events that follow the tracked beats.

    Each tracked beat is treated as one quarter note. Markers are emitted greedily:
    a segment is extended for as long as its constant tempo keeps the realized beat
    times within `max_drift_s` of the tracked ones, and each new segment re-derives
    its tempo from the realized time so drift does not accumulate.

    Returns a list of `(tick, bpm_milli)` tuples in the same integer-milli-BPM form
    the rest of the codebase uses, always starting at tick 0.
    """
    if len(beat_times) < 2:
        raise ValueError("At least two beats are required to build a tempo map")
    beats = sorted(float(t) for t in beat_times)
    if any(b <= a for a, b in zip(beats, beats[1:])):
        raise ValueError("Beat times must be strictly increasing")
    if resolution <= 0:
        raise ValueError("resolution must be positive")

    events = []
    first_interval = beats[1] - beats[0]
    leading_beats = _leading_beat_count(beats[0], first_interval)

    if leading_beats > 0:
        lead_bpm = _clamp_bpm(60.0 * leading_beats / beats[0])
        events.append((0, _to_milli(lead_bpm)))
        # The leading marker's rounding decides where beat 0 actually lands.
        realized = leading_beats * 60.0 / _from_milli(_to_milli(lead_bpm))
    else:
        realized = 0.0

    index = 0
    while index < len(beats) - 1:
        tick = (leading_beats + index) * resolution
        bpm_milli = _to_milli(_clamp_bpm(60.0 / max(beats[index + 1] - realized, 1e-6)))
        bpm = _from_milli(bpm_milli)
        if not events or events[-1][1] != bpm_milli:
            events.append((tick, bpm_milli))

        # Extend this segment for as long as it tracks the beats closely enough.
        # j = 1 always holds by construction, since bpm was chosen to land on it.
        step = 60.0 / bpm
        span = 0
        while index + span + 1 < len(beats):
            candidate = span + 1
            projected = realized + candidate * step
            if abs(projected - beats[index + candidate]) > max_drift_s:
                break
            span = candidate
        span = max(1, span)

        realized += span * step
        index += span

    if events[0][0] != 0:
        raise AssertionError("Tempo map must start at tick 0")
    return events


def _to_milli(bpm):
    return int(round(bpm * 1000.0))


def _from_milli(bpm_milli):
    return bpm_milli / 1000.0


class TempoMap:
    """Two-way conversion between seconds and ticks for a `[SyncTrack]`."""

    def __init__(self, bpm_events, resolution=480):
        self.resolution = resolution
        self.events = sorted(bpm_events)
        self.segments = preprocess_bpm_segments(self.events, resolution)
        self._segment_ticks = [segment[0] for segment in self.segments]
        self._segment_times = [segment[2] for segment in self.segments]

    def tick_to_seconds(self, tick):
        return tick_to_seconds(tick, self.segments, self.resolution, self._segment_ticks)

    def seconds_to_tick(self, seconds):
        """Inverse of `tick_to_seconds`, returning a fractional tick."""
        index = bisect.bisect_right(self._segment_times, seconds) - 1
        if index < 0:
            index = 0
        base_tick, bpm, base_time = self.segments[index]
        return base_tick + (seconds - base_time) * bpm / 60.0 * self.resolution

    def snap(self, tick, divisions=DEFAULT_DIVISIONS, tolerance_s=DEFAULT_SNAP_TOLERANCE_S):
        """Snap a fractional tick to the nearest allowed subdivision of a beat.

        Returns the snapped integer tick, or the plain rounded tick when no
        candidate lies within `tolerance_s`.
        """
        rounded = int(round(tick))
        best = None
        for division in divisions:
            step = self.resolution / division
            candidate = int(round(round(tick / step) * step))
            error = abs(self.tick_to_seconds(candidate) - self.tick_to_seconds(tick))
            if error <= tolerance_s and (best is None or error < best[1]):
                best = (candidate, error)
        return best[0] if best is not None else rounded


def notes_to_ticks(
    tokens_list,
    time_list,
    tempo_map,
    pad_token,
    divisions=DEFAULT_DIVISIONS,
    tolerance_s=DEFAULT_SNAP_TOLERANCE_S,
):
    """Convert grid tokens to snapped tick positions against a tempo map.

    Replaces `chart.time_conversion.convert_notes_to_ticks` for the tempo-aware
    generation path. Notes whose snapped position would collide with the previous
    note fall back to their unsnapped tick, and are dropped only if that collides
    too - snapping must never silently merge two onsets into a chord.
    """
    attrs = {"is5": False, "is6": False, "isS": False}
    ticked = []
    last_tick = None

    for time_sec, token in zip(time_list, tokens_list):
        if token == pad_token:
            continue
        raw = tempo_map.seconds_to_tick(time_sec)
        tick = tempo_map.snap(raw, divisions=divisions, tolerance_s=tolerance_s)
        if last_tick is not None and tick <= last_tick:
            tick = int(round(raw))
            if tick <= last_tick:
                continue
        ticked.append((tick, token, 0, dict(attrs)))
        last_tick = tick

    return ticked


def fixed_tempo_map(bpm=200, resolution=480):
    """The legacy single-marker tempo map, kept for `--tempo fixed`."""
    return TempoMap([(0, _to_milli(float(bpm)))], resolution=resolution)


PHASE_SIGMA_S = 0.050


def fit_fixed_grid(beat_times, bpm, tolerance=0.015, sigma_s=PHASE_SIGMA_S):
    """Constant tempo and phase whose beat lines best fit `beat_times`, near `bpm`.

    A confirmed BPM is only as good as its last digit: 105.0 against a song that is really
    105.5 puts the grid a full beat off by the end of five minutes. The tempo is therefore
    searched within `tolerance` (a fraction, 1.5% by default) of `bpm`, jointly with the
    phase, by the summed Gaussian credit of every tracked beat against its nearest grid
    line (so one off-beat outlier cannot drag the grid away from the rest).

    Returns `(bpm, phase_s, fit)`: the fitted tempo (thousandths of a BPM), the position in
    seconds of the first beat line in `[0, 60/bpm)`, and the mean beat credit in `[0, 1]`.
    """
    import numpy as np

    beats = np.asarray(beat_times, dtype=float)
    if beats.size == 0 or bpm <= 0:
        raise ValueError("fit_fixed_grid needs beats and a positive bpm")

    def best_phase(candidate, step):
        period = 60.0 / candidate
        phases = np.arange(0.0, period, step)
        residual = (beats[None, :] - phases[:, None] + period / 2.0) % period - period / 2.0
        credit = np.exp(-0.5 * (residual / sigma_s) ** 2).sum(axis=1)
        index = int(credit.argmax())
        return float(phases[index]), float(credit[index])

    # 0.01% steps keep the drift between neighbouring candidates under ~20 ms per song.
    best = None
    for scale in np.arange(1.0 - tolerance, 1.0 + tolerance + 1e-9, 1e-4):
        phase, credit = best_phase(bpm * scale, 0.010)
        if best is None or credit > best[0]:
            best = (credit, bpm * scale, phase)
    _, fitted, coarse_phase = best

    # Polish the winning tempo and phase.
    fine = None
    for scale in np.arange(-5e-5, 5e-5 + 1e-9, 1e-5):
        candidate = fitted * (1.0 + scale)
        period = 60.0 / candidate
        phases = (coarse_phase + np.arange(-0.010, 0.010 + 1e-9, 0.001)) % period
        residual = (beats[None, :] - phases[:, None] + period / 2.0) % period - period / 2.0
        credit = np.exp(-0.5 * (residual / sigma_s) ** 2).sum(axis=1)
        index = int(credit.argmax())
        if fine is None or credit[index] > fine[0]:
            fine = (float(credit[index]), candidate, float(phases[index]))
    credit, fitted, phase = fine
    return round(fitted, 3), phase, credit / beats.size


def fixed_tempo_events(bpm, phase_s=0.0, resolution=480, min_lead_s=0.25):
    """`[SyncTrack]` for one constant `bpm` whose beat lines fall on `phase_s + k * 60/bpm`.

    A chart starts at tick 0 = time 0, so the phase is written as a one-beat lead-in
    marker whose tempo makes tick `resolution` land on the first grid line, followed by
    the constant tempo itself. With no phase the single legacy marker is returned.
    """
    bpm_milli = _to_milli(float(bpm))
    if phase_s <= 1e-6:
        return [(0, bpm_milli)]
    period = 60.0 / bpm
    first_line = phase_s
    while first_line < min_lead_s:
        first_line += period
    lead_bpm = _clamp_bpm(60.0 / first_line)
    return [(0, _to_milli(lead_bpm)), (resolution, bpm_milli)]


def match_beats_to_bpm(beat_times, bpm, tolerance=0.08):
    """Beats at the tempo octave of a confirmed `bpm`, or `None` if they are unrelated.

    Beat trackers regularly land on half or double the tempo a listener taps. When the
    tracked tempo is within `tolerance` of `bpm` the beats are returned as they are; when
    it is about half of `bpm`, the midpoint of every beat is added. A tracker running at
    double speed cannot be repaired (which beats are the real ones is unknown), and an
    unrelated tempo means the tracker and the listener disagree, so both give `None`.
    """
    beats = sorted(float(t) for t in beat_times)
    if len(beats) < 2 or bpm <= 0:
        return None
    intervals = sorted(b - a for a, b in zip(beats, beats[1:]))
    ratio = (60.0 / intervals[len(intervals) // 2]) / bpm
    if abs(ratio - 1.0) <= tolerance:
        return beats
    if abs(ratio * 2.0 - 1.0) <= tolerance:
        doubled = []
        for first, second in zip(beats, beats[1:]):
            doubled += [first, (first + second) / 2.0]
        doubled.append(beats[-1])
        return doubled
    return None
