# Dolly

Generate playable **Guitar Hero / Clone Hero** songs from any audio file.

Dolly takes a song, separates it into per-instrument stems, charts each stem
with an ML model, merges everything into a single `.chart`, transcodes the
audio to Opus, packages the result as a real Clone Hero `.sng` archive, and
(optionally) drops it straight into your Clone Hero songs folder.

It ships as both a **command-line tool** and a **full-stack web app** (Express
API + browser frontend, backed by Neon Postgres).

---

## How it works

```
audio ──▶ stem split ──▶ chart each stem ──▶ merge ──▶ transcode audio ──▶ pack .sng ──▶ install
         (LALAL.ai)      (audio2chart)      (.chart)   (ffmpeg → Opus)    (mdsitton)    (Clone Hero)
```

1. **Split** — [LALAL.ai](https://www.lalal.ai/) separates the track into
   stems (vocals, drums, bass, guitar, …). Results are content-hash cached.
2. **Chart** — each stem is sent to the [audio2chart](https://github.com/3podi/audio2chart)
   model (run locally, or on a Modal GPU endpoint) which returns a `.chart`.
3. **Remap & merge** — each single-track chart is placed onto the correct
   Clone Hero instrument/difficulty (guitar lanes are translated to drum lanes
   for the drums track) and merged into one chart.
4. **Transcode** — audio is converted to Opus/OGG with bundled `ffmpeg`
   (Clone Hero's BASS engine rejects MP3 inside `.sng`).
5. **Package** — the chart, audio, and `song.ini` are packed into a `.sng`
   archive following the real [mdsitton SNG spec](https://github.com/mdsitton/SngFileFormat).
6. **Install** — optionally copied into your Clone Hero `Songs` directory.

---

## Requirements

- **Node.js 18+** (uses [`tsx`](https://github.com/privatenumber/tsx); no build step needed)
- A **LALAL.ai API key** for real stem splitting (`LALAL_API_KEY`)
- A **Neon Postgres** database for the web app (`DATABASE_URL`)
- `ffmpeg` is bundled via `ffmpeg-static` — nothing to install

For local (non-Modal) charting, `src/chart.ts` clones the audio2chart repo and
sets up a Python venv on first use, so a working `python3` is required.

## Install

```bash
npm install
```

## Configuration

Create a `.env` file in the project root (loaded automatically via `dotenv`):

```dotenv
# Stem splitting
LALAL_API_KEY=your_lalal_key

# Web app database
DATABASE_URL=postgres://user:pass@host/db

# Modal audio2chart endpoint (one-shot: POST `audio` field → .chart bytes)
MODAL_GENERATE_URL=https://melvillevt--audio2chart-generate.modal.run
AUDIO2CHART_TOKEN=optional_shared_secret

# Server
PORT=3000

# Optional output overrides
OUTPUT_DIR=./output
CHARTS_OUTPUT_DIR=./output/charts
```

---

## CLI

Run the full pipeline against a single audio file:

```bash
# List available stems for a splitter
npx tsx src/cli.ts --splitter dummy --list-stems

# Split a song into stems
npx tsx src/cli.ts song.mp3 --splitter lalal --stems vocals,drum --api-key $LALAL_API_KEY

# Split, chart, package a .sng, and install into Clone Hero
npx tsx src/cli.ts song.mp3 --splitter lalal --stems guitar,bass,drum \
    --chart --sng --install-ch \
    --song-name "My Song" --song-artist "Some Band"
```

Useful flags (`--help` for the full list):

| Flag | Description |
| --- | --- |
| `--splitter <dummy\|lalal>` | Stem splitter (`dummy` = offline mock) |
| `--stems <list>` | Comma-separated stems to extract |
| `--output <dir>` | Output directory (default `./output`) |
| `--no-cache` | Disable the content-hash split cache |
| `--chart` | Generate charts after splitting |
| `--merge <files...>` | Merge existing `.chart` files into one |
| `--sng` | Package the result as a `.sng` archive |
| `--install-ch` | Copy the `.sng` into the Clone Hero songs folder |
| `--song-name` / `--song-artist` / `--song-genre` / `--charter-name` | Chart metadata |

---

## Web app

```bash
npm run migrate   # apply db/schema.sql to your Neon database
npm run start     # start the Express API on $PORT (default 3000)
```

Then open `http://localhost:3000` — the frontend (`public/`) supports register
/ login, uploading audio, kicking off conversions, and downloading the
finished `.sng`.

### REST API

All `/v1/*` routes require a `Authorization: Bearer <token>` header (obtained
from `/v1/auth/login`).

| Method & path | Purpose |
| --- | --- |
| `POST /v1/auth/register` · `login` · `logout` | Account + session management |
| `POST /v1/files/upload` · `GET /v1/files` · `GET /v1/files/:id/download` · `DELETE /v1/files/:id` | Uploaded audio files |
| `POST /v1/conversions` | Start a full conversion (rejects audio under the minimum length) |
| `GET /v1/conversions/:id` · `GET /v1/conversions` | Conversion status / list |
| `POST /v1/conversions/:id/retry` | Re-run a failed / interrupted conversion |
| `GET /v1/conversions/:id/download` | Download the finished `.sng` |
| `POST /v1/tasks` · `GET /v1/tasks` · `GET /v1/tasks/:id` · `DELETE /v1/tasks/:id` | Task lifecycle |
| `POST /charts` | One-shot chart generation via the Modal endpoint |

The conversion **worker** (`src/server/worker.ts`) runs the pipeline in-process
and updates task/conversion rows as it goes. Conversions stranded by a server
restart are automatically re-run on startup (`src/server/resume.ts`).

---

## Project layout

```
src/
  cli.ts              Full-pipeline command-line tool
  index.ts            Express API server entrypoint
  split.ts, split/    StemSplitter interface + dummy / LALAL implementations
  cache.ts            Content-hash split cache (decorator)
  analysis.ts         WAV peak/RMS/BPM analysis
  audio-duration.ts   ffmpeg-based duration probe
  chart.ts, chart/    Local + Modal audio2chart clients, .chart parse/write/merge
  sng.ts              Clone Hero .sng archive packer (mdsitton spec)
  clonehero.ts        Clone Hero install detection
  server/             API routes, worker, resume, Neon DB helpers, middleware
db/                   schema.sql + migration runner
modal/                Modal GPU app for audio2chart
public/               Browser frontend (auth / dashboard pages)
tests/                Plain-tsx tests + Playwright browser e2e
```

See [`CLAUDE.md`](./CLAUDE.md) for a deeper architecture reference.

---

## Tests

Tests are plain TypeScript files run via `tsx` (no Jest/Vitest):

```bash
npm test              # audio-analyzer, split, cache, chart, chart-merge
npm run test:merge    # chart parse/write/merge only
npm run test:split    # split only
npm run test:cache    # cache only
npm run test:chart    # chart generation only

# Browser end-to-end (needs the server running + LALAL_API_KEY)
npx tsx tests/browser-e2e.ts
```

---

## License

GPL-3.0-only © Aidan Walker
