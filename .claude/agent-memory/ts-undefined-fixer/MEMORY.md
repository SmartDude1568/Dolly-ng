# TS Undefined Fixer — Agent Memory

## Project Configuration
- `noUncheckedIndexedAccess: true` — ALL array/regex-match index accesses return `T | undefined`
- `strict: true`, `exactOptionalPropertyTypes: true`
- ESM modules, `.js` import extensions required
- Tests run via `tsx` (no Jest/Vitest), command: `npm test`

## Known Error Sites Fixed
- `src/chart.ts` line 138: `match[1]` from `String.match()` is `string | undefined`
  under `noUncheckedIndexedAccess`. Fixed by extending guard: `if (match && match[1] !== undefined)`.

## Recurring Pattern: Regex Match Index Access
`noUncheckedIndexedAccess` makes ALL indexed access on arrays (including `RegExpMatchArray`)
return `T | undefined`. Pattern:
```typescript
// WRONG — match[1] is string | undefined
const match = str.match(/foo(\d+)/);
if (match) { parseInt(match[1], 10); }

// CORRECT — narrow the capture group too
if (match && match[1] !== undefined) { parseInt(match[1], 10); }
```

## Architecture Notes
- `StemSplitter<S>` generic interface in `src/split.ts`
- `CachedSplitter` decorator in `src/cache.ts`
- `Audio2Chart` class in `src/chart.ts` — most error-prone due to subprocess/IO code
- Optional fields on `Audio2ChartOptions` correctly typed as `T | undefined` (preserve these)
