---
name: lib-db build order for typecheck
description: Adding new schema files to lib/db requires rebuilding the lib dist before api-server typecheck will see them.
---

# lib-db build order for typecheck

When you add a new file to `lib/db/src/schema/` (e.g. `organizations.ts`) and export it from `lib/db/src/schema/index.ts`, the api-server's TypeScript project reference still reads from `lib/db/dist/`. Until you rebuild, the dist is stale and `tsc` reports "Module '@workspace/db' has no exported member 'organizationsTable'" even though `src/` is correct.

**Fix:** run `pnpm run typecheck:libs` at the workspace root before running `pnpm --filter @workspace/api-server run typecheck`. The `typecheck:libs` script calls `tsc --build` which recompiles all lib packages and writes fresh `.d.ts` into their `dist/` folders.

**Why:** `artifacts/api-server/tsconfig.json` uses `"references": [{ "path": "../../lib/db" }]` which tells tsc to read compiled declarations, not source. The api-server's own `typecheck` script (`tsc -p tsconfig.json --noEmit`) does NOT trigger the lib build step.

**How to apply:** Any time lib schema changes are made, always run `pnpm run typecheck:libs` first. The root `pnpm run typecheck` does both steps in sequence so it's always safe to run.
