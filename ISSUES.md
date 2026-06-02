# Dolly Repository Audit Issues

Audit date: 2026-06-01.

Scope: source server/client code, local generated artifacts, dependency audit,
database schema/helpers, conversion worker, audio parsing, and tests. Severity is
based on likely impact if this repo is deployed as-is.

## Open Issues

No open audit issues remain from this list.

## Notes From The Audit

- SQL queries in current `src/` code are parameterized; dynamic ORDER/UPDATE
  cases use whitelists.
- Current source hashes session tokens before storing them.
- Current source protects `/v1/files`, `/v1/tasks`, `/v1/conversions`,
  `/charts`, and legacy `/split` with auth.
- `INTERNAL_API_TOKEN` handling for `/v1/internal/slots` is fail-closed.
- `npm run test:unit` passed.
