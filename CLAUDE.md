# Dolly

## Overview

TypeScript CLI tool that generates Guitar Hero/Clone Hero chart files from audio. Splits audio into stems (vocals, drums, bass, etc.) and optionally generates playable charts via the [audio2chart](https://github.com/3podi/audio2chart) Python tool.

## Commands

- `npm test` - Run all tests (audio-analyzer, split, cache, chart)
- `npm run test:split` - Split tests only
- `npm run test:cache` - Cache tests only
- `npm run test:chart` - Chart generation tests only
- `npx tsx src/index.ts <audio-file> [options]` - Run the CLI

## Architecture

- `src/index.ts` - CLI entrypoint, arg parsing, orchestration
- `src/split.ts` - `StemSplitter` interface (generic over stem types)
- `src/split/dummy.ts` - Mock splitter for testing (no real API calls)
- `src/split/lalal.ts` - LALAL.ai API splitter (requires `LALAL_API_KEY`)
- `src/cache.ts` - `CachedSplitter` decorator (SHA-256 hash-based file cache)
- `src/analysis.ts` - WAV audio analysis (peak/RMS levels, BPM detection)
- `src/chart.ts` - `Audio2Chart` wrapper (clones repo, sets up Python venv, runs inference)
- `tests/` - Test files using `tsx` directly (no test framework)

## Dependencies

<!-- AUTO-GENERATED - DO NOT EDIT -->
- **typescript** (^5.9.3) - TypeScript compiler
- **@types/node** (^25.0.9) - Node.js type definitions
- **tsx** (^4.19.0) - TypeScript execution engine for tests and CLI

## Key Patterns

- Splitters implement `StemSplitter<S>` interface with generic stem type parameter
- `CachedSplitter` wraps any `StemSplitter` as a decorator
- Tests are plain TypeScript files run via `tsx` (no Jest/Vitest)
- ESM modules (`"type": "module"` in package.json, `.js` import extensions)

## Auto-Update Instructions

After changes to files in this directory or subdirectories, run `/update-claude-md`
to keep this documentation synchronized with the codebase.
