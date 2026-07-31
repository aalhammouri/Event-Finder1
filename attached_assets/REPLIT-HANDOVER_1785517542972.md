# Event Finder — Handover

**This file supersedes any earlier `REPLIT-FIX-INSTRUCTIONS.md`. Ignore that one.**

Attached alongside this file is `Event-Finder-restructured.zip`, a complete
replacement for the current codebase. Most of the fixes described in the earlier
instructions are **already applied inside that zip** — do not re-implement them.

Full technical detail is in `RESTRUCTURE.md` at the root of the zip. Read it
before starting.

---

## What is in the zip (already done — do not redo)

**Extraction pipeline rebuilt.** Four new service modules and a rewiring of the
crawler, so an automated run recovers what a careful manual scan of the same 87
sites found:

- `services/dates.ts` — all date reasoning moved out of the LLM and into code.
  The prompts previously asked the model whether an event had already happened
  *without telling it today's date*, and events judged past were deleted before
  scoring. Verified against 24 real-world date formats: 24/24 pass.
- `services/gate.ts` — keyword gate rewritten. The avoid list was an
  unconditional substring veto, which silently deleted a "Wine & Dine" auction
  gala, a "Bingo Bash", and every page of a "Museum of Fine **Arts**". It is now
  a tie-breaker for weak pages only. Verified: recovers 5 real events that were
  being dropped, still rejects generic pages.
- `services/ticketPlatforms.ts` + `services/enrichment.ts` — the crawler now
  follows ONE hop to qGiv / OneCause / GiveButter / DonorPerfect etc. That is
  where the date, venue, ticket price and sponsorship ladder actually live; the
  org's own page usually just says "2026 Gala — Buy Tickets".
- Also fixed: the double-crawl bug (was re-crawling every site that yielded no
  events, roughly doubling Firecrawl spend), coverage counting every ordinary
  page as "missed", the tier-name mismatch that made the digest email render
  zero events and the dashboard report zero tier counts, and the `tiers`
  shape-guard.

**Spreadsheet workflow implemented.** Derived from the team's working file
(`Event Search Houston and Austin 02-03-2025`). New `organizations` table
(GuideStar/Candid export data), a CSV importer that matches columns by header
name, and four endpoints under `/api/organizations` — including
`create-url-list`, which builds a crawlable URL list from imported orgs filtered
by NTEE code. The CRM export was rewritten to reproduce the team's
`Ready for Import` sheet exactly: 30 columns A–AD **including the blank spacer
column F**, ending at `Company`. The previous export had 31 columns and no
spacer, so a positional ACT import was shifted by one column from F onward.

**Nothing in the zip has been compiled.** It was written on a machine with no
Node.js. Your build is the first real typecheck — expect possible type errors
and fix them.

---

## Your tasks, in order

### 1. Switch the deployment from Autoscale to Reserved VM

`.replit` currently has `deploymentTarget = "autoscale"`. Autoscale stops
instances when idle, which (a) kills long background crawls mid-run — they
reappear as "paused" — and (b) means the in-process `node-cron` weekly schedule
**never fires**. This app runs fire-and-forget crawls and an in-process
scheduler, so it needs an always-on Reserved VM.

Reconfigure the deployment (update `.replit` and the deployment config,
including correct build and run commands), verify the scheduler init line
appears in the boot log, then tell the owner it is ready to republish and
whether the production URL changed.

### 2. Deploy the code

```
pnpm install
pnpm --filter @workspace/db run push
pnpm run typecheck && pnpm run build
```

`db push` creates the `organizations` table (with domain/EIN indexes) and adds
`events.organization_id`.

### 3. Run these SQL statements

Changing a Drizzle column *default* does not touch existing rows, so the harmful
values already stored must be cleared explicitly. Without this, the code fixes
have no effect on the live database.

```sql
UPDATE admin_settings SET avoid_keywords = '{}';
UPDATE admin_settings SET geographic_states = '{}';
UPDATE events SET tier = 'Tier ' || tier WHERE tier IN ('A','B','C');
```

The third statement unifies legacy `A`/`B`/`C` tier values with the current
`Tier A` format — until it runs, tier filtering splits results across two
naming conventions.

### 4. Remaining code items NOT yet done

These were identified but not implemented — please do them:

- **Firecrawl `checkCrawlStatus` pagination**: responses over 10MB paginate via
  a `next` cursor that is not followed, so large sites silently lose pages.
- **`extractor.ts` `fetchImageAsBase64`**: uses plain `got` with no DNS check
  and no redirect hook, unlike every other outbound fetch in the codebase.
  Apply `resolveHostIsSafe` + `hooks: ssrfRedirectHook` for consistency.
- **JSON-LD fast path**: any schema.org Event passing the keyword gate is stored
  with `relevant: true` and no charity-qualification check. Run the cheap Pass-1
  classifier on JSON-LD results too, or require an explicit fundraising signal.
- **`GET /crawl-runs/:id/events`**: add an optional `includePast=true` param.
  The hard `isPast` exclusion makes the events tab show fewer rows than the
  run's own `eventsMatched` counter, with no explanation.

### 5. Verify before handing back

1. `pnpm run typecheck` passes.
2. Run one small crawl and confirm in the logs:
   - `"Event enriched from ticket-platform page"` appears at least once
   - no site is crawled twice after a successful Firecrawl pass
   - per-site coverage shows `isComplete: true` with a plausible `pagesMissed`
3. `GET /api/dashboard/summary` returns non-zero tier counts when scored events
   exist.
4. `GET /api/events/export/crm` returns exactly 30 columns with an empty column
   F and `Company` as the last column.
5. Confirm the scheduler boot log reflects the schedule configured in admin
   settings.

---

## Owner-only (not the agent)

- Confirm deployment visibility is **Public**. When it was private, Replit's
  auth shield returned 307 redirects and the app showed "Network error".
- Re-share the **current** production URL — toggling visibility changed the
  hostname, so old bookmarks 404.
- **Republish** once the agent reports the Reserved VM config is ready.

## New environment variables

| Variable | Default | Effect |
|---|---|---|
| `ENRICH_MAX_CONCURRENCY` | 3 | Parallel ticket-platform enrichment fetches |
| `AI_MAX_CONCURRENCY` | 4 | Parallel OpenAI calls (existing) |
