# Dolly

## Overview

Full-stack TypeScript application that generates Guitar Hero/Clone Hero chart files from audio. Splits audio into stems (vocals, drums, bass, etc.) via LALAL.ai, generates `.chart` files via the [audio2chart](https://github.com/3podi/audio2chart) model (run locally or on Modal GPU), merges them into a single chart, packages the result as a `.sng` archive, and optionally installs it into Clone Hero.

On upload the song's tempo is auto-detected; the dashboard lets the user verify/correct it against a built-in metronome before charting. The confirmed BPM is stored with the file and passed to audio2chart so note timing and the final `notes.chart` [SyncTrack] tempo are accurate.

## Commands

- `npm test` - Run all tests (audio-analyzer, bpm, split, cache, chart, chart-merge, sng, audio2chart, clonehero, audio-duration, **metrics**, **api-e2e**)
- `npm run test:unit` - All unit tests (everything except the API e2e)
- `npm run test:e2e` - Hermetic API end-to-end test only (`tests/api-e2e.test.ts`)
- `npm run test:bpm` - BPM detection tests only
- `npm run test:merge` - Chart parse/write/merge tests only
- `npm run test:split` - Split tests only
- `npm run test:cache` - Cache tests only
- `npm run test:chart` - Chart generation tests only
- `npm run test:sng` - SNG packer tests only
- `npm run test:audio2chart` - Modal audio2chart client tests only
- `npm run test:clonehero` - Clone Hero install/detection tests only
- `npm run test:duration` - Audio duration probe tests only
- `npm run test:metrics` - Quality-metrics registry + /metrics endpoint tests only
- `npm run migrate` - Apply Neon DB schema migrations (`db/schema.sql`)
- `npm run start` - Start the Express API server (`src/index.ts`)
- `npm run cli` - Run the CLI tool (`src/cli.ts`)
- `npx tsx src/cli.ts <audio-file> [options]` - Direct CLI invocation

## Architecture

### CLI (`src/cli.ts`)
Full pipeline: split stems → generate charts → merge → package SNG → install

### API Server (`src/index.ts`)
Thin entrypoint: builds the app via `createApp()` (`src/server/app.ts`), binds the port, and runs the startup resume sweep. `createApp()` wires the design-doc REST API plus legacy `/split` and `/jobs` endpoints; it takes `{ rateLimit }` (tests disable the limiter).

### Core modules
- `src/split.ts` - `StemSplitter<S>` interface (generic over stem types)
- `src/split/dummy.ts` - Mock splitter for testing
- `src/split/lalal.ts` - LALAL.ai API splitter (requires `LALAL_API_KEY`)
- `src/cache.ts` - `CachedSplitter` decorator (SHA-256 hash-based)
- `src/analysis.ts` - WAV audio analysis (peak/RMS levels, BPM detection via onset autocorrelation)
- `src/bpm.ts` - `detectBpm(path)` for **any** format: transcodes a bounded, downsampled mono WAV via ffmpeg, then runs `AudioAnalyzer`. Used by the files upload route
- `src/chart.ts` - Local `Audio2Chart` wrapper (clones repo, sets up Python venv)
- `src/chart/parse.ts` - `.chart` file parser
- `src/chart/write.ts` - `.chart` file writer/serializer
- `src/chart/merge.ts` - Multi-chart merger (first-wins / last-wins / error strategies)
- `src/chart/modal.ts` - Spawn/poll client for a Modal deployment (legacy shape; not the live endpoint)
- `src/chart/audio2chart.ts` - **One-shot** client matching the live Modal endpoint (POST `audio` → `.chart` bytes). Used by the worker and `/charts`
- `src/sng.ts` - SNG binary archive packer (`packSng`, `packSngFromDir`, `writeSngFromDir`). Implements the real mdsitton SNG spec: `SNGPKG` + uint32 version + 16-byte xorMask, sections metadata→fileindex→filedata, **absolute** `contentsIndex`, masking `xorMask[i%16] ^ (i&0xFF)` (per-file index)
- `src/identify.ts` - Song identification. `identifySong(audioPath, {workDir})` cuts a 12 s mono 44.1 kHz WAV snippet with ffmpeg, runs `scripts/identify_song.py` (ShazamIO; `SHAZAM_PYTHON` interpreter, `SONG_IDENTIFY=off` disables) and downloads the cover (https only, ≤5 MB, JPEG/PNG magic check, tries a 1000x1000 rendition first). `identifyWithCache` stores the answer (incl. "no match") in the conversion's work dir so resumes don't re-query; failures are logged and yield `null`, never fail a conversion. `resolveSongMetadata` precedence per field: user-typed > Shazam > old default (`Dolly`/`audio2chart`/`Rock`, file name as title). `validateUserSongMetadata` validates the `metadata` body field
- `src/clonehero.ts` - Clone Hero installation detection (`findCloneHeroSongsDir`, `installSng`)
- `src/metrics.ts` - Process-global, dependency-free in-memory **quality-metrics registry** (`metrics`). Tracks the design-doc Quality Metrics: cache hits/misses, errors per module, input audio length, and stemmer + audio2chart process durations. `snapshot()` returns the aggregated view served by `GET /metrics`; `serialize()`/`hydrate()` round-trip the full state for DB persistence, with an `isDirty()`/`clearDirty()` flag so the server flushes only on change. Importable from both CLI and server (no DB dependency — persistence lives in the server layer)

### API Server modules (`src/server/`)
- `app.ts` - `createApp(opts)` Express application factory (no port binding); used by `src/index.ts` and the API e2e test
- `db.ts` - Neon serverless Postgres connection. Executor is **lazy** (importing never throws when `DATABASE_URL` is unset) and **injectable** via `setSqlExecutor()` (tests inject an in-memory `pg-mem` Postgres)
- `metrics-store.ts` - Postgres-backed persistence for the `src/metrics.ts` registry, via the shared `sql` executor (same Neon DB / `DATABASE_URL`). `hydrateMetrics()` loads the last snapshot on startup; `startMetricsPersistence()` flushes (debounced, only when dirty) on a timer; `flushMetrics()` upserts on shutdown. The whole snapshot is stored as one JSON string in the single-row `metrics_state` table, keyed by `METRICS_DB_KEY` (default `global`). Ensures its table exists (`CREATE TABLE IF NOT EXISTS`) and swallows DB errors, so it no-ops gracefully when `DATABASE_URL` is unset
- `db-helpers.ts` - Async DB helpers for files, tasks, conversions
- `middleware.ts` - `requireAuth` Bearer-token middleware (validates against Neon sessions table)
- `stores.ts` - In-memory slot store (slots are live compute resources, not persisted)
- `types.ts` - Shared TypeScript types matching the design-doc API contract
- `worker.ts` - In-process conversion pipeline: Shazam identify (best effort; `WorkerExternals.identifySong` is the test seam, skipped when externals are overridden without it; fills `[Song]`/.sng metadata and packs `album.jpg|png`) → LALAL split → per-stem audio2chart (Modal, fed the file's confirmed `bpm` plus the original upload as `beatAudioPath` for beat tracking; drums are requested with `sustains: false`) → track remap (`remapChartTracks`: every `<Difficulty>Single` track the model returns lands on the instrument's section under its own difficulty prefix; an Expert-only payload is placed on the requested difficulty as before) → merge → reconcile SyncTrack tempo (`enforceTempo`: keeps the returned tempo map when its median tempo is within 10% of the confirmed BPM, otherwise writes one constant `0 = B <bpm×1000>`) → transcode audio to Opus (ffmpeg) → pack `.sng` → store output; updates task/conversion rows as it goes. The two external services (LALAL splitter + audio2chart client) are **injectable** via `setWorkerExternals()` so tests run the full pipeline against in-process fakes. Records metrics: stemmer + audio2chart durations and per-stage errors (tagged by task type) into `src/metrics.ts`
- `routes/auth.ts` - POST /auth/register, /auth/login, /auth/logout (Neon DB backed)
- `routes/files.ts` - CRUD for uploaded audio files (Neon DB backed). Auto-detects BPM on upload (via `src/bpm.ts`); `PATCH /files/:id` updates the confirmed `bpm`; `bpm` is returned on upload/GET/list. Records the input audio length (and any BPM-detection error) into `src/metrics.ts` on upload
- `routes/tasks.ts` - Task lifecycle management (Neon DB backed)
- `routes/conversions.ts` - Full-pipeline conversion orchestration (optional `metadata` body field is validated and stored on the `upload_s3` task settings); starts the worker on POST, serves the packaged `.sng` at `GET /v1/conversions/:id/download`
- `routes/slots.ts` - Internal slot assignment/release (in-memory + DB task lookups)
- `routes/charts.ts` - Modal-backed chart generation job routes (one-shot `Audio2ChartModal`)
- `routes/metrics.ts` - `GET /metrics` quality-metrics dashboard. Content-negotiated: browser (`Accept: text/html`) gets the `public/metrics.html` dashboard, API clients (`?format=json` or `Accept: application/json`) get the `metrics.snapshot()` JSON. Unauthenticated + rate-limit-exempt (mounted before those middlewares in `app.ts`, like `/health`)

### Database (`db/`)
- `schema.sql` - Idempotent DDL for all tables (users, sessions, files, tasks, conversions, conversion_tasks, `metrics_state`). `files.bpm REAL` (nullable) and `files.kind TEXT DEFAULT 'source'` added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. `kind` is `'source'` (uploaded audio) or `'output'` (generated artifact, e.g. the packaged `.sng`); only `'source'` files are listed as songs / accepted as conversion inputs (the worker tags its `.sng` output `'output'`; `dbListFiles` defaults to `kind='source'`; `POST /conversions` rejects `'output'`)
- `migrate.ts` - Migration runner (`npm run migrate`)

### Modal deployment (`modal/`)
- `audio2chart_app_alternative.py` - **The live Modal app** (`POST /generate`, multipart `audio` + optional `beat_audio` → raw `.chart`). Shells out to `generate.py` from a pinned upstream audio2chart commit (`UPSTREAM_COMMIT`) with `--tempo auto`; the confirmed `bpm` form field (float, 0 = unknown) is passed as `--bpm` and `beat_audio` as `--beat-audio`. The optional `sustains` form field (default true) maps to `--no-sustains`
- `audio2chart_overlay/` - `generate.py` + `chart/{postprocess,tempo,chart_writer}.py` from our audio2chart working copy, copied over the upstream checkout at image build. Adds sustains, star power, `[Events]` sections and Hard/Medium/Easy reductions, so the returned chart has `[ExpertSingle]`, `[HardSingle]`, `[MediumSingle]` and `[EasySingle]`. Also aligns notes to the audio (drops notes past the end of the audio or in silence, moves each note onto the audio onset it describes, charts audible onsets the model skipped, thins to playable strum speed and note rates, makes density follow loudness) — all on by default and judged against the stem the model was given, so the per-stem call must receive the stem, with the full mix as `beat_audio`. Un-ignored in `.gitignore` (the rest of `modal/` is ignored). Keep in sync with `audio2chart/chart/` and `audio2chart/generate.py`
- `audio2chart_app.py` - Older spawn/poll Modal app (not the live endpoint; does not use the overlay)
- `requirements.txt` - Python deps for local development

### Frontend (`public/`)
- `index.html` / `auth.html` / `dashboard.html` / `common.js` / `dashboard.js` / `style.css` - Multi-page app (register, login, upload, conversions, chart generation)
- `metrics.html` / `metrics.js` - Quality-metrics dashboard: polls `GET /metrics?format=json` (every 5s, auto-refresh toggle) and renders KPI cards, the cache hit/miss bar, stemmer + audio2chart duration tables, input-audio-length stats, errors-by-module, and a recent-activity feed. Plain `fetch` (no auth needed). Linked from the nav
- `metronome.js` - `Dolly.openTempo({...})` tempo-verification modal: plays the song with a WebAudio click locked to a BPM (scheduler re-anchors the AudioContext clock to the `<audio>` element each tick), with a visual beat indicator, ± nudge, tap-tempo, and Save (PATCH `/files/:id`). Opened after upload and from each song row's "Tempo" button

## Dependencies

- **express** (^5.2.1) - HTTP server framework
- **multer** (^2.1.1) - Multipart file upload handling
- **express-rate-limit** (^8.3.0) - IP-based rate limiting
- **@neondatabase/serverless** (^1.0.2) - Neon PostgreSQL driver (HTTP-based, no persistent connection)
- **typescript** (^5.9.3) - TypeScript compiler
- **@types/node** (^25.0.9) - Node.js type definitions
- **tsx** (^4.19.0) - TypeScript execution engine for tests and CLI
- **dotenv** - Loads `.env` (imported at the top of `src/index.ts`; `.env` was previously never loaded)
- **ffmpeg-static** - Bundled ffmpeg binary; worker transcodes audio to Opus for Clone Hero
- **playwright** (dev) - Drives the browser end-to-end test (`tests/browser-e2e.ts`)
- **pg-mem** (dev) - In-memory Postgres injected into `db.ts` by the hermetic API e2e (`tests/api-e2e.test.ts`)

## Key Patterns

- Splitters implement `StemSplitter<S>` interface; `CachedSplitter` is a decorator
- Tests are plain TypeScript files run via `tsx` (no Jest/Vitest); each file is its own runner that exits non-zero on failure
- **Hermetic API e2e** (`tests/api-e2e.test.ts`): drives the real `createApp()` + real worker through register→login→upload→confirm BPM→convert→poll→download, with `pg-mem` injected for the DB and fake split/chart services injected into the worker — no live LALAL/Modal/Neon and no secrets. ffmpeg (duration probe + Opus transcode) runs for real. It unpacks the downloaded `.sng` and asserts the merged `notes.chart` (track remap, drum-lane legality, enforced tempo)
- **Browser e2e** (`tests/browser-e2e.ts`): the live-service path — `npx tsx tests/browser-e2e.ts` (needs the server running + `LALAL_API_KEY`)
- ESM modules (`"type": "module"` in package.json, `.js` import extensions)
- API routes are async Express 5 handlers (errors propagate automatically)
- Auth uses opaque bearer tokens stored in the Neon `sessions` table
- SNG format: real Clone Hero `.sng` (mdsitton spec) — see `src/sng.ts`. Audio **must be Opus/OGG**; CH's BASS rejects MP3 with a `FileFormat` error
- Conversion instrument→stem→track map (worker): guitar→`electric_guitar`→`Single`, bass→`bass`→`DoubleBass`, drums→`drum`→`Drums`, keys→`piano`→`Keyboard`. audio2chart emits `ExpertSingle` plus (with the overlay) `HardSingle`/`MediumSingle`/`EasySingle`, remapped per instrument; the requested difficulty then only decides the `song.ini` diff value and which track must have notes for an instrument to be kept
- BPM flow: detect on upload (`src/bpm.ts`) → store on `files.bpm` → user confirms via metronome (`PATCH /files/:id`) → worker forwards it to audio2chart as `bpm` together with the original upload as `beat_audio` (the full mix; the stems themselves are too unreliable to beat-track). audio2chart beat-tracks the mix and writes a tempo map that follows the beats, using the confirmed BPM only to pick the beat octave (or, if the tracker and the user disagree, a constant tempo within 1.5% of it). The returned SyncTrack is therefore the one the notes' ticks are timed against: `enforceTempo` keeps it when its median tempo is within 10% of the confirmed BPM and replaces it with one constant `0 = B <bpm×1000>` otherwise. `.chart` encodes tempo as milli-BPM
- Quality metrics (design-doc "Quality Metrics"): the `metrics` singleton in `src/metrics.ts` collects cache hits/misses (`cache.ts`), per-module errors + stemmer/audio2chart durations (`worker.ts`), and input audio length (`files.ts`) in memory. Surfaced at `GET /metrics` (dashboard + JSON). **Persisted to Postgres** (the existing Neon DB / `DATABASE_URL`) so counts survive restarts: the server hydrates on startup and flushes the serialized snapshot to the `metrics_state` table on a debounce + on shutdown (`src/server/metrics-store.ts`). Without a configured DB it no-ops gracefully (in-memory only). To track a new metric: record into `metrics` at the source, extend `snapshot()` + `serialize()`/`hydrate()`, and the dashboard

## Auto-Update Instructions

After changes to files in this directory or subdirectories, run `/update-claude-md`
to keep this documentation synchronized with the codebase.
