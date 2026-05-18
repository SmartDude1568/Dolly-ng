# Dolly

## Overview

Full-stack TypeScript application that generates Guitar Hero/Clone Hero chart files from audio. Splits audio into stems (vocals, drums, bass, etc.) via LALAL.ai, generates `.chart` files via the [audio2chart](https://github.com/3podi/audio2chart) model (run locally or on Modal GPU), merges them into a single chart, packages the result as a `.sng` archive, and optionally installs it into Clone Hero.

## Commands

- `npm test` - Run all tests (audio-analyzer, split, cache, chart, chart-merge)
- `npm run test:merge` - Chart parse/write/merge tests only
- `npm run test:split` - Split tests only
- `npm run test:cache` - Cache tests only
- `npm run test:chart` - Chart generation tests only
- `npm run migrate` - Apply Neon DB schema migrations (`db/schema.sql`)
- `npm run start` - Start the Express API server (`src/index.ts`)
- `npm run cli` - Run the CLI tool (`src/cli.ts`)
- `npx tsx src/cli.ts <audio-file> [options]` - Direct CLI invocation

## Architecture

### CLI (`src/cli.ts`)
Full pipeline: split stems → generate charts → merge → package SNG → install

### API Server (`src/index.ts`)
Express server exposing the design-doc REST API plus legacy `/split` and `/jobs` endpoints.

### Core modules
- `src/split.ts` - `StemSplitter<S>` interface (generic over stem types)
- `src/split/dummy.ts` - Mock splitter for testing
- `src/split/lalal.ts` - LALAL.ai API splitter (requires `LALAL_API_KEY`)
- `src/cache.ts` - `CachedSplitter` decorator (SHA-256 hash-based)
- `src/analysis.ts` - WAV audio analysis (peak/RMS levels, BPM detection)
- `src/chart.ts` - Local `Audio2Chart` wrapper (clones repo, sets up Python venv)
- `src/chart/parse.ts` - `.chart` file parser
- `src/chart/write.ts` - `.chart` file writer/serializer
- `src/chart/merge.ts` - Multi-chart merger (first-wins / last-wins / error strategies)
- `src/chart/modal.ts` - Client for the Modal-hosted GPU audio2chart service
- `src/sng.ts` - SNG binary archive packer (`packSng`, `packSngFromDir`, `writeSngFromDir`)
- `src/clonehero.ts` - Clone Hero installation detection (`findCloneHeroSongsDir`, `installSng`)

### API Server modules (`src/server/`)
- `db.ts` - Neon serverless Postgres connection
- `db-helpers.ts` - Async DB helpers for files, tasks, conversions
- `middleware.ts` - `requireAuth` Bearer-token middleware (validates against Neon sessions table)
- `stores.ts` - In-memory slot store (slots are live compute resources, not persisted)
- `types.ts` - Shared TypeScript types matching the design-doc API contract
- `routes/auth.ts` - POST /auth/register, /auth/login, /auth/logout (Neon DB backed)
- `routes/files.ts` - CRUD for uploaded audio files (Neon DB backed)
- `routes/tasks.ts` - Task lifecycle management (Neon DB backed)
- `routes/conversions.ts` - Full-pipeline conversion orchestration (Neon DB backed)
- `routes/slots.ts` - Internal slot assignment/release (in-memory)
- `routes/charts.ts` - Modal-backed chart generation job routes

### Database (`db/`)
- `schema.sql` - Idempotent DDL for all tables (users, sessions, files, tasks, conversions, conversion_tasks)
- `migrate.ts` - Migration runner (`npm run migrate`)

### Modal deployment (`modal/`)
- `audio2chart_app.py` - Modal app: GPU inference + FastAPI HTTP endpoints
- `requirements.txt` - Python deps for local development

### Frontend (`public/`)
- `index.html` / `app.js` / `style.css` - Single-page app (register, login, upload, conversions, chart generation)

## Dependencies

- **express** (^5.2.1) - HTTP server framework
- **multer** (^2.1.1) - Multipart file upload handling
- **express-rate-limit** (^8.3.0) - IP-based rate limiting
- **@neondatabase/serverless** (^1.0.2) - Neon PostgreSQL driver (HTTP-based, no persistent connection)
- **typescript** (^5.9.3) - TypeScript compiler
- **@types/node** (^25.0.9) - Node.js type definitions
- **tsx** (^4.19.0) - TypeScript execution engine for tests and CLI

## Key Patterns

- Splitters implement `StemSplitter<S>` interface; `CachedSplitter` is a decorator
- Tests are plain TypeScript files run via `tsx` (no Jest/Vitest)
- ESM modules (`"type": "module"` in package.json, `.js` import extensions)
- API routes are async Express 5 handlers (errors propagate automatically)
- Auth uses opaque bearer tokens stored in the Neon `sessions` table
- SNG format: binary container with XOR-masked file data and JSON metadata

## Auto-Update Instructions

After changes to files in this directory or subdirectories, run `/update-claude-md`
to keep this documentation synchronized with the codebase.
