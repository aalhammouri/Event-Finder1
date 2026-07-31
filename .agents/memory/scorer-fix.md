---
name: Scorer thresholds fix
description: scoreEvent() must receive tierThresholds as 3rd arg; hardcoded values were a bug
---

scoreEvent(event, weights, thresholds) — 3rd param defaults to DEFAULT_THRESHOLDS = {tierA:70, tierB:45}
crawler.ts passes config.tierThresholds as 3rd arg.
config.tierThresholds is read from DB adminSettings.tierThresholds in startCrawlRun().

**Why:** Previously getTier() was called with hardcoded {tierA:70,tierB:45} ignoring the DB-configured thresholds.
**How to apply:** Always pass tierThresholds when calling scoreEvent() with non-default weights.
