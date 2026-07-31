---
name: API server test setup
description: How tests run in the api-server package, and the constraints on DB-backed route tests.
---

# Setup

The api-server has no test framework dependency — tests use Node's built-in runner
executed through `tsx` (needed because the source uses extensionless relative imports
that bare Node ESM cannot resolve).

Two non-obvious flags:

- `--import tsx` — required; plain `node --test` on the `.ts` sources fails on imports.
- `--conditions workspace` — required for any test that imports `@workspace/*` packages.
  The workspace packages export TypeScript source under a custom `workspace` export
  condition (see `tsconfig.base.json` `customConditions`); without the flag, resolution
  fails.

# Route-level tests

There is no test database. Route tests mount the real router on a throwaway express app
(with a middleware that stands in for auth by setting an admin `req.user`) and hit the
**development** database.

**Why:** the drizzle `db` singleton is imported at module load and reads `DATABASE_URL`;
there is no injection seam, and mocking it would test nothing real.

**How to apply:** any route test that writes rows must delete what it created in an
`after()` hook, and must call `pool.end()` so the process exits. Prefer assertions that
compare row counts before/after over assertions about absolute table contents — the dev
DB has real data in it.
