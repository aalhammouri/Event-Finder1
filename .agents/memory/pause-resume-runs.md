---
name: Crawl run pause/resume design
description: Invariants for pausing, resuming, and crash-recovering crawl runs
---

- Pause is cooperative: workers check `pausedRuns` before starting each new site; in-flight sites finish and their results are saved. `finalize("paused")` leaves `completedAt` null.
- Runs persist `seedUrls` (the exact URL set they started with) and `completedUrls` (sites fully processed). Resume = seedUrls minus completedUrls. Never rebuild the remaining set from the URL list — retry-runs use a subset, and resuming from the full list re-crawls everything.
- Resume must 409 while `logBuffers.has(runId)` — that means the old loop is still winding down in this process, and starting a second loop double-crawls and corrupts counters (the new `startCrawlRun` clears `pausedRuns`, un-pausing the old loop).
- On boot, `recoverInterruptedRuns()` marks running/pending rows as paused before the scheduler starts, so restarts turn crashes into resumable runs.
- `logBuffers.has(id)` is the canonical "crawl loop alive in this process" signal; finalize deletes it.

**Why:** Pause/resume shares mutable module-level state (pausedRuns/stoppedRuns/logBuffers) between HTTP handlers and the async crawl loop; these invariants prevent double-start races found in architect review.
**How to apply:** Any new endpoint or job that starts/steers a crawl loop must respect the logBuffers liveness check and the seedUrls-based remaining computation.
