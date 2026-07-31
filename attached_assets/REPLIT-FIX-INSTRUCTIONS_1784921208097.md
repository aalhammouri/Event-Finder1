# Event Finder — Bug Fix Handover (from external code review, 2026-07-24)

An external review of the current codebase found the following confirmed bugs and
operational issues. Fix them in the order listed. Do NOT restructure or rewrite
anything beyond what each item asks for.

---

## Part A — Things the OWNER must do in the Replit UI (not the agent)

1. **Deployment visibility**: open the deployment settings and confirm visibility
   is **Public**. When it was private, all requests hit the `__replshield` auth
   wall and the app showed "Network error".
2. **Use the CURRENT production URL**: toggling visibility changed the hostname
   (double dash → single dash). Old bookmarks show 404 "This app isn't live yet".
   Get the current primary URL from the deployment panel and re-share it with the
   team.
3. **Change deployment type to Reserved VM** (currently Autoscale in `.replit`).
   Autoscale stops instances when idle, which (a) kills background crawl runs
   mid-run — they later reappear as "paused", and (b) means the in-process
   node-cron weekly schedule NEVER fires. The app runs long background crawls and
   an in-process scheduler; it needs an always-on Reserved VM.
   (Alternative if staying on Autoscale: move the weekly trigger to a Replit
   Scheduled Deployment that calls an API endpoint — but Reserved VM is simpler.)

## Part B — Code fixes for the agent

### B1. Tier-name mismatch: digest email renders zero events (BUG)
`artifacts/api-server/src/services/emailService.ts` (~line 253):
`sendWeeklyDigest` filters `e.tier === "A"` and `e.tier === "B"`, but the scorer
now produces tier names like `"Tier A"` / `"Tier B"`. Result: the digest email
header shows counts but both tier sections are empty.
- Fix: group events by the configured tiers (load `admin_settings.tiers`, sort by
  `minScore` desc, match on `tier.name`), or at minimum normalize with
  `tier.replace(/^Tier\s+/i, "")` before comparing. Also make the two hardcoded
  section headings ("Tier A Events (Score 70+)", "Tier B Events (Score 45-69)")
  use the configured tier names/minScores instead of hardcoded labels.

### B2. Same mismatch in the dashboard summary API (BUG)
`artifacts/api-server/src/routes/dashboard.ts` (~line 49): `tierACount`,
`tierBCount`, `tierCCount` read `tierMap["A"|"B"|"C"]`, which is always 0 for
newly scored events (`"Tier A"` etc.). Normalize the tier key the same way the
frontend does (`s.replace(/^tier\s+/i, "").trim().toLowerCase()`) when building
`tierMap`, so both legacy ("A") and new ("Tier A") rows are counted.

### B3. One-time data migration: unify legacy tier values (DATA)
Old event rows store tier as `A`/`B`/`C`; new rows store `Tier A`/`Tier B`/
`Tier C`. The tier filter (`eq(events.tier, ...)`) therefore splits results.
Run this once against the database (SQL tool, not drizzle-kit push):

```sql
UPDATE events SET tier = 'Tier ' || tier WHERE tier IN ('A', 'B', 'C');
```

### B4. Every event-less site is crawled twice (COST BUG)
`artifacts/api-server/src/services/crawler.ts` (~line 798), in `crawlSite`:

```ts
if (events.length === 0 && !stopped()) {
  // falls back to BFS
```

This falls back to a full second BFS crawl (with per-page Firecrawl /scrape
calls) whenever the Firecrawl /crawl pass found zero EVENTS — but most sites
legitimately have zero events, so most sites get crawled twice, roughly doubling
Firecrawl credits and runtime. Fix: trigger the BFS fallback only when the
/crawl pass processed zero PAGES or the job failed — e.g. have
`crawlSiteWithFirecrawl` report how many pages it processed (it already tracks
`processedUrls` internally / increments `coverage.pagesCrawled`) and fall back
on `coverage.pagesCrawled === 0`, not `events.length === 0`.

### B5. Coverage metrics count every non-event page as "missed" (BUG)
`artifacts/api-server/src/services/crawler.ts` (~line 792): the `crawledUrls`
set passed to `reconcileCoverage` only contains `eventPageUrl`s of events found.
All other successfully crawled pages are counted as missed, so almost every site
reports `isComplete: false` with inflated `pagesMissed`. Fix: return the set of
processed page URLs from `crawlSiteWithFirecrawl` (its `processedUrls` set) and
from `crawlSiteWithBFS` (its `visited` set), and pass that full set to
`reconcileCoverage`.

### B6. Harden `tiers` config against non-array values (CRASH GUARD)
The `tiers` DB column previously held an object (the drift incident). If that
ever happens again, `[...tiers].sort()` in `scorer.ts` throws and every crawl
run fails. Where tiers are loaded from settings — `routes/crawlRuns.ts` config
assembly (~line 289) and the score-breakdown route (~line 929) — guard with:

```ts
const rawTiers = settings?.tiers;
const tiers = Array.isArray(rawTiers) && rawTiers.length > 0 ? rawTiers : DEFAULT_TIERS;
```

### B7. Geographic filter is silently dropping events — confirm with owner (BEHAVIOR)
`admin_settings.geographicStates` defaults to `["TX"]`, and
`crawler.ts` `processPage` silently discards any event whose org state is
outside that list (only a debug-log "skipped" entry). This is a likely cause of
"data was lost" reports when scraping national sites. Ask the owner whether the
TX-only default is intended; if not, default to `[]` (no filtering). Either way,
surface skipped-by-geography counts in the run summary UI so drops are visible.

### B8. Smaller fixes (do after the above)
- `crawler.ts` `crawlSiteWithFirecrawl`: handle Firecrawl `checkCrawlStatus`
  pagination (`next` cursor) so large sites (>10MB of page data) don't silently
  lose pages.
- `extractor.ts` `fetchImageAsBase64`: use the same SSRF protections as other
  outbound fetches (`resolveHostIsSafe` on the hostname + `hooks: ssrfRedirectHook`).
- `extractor.ts` JSON-LD fast path: it marks any schema.org Event as
  `relevant: true` without the charity-qualification check. Run the cheap Pass-1
  classify prompt on JSON-LD results (or require an explicit fundraising signal
  in the scan text) to avoid non-charity events entering the database.
- `routes/crawlRuns.ts` `GET /crawl-runs/:id/events`: add an optional
  `includePast=true` query param — the hard `isPast` exclusion makes the events
  tab show fewer rows than the run's `eventsMatched` counter with no explanation.

## Part C — Verification checklist (agent must do after the fixes)

1. `pnpm run typecheck` passes.
2. Trigger a small manual crawl run against a test URL list; confirm:
   - the run completes (not paused/failed),
   - a site with zero events is NOT re-crawled by BFS after a successful /crawl,
   - per-site coverage rows show `isComplete: true` with sensible pagesMissed.
3. `GET /api/dashboard/summary` returns non-zero tierACount/tierBCount when
   scored events exist.
4. Send a test digest (or dry-run `sendWeeklyDigest`) and confirm event rows
   actually render in the tier sections.
5. Confirm the scheduler log line appears on boot and reflects the configured
   schedule from admin settings.
