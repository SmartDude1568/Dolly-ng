"""
Modal wrapper for audio2chart (https://github.com/3podi/audio2chart).

Exposes two HTTP endpoints behind a shared-secret token:

  POST /generate    multipart: file=<audio>, opts=<json>
                    -> {"call_id": "...", "modal_call_id": "fc-..."}

  GET  /status      query: call_id, modal_call_id
                    -> {"status": "running", "progress": {...}}
                       {"status": "done",    "chart": "<chart text>"}
                       {"status": "error",   "error": "..."}

Both require header: x-audio2chart-token: <AUDIO2CHART_TOKEN>

Deploy:
  modal secret create audio2chart-auth AUDIO2CHART_TOKEN=$(openssl rand -hex 32)
  modal deploy modal/audio2chart_app.py
"""

import json
import os
import sys
import tempfile
import uuid

import modal

# ---------------------------------------------------------------------------
# App, image, volume, secret
# ---------------------------------------------------------------------------

app = modal.App("dolly-audio2chart")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg")
    .run_commands(
        "git clone https://github.com/3podi/audio2chart.git /opt/audio2chart",
        # audioop-lts is a Python 3.13+ backport; 3.11 has audioop builtin.
        "sed -i '/^audioop-lts/d' /opt/audio2chart/requirements.txt",
        "pip install -r /opt/audio2chart/requirements.txt",
    )
    .pip_install("fastapi[standard]")
    .env({"HF_HOME": "/cache/hf", "PYTHONPATH": "/opt/audio2chart"})
)

hf_cache = modal.Volume.from_name("audio2chart-hf-cache", create_if_missing=True)
progress_dict = modal.Dict.from_name(
    "audio2chart-progress", create_if_missing=True
)
auth_secret = modal.Secret.from_name("audio2chart-auth")

GPU = "T4"
INFERENCE_TIMEOUT = 30 * 60  # 30 min hard cap on a single generation


# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------

def _check_auth(request) -> None:
    from fastapi import HTTPException

    expected = os.environ.get("AUDIO2CHART_TOKEN")
    if not expected:
        raise HTTPException(status_code=500, detail="server missing token")
    got = request.headers.get("x-audio2chart-token")
    if got != expected:
        raise HTTPException(status_code=401, detail="invalid token")


# ---------------------------------------------------------------------------
# GPU function: actual inference
# ---------------------------------------------------------------------------

@app.function(
    image=image,
    gpu=GPU,
    volumes={"/cache/hf": hf_cache},
    secrets=[auth_secret],
    timeout=INFERENCE_TIMEOUT,
)
def generate_chart(call_id: str, audio_bytes: bytes, filename: str, opts: dict) -> str:
    """
    Run audio2chart end-to-end on a single audio file. Returns the .chart text.
    Mirrors generate.py from the upstream repo, but pushes step-level progress
    into a shared modal.Dict so the /status endpoint can surface it.
    """
    sys.path.insert(0, "/opt/audio2chart")

    import torch
    from inference.engine import Charter
    from chart.tokenizer import SimpleTokenizerGuitar
    from chart.time_conversion import convert_notes_to_ticks
    from chart.chart_writer import fill_expert_single

    def set_progress(stage: str, step: int = 0, total: int = 0) -> None:
        progress_dict[call_id] = {"stage": stage, "step": step, "total": total}

    # ----- write audio to a tmp file (engine reads from path) -----
    suffix = os.path.splitext(filename)[1] or ".wav"
    tmp_path = os.path.join(
        tempfile.gettempdir(), f"{uuid.uuid4().hex}{suffix}"
    )
    with open(tmp_path, "wb") as f:
        f.write(audio_bytes)

    try:
        # ----- load model -----
        set_progress("loading_model")
        model_name = opts.get("model_name", "3podi/charter-v1.0-40-M-best-acc")
        model = Charter.from_pretrained(model_name)
        tokenizer = SimpleTokenizerGuitar()
        ms_resolution = model.config.grid_ms

        # ----- monkey-patch tqdm inside engine.generate so we get step updates -----
        # engine.py does `from tqdm import tqdm` at module import, so we patch
        # the symbol on the inference.engine module after import.
        import inference.engine as engine_mod

        class _ProgressIter:
            def __init__(self, iterable, desc=None, **_kw):
                self._it = iter(iterable)
                try:
                    self._total = len(iterable)
                except TypeError:
                    self._total = 0
                self._step = 0
                set_progress("generating", 0, self._total)

            def __iter__(self):
                return self

            def __next__(self):
                try:
                    val = next(self._it)
                except StopIteration:
                    raise
                self._step += 1
                # Throttle dict writes: every 16 steps + final.
                if self._step % 16 == 0 or self._step == self._total:
                    set_progress("generating", self._step, self._total)
                return val

        engine_mod.tqdm = _ProgressIter  # type: ignore[attr-defined]

        # ----- generate token sequences -----
        seqs = model.generate(
            tmp_path,
            temperature=float(opts.get("temperature", 0.5)),
            top_k=int(opts.get("top_k", 32)),
        )
        seqs = torch.cat(seqs).flatten().cpu().tolist()

        # ----- post-process to .chart text -----
        set_progress("postprocessing")
        bpm = int(opts.get("bpm", 200))
        resolution = int(opts.get("resolution", 480))

        time_list = [i * ms_resolution / 1000 for i in range(len(seqs))]
        ticked_notes = convert_notes_to_ticks(
            seqs, time_list, fixed_bpm=bpm, resolution=resolution
        )
        decoded_full = tokenizer.decode(ticked_notes)

        model_tag = model_name.split("/")[-1]
        temperature = float(opts.get("temperature", 0.5))
        top_k = int(opts.get("top_k", 32))
        default_charter = (
            opts.get("charter")
            or f"audio2chart/{model_tag}-{temperature}-{top_k}"
        )
        song_name = (
            opts.get("name")
            or os.path.splitext(os.path.basename(filename))[0]
        )
        metadata = {
            "name": song_name,
            "artist": opts.get("artist") or "audio2chart",
            "album": opts.get("album") or "audio2chart",
            "genre": opts.get("genre") or "audio2chart",
            "charter": default_charter,
            "bpm": bpm,
            "resolution": resolution,
        }

        chart_text = fill_expert_single(decoded_full, metadata=metadata)
        set_progress("done", 1, 1)
        return chart_text

    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------

