---
name: DB schema/dev-DB drift reconciliation
description: How to reconcile committed Drizzle schema vs an out-of-sync dev Postgres when drizzle-kit push can't run.
---

# Reconciling schema ↔ dev-DB drift

`drizzle-kit push` is interactive — it prompts (rename vs drop/create) and needs a
TTY. In this non-interactive agent environment it fails, so when the committed Drizzle
schema and the dev Postgres have drifted, reconcile with **targeted SQL** instead of push.

**Why:** A committed schema change can land without the dev DB ever being pushed. The
server then 500s at boot (queries reference columns the DB doesn't have) and the
frontend can crash on the bad shape (e.g. a "not iterable" error when a column that
should hold an array still holds the old object).

**How to apply:**
1. Diff the schema source against the live DB columns to find the drift.
2. For a renamed column, `ALTER TABLE <t> RENAME COLUMN <old> TO <new>` — do NOT
   drop/recreate (that loses the row data).
3. If the column's value shape also changed (e.g. object → JSONB array), migrate the
   existing row(s) to match the schema's default shape in the same pass.
4. Re-probe boot health (scheduler init, the affected GET endpoint returns 200) before
   moving on.

This is reconciliation of *pre-existing* drift, separate from any feature edits — keep
it isolated and verify it independently.
