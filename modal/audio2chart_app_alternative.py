"""
audio2chart Modal deployment
============================
Deploys the audio2chart model (https://github.com/3podi/audio2chart) as a
serverless GPU-backed HTTP endpoint on Modal.

Verified against:
    - generate.py (default model, temperature, top_k, bpm, resolution, output behavior)
    - inference/engine.py (30s minimum audio requirement, Charter.from_pretrained)
    - requirements.txt (torch==2.9.1, numba==0.62.1 → needs Python 3.10-3.13)

Setup:
    pip install modal
    modal setup          # one-time auth

Usage:
    # Test locally (ephemeral endpoint, hot-reloads on save)
    modal serve audio2chart_modal.py

    # Deploy persistently
    modal deploy audio2chart_modal.py

Calling the endpoint:

    # Minimal — just an audio file (must be >= 30 seconds)
    curl -X POST https://<your-workspace>--audio2chart-generate.modal.run \\
        -F "audio=@/path/to/song.mp3" \\
        -o notes.chart

    # Full options
    curl -X POST https://<your-workspace>--audio2chart-generate.modal.run \\
        -F "audio=@/path/to/song.mp3" \\
        -F "model_name=3podi/charter-v1.0-40-M-best-acc" \\
        -F "temperature=0.5" \\
        -F "top_k=32" \\
        -F "bpm=200" \\
        -F "resolution=480" \\
        -F "name=My Song" \\
        -F "artist=Artist Name" \\
        -F "album=My Album" \\
        -F "genre=Rock" \\
        -F "charter=audio2chart" \\
        -o notes.chart

    # From TypeScript / Node.js (e.g. calling from NanoClaw)
    const form = new FormData();
    form.append("audio", fs.createReadStream("song.mp3"));
    form.append("name", "My Song");
    form.append("artist", "Artist Name");
    const res = await fetch(MODAL_ENDPOINT_URL, { method: "POST", body: form });
    const chartBuffer = await res.arrayBuffer();
    fs.writeFileSync("notes.chart", Buffer.from(chartBuffer));

Costs:
    ~$0.08-0.16/hr on a T4 GPU, billed per-second.
    Modal gives $30/month free credits — enough for hundreds of chart generations.
    Scales to zero when idle (no cost when not in use).
"""

import modal
from fastapi import File, Form, UploadFile

# ---------------------------------------------------------------------------
# Container image
#
# The repo's requirements.txt is a full pip freeze with pinned versions
# (torch==2.9.1, numpy==2.3.4, numba==0.62.1, etc.). Rather than installing
# that huge pinned set (which may conflict with Modal's CUDA drivers), we
# install the core deps the code actually imports, then let pip resolve
# compatible versions.
#
# Core deps derived from reading the actual source:
#   generate.py       → torch, argparse (stdlib)
#   inference/engine.py → torch, transformers (EncodecModel, AutoProcessor),
#                         huggingface_hub, tqdm, librosa
#   chart/*            → (pure python, no extra deps)
#   modules/trainer.py → pytorch-lightning (only needed for training, not inference)
#   configs/           → hydra-core, omegaconf (only needed for training)
# ---------------------------------------------------------------------------
image = (
    modal.Image.debian_slim(python_version="3.13")
    .apt_install("git", "ffmpeg", "libsndfile1")
    .run_commands(
        "git clone https://github.com/3podi/audio2chart.git /opt/audio2chart",
        # Install from the repo's pinned requirements.txt for reproducibility.
        # This includes torch==2.9.1, torchaudio==2.9.1, transformers==4.57.1,
        # librosa==0.11.0, encodec deps via transformers, numba, scipy, etc.
        "pip install -r /opt/audio2chart/requirements.txt",
        # FastAPI + python-multipart for UploadFile + Form() fields
        "pip install 'fastapi[standard]' python-multipart",
    )
)

app = modal.App("audio2chart", image=image)

# ---------------------------------------------------------------------------
# Persistent volume for caching HuggingFace model weights across cold starts.
# First invocation downloads the Encodec model (~100MB) + Charter weights
# (~900MB for M, ~100MB for S). Subsequent cold starts reuse the cache.
# ---------------------------------------------------------------------------
model_cache = modal.Volume.from_name("audio2chart-model-cache", create_if_missing=True)

REPO_DIR = "/opt/audio2chart"
CACHE_DIR = "/cache/huggingface"
OUTPUT_DIR = "/tmp/audio2chart-output"