@app.function(image=image, secrets=[auth_secret], timeout=120)
@modal.fastapi_endpoint(method="POST")
async def http_generate(request):
    """
    Multipart POST: field `file` (audio), optional field `opts` (JSON string).
    Spawns the GPU function and returns immediately with the call IDs.
    """
    from fastapi import HTTPException
    from fastapi.responses import JSONResponse

    _check_auth(request)

    form = await request.form()
    upload = form.get("file")
    if upload is None:
        raise HTTPException(status_code=400, detail="missing 'file' field")

    audio_bytes = await upload.read()
    filename = getattr(upload, "filename", "audio.wav") or "audio.wav"

    opts_raw = form.get("opts")
    opts: dict = {}
    if opts_raw:
        try:
            opts = json.loads(opts_raw)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=f"bad opts JSON: {e}")

    call_id = uuid.uuid4().hex
    progress_dict[call_id] = {"stage": "queued", "step": 0, "total": 0}
    fc = generate_chart.spawn(call_id, audio_bytes, filename, opts)

    return JSONResponse(
        {"call_id": call_id, "modal_call_id": fc.object_id}
    )


@app.function(image=image, secrets=[auth_secret], timeout=30)
@modal.fastapi_endpoint(method="GET")
def http_status(call_id: str, modal_call_id: str, request):
    """
    Poll a previously-spawned generation. Non-blocking: returns immediately.
    """
    from fastapi.responses import JSONResponse

    _check_auth(request)

    progress = progress_dict.get(call_id) or {
        "stage": "unknown",
        "step": 0,
        "total": 0,
    }

    fc = modal.FunctionCall.from_id(modal_call_id)
    try:
        result = fc.get(timeout=0)
    except TimeoutError:
        return JSONResponse(
            {"status": "running", "progress": progress}
        )
    except modal.exception.OutputExpiredError:
        return JSONResponse(
            {"status": "error", "error": "output expired"}, status_code=410
        )
    except Exception as e:  # noqa: BLE001
        return JSONResponse(
            {"status": "error", "error": str(e)}, status_code=500
        )

    return JSONResponse(
        {"status": "done", "chart": result, "progress": progress}
    )


# ---------------------------------------------------------------------------
# Optional: pre-warm the HF cache volume on first deploy.
#   modal run modal/audio2chart_app.py::prewarm --audio path/to/30s.wav
# ---------------------------------------------------------------------------

@app.local_entrypoint()
def prewarm(audio: str):
    """Run one inference locally-triggered to populate /cache/hf."""
    with open(audio, "rb") as f:
        data = f.read()
    call_id = uuid.uuid4().hex
    text = generate_chart.remote(call_id, data, os.path.basename(audio), {})
    print(f"prewarm ok, chart length: {len(text)} chars")
