---
name: Cross-run event dedupe
description: How events are classified NEW/UPDATED/DUPLICATE across crawl runs (replaced the old prev-run diff)
---

Events carry a `dedupeKey` (name|date|domain) and a `contentHash` of significant fields. Before insert, `classifyEvents()` runs one batched query against all prior events:
- no dedupeKey match → NEW
- key match, same contentHash → DUPLICATE (skipped, never inserted)
- key match, different contentHash → UPDATED (inserted)

Per-run counters `newCount`/`updatedCount`/`duplicateCount` on crawl_runs track the outcome; legacy rows with NULL dedupeKey classify as NEW.

**Why:** The old approach diffed only against the previous completed run for the same URL list, so re-crawls kept re-inserting the same events. Content-hash dedupe works across all runs and skips true duplicates entirely.
**How to apply:** Any change to the fields feeding contentHash changes what counts as "updated" — keep the hash field list in dedupe.ts in sync with what users consider meaningful changes.