# ---------------------------------------------------------------------------
# POST /generate — upload audio file, receive .chart file
#
# generate.py behavior (verified from source):
#   - audio_path: positional arg, must be >= 30 seconds
#   - --model_name: default "3podi/charter-v1.0-40-M-best-acc"
#   - --temperature: default 0.5 (recommended 0.4-0.6)
#   - --top_k: default 32 (recommended 5-32)
#   - --bpm: default 200
#   - --resolution: default 480
#   - --output: FOLDER path. Script creates <output>/notes.chart
#   - --name, --artist, --album, --genre, --charter: optional metadata
# ---------------------------------------------------------------------------
@app.function(
    gpu="any",  # T4 / L4 / A10G — any is fine for 227M params
    timeout=600,  # 10 min max per request
    volumes={CACHE_DIR: model_cache},
    scaledown_window=120,  # keep warm 2 min between requests
)
@modal.fastapi_endpoint(method="POST")
async def generate(
    audio: UploadFile = File(
        ..., description="Audio file (.mp3 or .wav), must be >= 30 seconds"
    ),
    model_name: str = Form("3podi/charter-v1.0-40-M-best-acc"),
    temperature: float = Form(0.5),
    top_k: int = Form(32),
    bpm: int = Form(200),
    resolution: int = Form(480),
    name: str = Form(""),
    artist: str = Form(""),
    album: str = Form(""),
    genre: str = Form(""),
    charter: str = Form(""),
):
    """
    Generate a Guitar Hero / Clone Hero .chart file from uploaded audio.

    Accepts multipart/form-data with an `audio` file field (.mp3 or .wav,
    must be at least 30 seconds long) and optional metadata/tuning fields.
    Returns the raw .chart file content as a download.

    Recommended parameter ranges:
    - temperature: 0.4–0.6 (lower = more stable, higher = more complex)
    - top_k: 5–32 (lower = safer patterns, higher = more diverse)
    """
    import os
    import subprocess
    import sys
    import tempfile
    from pathlib import Path

    from fastapi.responses import FileResponse, JSONResponse

    # Point HuggingFace cache at our persistent volume
    os.environ["HF_HOME"] = CACHE_DIR
    os.environ["TRANSFORMERS_CACHE"] = os.path.join(CACHE_DIR, "hub")

    # Write uploaded audio to a temp file, preserving the original extension
    audio_bytes = await audio.read()
    suffix = Path(audio.filename).suffix if audio.filename else ".mp3"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, dir="/tmp") as f:
        f.write(audio_bytes)
        audio_path = f.name

    # Clean output directory between invocations
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    for old in Path(OUTPUT_DIR).glob("*.chart"):
        old.unlink()

    # -------------------------------------------------------------------
    # Build generate.py args
    # Mirrors: github.com/SmartDude1568/Dolly-ng/blob/main/src/chart.ts
    #          -> Audio2Chart.buildArgs()
    #
    # Note: --output is a FOLDER. generate.py creates <folder>/notes.chart
    # -------------------------------------------------------------------
    args = [
        sys.executable,
        os.path.join(REPO_DIR, "generate.py"),
        audio_path,
        "--output",
        OUTPUT_DIR,
        "--model_name",
        model_name,
        "--temperature",
        str(temperature),
        "--top_k",
        str(top_k),
        "--bpm",
        str(bpm),
        "--resolution",
        str(resolution),
    ]

    if name:
        args.extend(["--name", name])
    if artist:
        args.extend(["--artist", artist])
    if album:
        args.extend(["--album", album])
    if genre:
        args.extend(["--genre", genre])
    if charter:
        args.extend(["--charter", charter])

    # Run generate.py as a subprocess from the repo directory
    result = subprocess.run(
        args,
        cwd=REPO_DIR,
        capture_output=True,
        text=True,
        timeout=540,  # 9 min hard limit (function timeout is 10 min)
    )

    # Clean up temp audio file
    try:
        os.unlink(audio_path)
    except OSError:
        pass

    if result.returncode != 0:
        # Surface the 30-second minimum error clearly
        stderr = result.stderr or ""
        stdout = result.stdout or ""
        error_msg = "generate.py failed"
        if "must be >= 30" in stderr or "must be >= 30" in stdout:
            error_msg = "Audio file must be at least 30 seconds long"

        return JSONResponse(
            status_code=422 if "must be >= 30" in (stderr + stdout) else 500,
            content={
                "error": error_msg,
                "stderr": stderr[-2000:],
                "stdout": stdout[-2000:],
            },
        )

    # Persist downloaded model weights for faster subsequent cold starts
    await model_cache.commit.aio()

    # generate.py creates <output_folder>/notes.chart
    # But if --name is not set, it uses the audio filename as subfolder name:
    #   <output_folder>/<song_name>/notes.chart  (when --output is not set)
    #   <output_folder>/notes.chart              (when --output IS set)
    #
    # Since we always pass --output, the chart lands at OUTPUT_DIR/notes.chart
    chart_path = Path(OUTPUT_DIR) / "notes.chart"

    if not chart_path.exists():
        # Fallback: search recursively in case the behavior changed
        chart_files = list(Path(OUTPUT_DIR).rglob("*.chart"))
        if not chart_files:
            return JSONResponse(
                status_code=500,
                content={
                    "error": "No .chart file produced",
                    "stdout": (result.stdout or "")[-2000:],
                    "stderr": (result.stderr or "")[-2000:],
                    "output_dir_contents": [
                        str(p) for p in Path(OUTPUT_DIR).rglob("*")
                    ][:20],
                },
            )
        chart_path = max(chart_files, key=lambda p: p.stat().st_mtime)

    return FileResponse(
        path=str(chart_path),
        media_type="application/octet-stream",
        filename="notes.chart",
    )


# ---------------------------------------------------------------------------
# GET /health — lightweight health check (no GPU needed)
# ---------------------------------------------------------------------------
@app.function()
@modal.fastapi_endpoint(method="GET")
def health():
    return {
        "status": "ok",
        "service": "audio2chart",
        "default_model": "3podi/charter-v1.0-40-M-best-acc",
        "min_audio_duration_sec": 30,
    }
