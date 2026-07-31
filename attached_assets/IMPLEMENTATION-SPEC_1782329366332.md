# Event Finder — Implementation Spec

> **Purpose:** Single reference document for the Replit AI agent.
> Covers three workstreams that must be applied **in order**:
> 1. Extraction Accuracy (fix skipped pages, image detection, wrong data)
> 2. Speed Optimization (concurrency at every level)
> 3. Enhanced Live Preview & Error-Feedback Loop
>
> **Files you will modify** (and ONLY these files unless stated otherwise):
> - `artifacts/api-server/src/services/crawler.ts`
> - `artifacts/api-server/src/services/extractor.ts`
> - `artifacts/api-server/src/services/scorer.ts` (minor)
> - `artifacts/api-server/src/routes/crawlRuns.ts`
> - `artifacts/event-finder/src/pages/runs/detail.tsx`
>
> **Do NOT change:** database schema, API route signatures, authentication,
> frontend routing, or any other files unless a change here explicitly requires it.

---

## Table of Contents

1. [Workstream 1 — Extraction Accuracy](#workstream-1--extraction-accuracy)
   - 1A. Fix archive-page false negatives
   - 1B. Fix BFS link prioritization
   - 1C. Two-pass AI extraction
   - 1D. Improve image analysis
   - 1E. Increase text truncation limit
2. [Workstream 2 — Speed Optimization](#workstream-2--speed-optimization)
   - 2A. Concurrent site crawling
   - 2B. Concurrent page fetching within a site
   - 2C. Parallel AI + image extraction
   - 2D. Batch DB inserts
   - 2E. Early termination heuristics
3. [Workstream 3 — Enhanced Live Preview & Error Feedback](#workstream-3--enhanced-live-preview--error-feedback)
   - 3A. Richer SSE progress events
   - 3B. Enhanced run detail page (3-panel layout)
   - 3C. Error log → LLM analysis endpoint
   - 3D. Per-URL retry from error log
4. [Testing Checklist](#testing-checklist)
5. [Expected Outcomes](#expected-outcomes)

---

## Workstream 1 — Extraction Accuracy

### 1A. Fix archive-page false negatives

**File:** `crawler.ts` — `isArchivePage()` (lines 89–99) and `ARCHIVE_PATTERNS` (lines 67–70)

**Problem:** The function checks the first 2000 characters of page body text for words
like "past", "gallery", "highlights", and years "2020"–"2024". This incorrectly skips
pages that say things like "Past sponsors include..." or "View our photo gallery" while
describing a CURRENT upcoming event. Charity event pages frequently reference prior years.

**Changes:**

1. Remove ALL year-based patterns (`"2020"`, `"2021"`, `"2022"`, `"2023"`, `"2024"`) from
   `ARCHIVE_PATTERNS` entirely.

2. Rewrite `isArchivePage()` to ONLY check the **URL path** for archive signals. Do NOT
   scan body text. Use path-segment matching (not substring) to avoid false positives:

```typescript
const ARCHIVE_PATH_SEGMENTS = [
  "/past-events", "/archive", "/previous-events", "/recap",
  "/event-gallery", "/past-galas", "/event-history",
];

function isArchivePage(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return ARCHIVE_PATH_SEGMENTS.some((seg) => pathname.includes(seg));
  } catch {
    return false;
  }
}
```

3. Update the call site (line 343) to only pass `url`, not `text || html`:
```typescript
if (isArchivePage(url)) {
  onProgress({ type: "error", pageUrl: url, errorMessage: "Skipped: archive/past URL path" });
  continue;
}
```

---

### 1B. Fix BFS link prioritization

**File:** `crawler.ts` — lines 331–339

**Problem:** Both event-path links and non-event links use `unshift`, which means the
last-discovered non-event link gets crawled before earlier event links.

**Change:** Event-path links → `unshift` (front of queue). Non-event links → `push` (back).

```typescript
for (const link of eventLinks) {
  if (!visited.has(link)) toVisit.unshift(link);  // priority: front
}
for (const link of otherLinks) {
  if (!visited.has(link)) toVisit.push(link);     // low priority: back
}
```

---

### 1C. Two-pass AI extraction

**File:** `extractor.ts` — replace the single OpenAI call (lines 376–394) with two focused calls.

**Why:** A single prompt asking the AI to simultaneously classify relevance, identify the
event name/date, AND extract 20+ detail fields leads to systematic errors:
- Wrong dates (registration deadlines, past event dates, early-bird deadlines)
- Wrong titles (org name used as event name)
- Wrong contacts (general office contact instead of event-specific contact)

Two focused passes with explicit disambiguation rules fix all three.

#### Pass 1 — Classification + Event Identity

Runs on every page that passes the keyword gate. Fast and cheap.

```typescript
const PASS1_SYSTEM_PROMPT = `You are classifying whether a webpage describes a SINGLE upcoming charity fundraising event. Return JSON only.

QUALIFYING events: charity galas, fundraising dinners, silent auctions, live auctions, benefit concerts, golf tournaments for charity, nonprofit fundraisers with ticketed admission or sponsorship.

DISQUALIFY: business conferences, trade shows, community markets, craft fairs, past event recaps, general event calendars listing multiple events, events with no fundraising language, events whose date has clearly passed.

CRITICAL DISAMBIGUATION RULES:

EVENT NAME:
- The event name is the name of the SPECIFIC EVENT (e.g. "Annual Crystal Ball Gala"), NOT the organization name (e.g. "Houston Children's Foundation").
- If the H1 heading is the org name, look for the event name in H2, H3, bold text, or a subheading.
- Event names typically include words like: gala, auction, benefit, fundraiser, tournament, dinner, ball, celebration, luncheon.

EVENT DATE:
- The event date is the day the event TAKES PLACE. It is NOT:
  * A registration deadline ("Register by March 1")
  * An early bird deadline ("Early bird pricing ends Feb 15")
  * A sponsorship deadline ("Sponsor commitments due by...")
  * A past event date ("Last year's gala was held on...")
  * A general website copyright date
- Look for patterns like: "Join us on [DATE]", "Event Date: [DATE]", "[DAY OF WEEK], [MONTH] [DAY], [YEAR]" near the event name or in a details/info section.
- If multiple dates appear, prefer the one closest to event-related context (venue, tickets, RSVP).

Return JSON: {"relevant": boolean, "eventName": string|null, "eventDate": string|null, "reasoning": string}
The "reasoning" field: 1 sentence explaining your classification.`;
```

User message format (same as current):
```
Page URL: {url}
Page title: {title}
First H1: {h1}
First markdown heading: {mdHeading}

Page markdown:
{first 12000 chars}
```

#### Pass 2 — Detail Extraction

Runs ONLY when Pass 1 returns `relevant: true`. Receives the event name and date from
Pass 1 so it doesn't re-derive them (and can't get them wrong).

```typescript
const PASS2_SYSTEM_PROMPT = `You are extracting structured details from a charity fundraising event page.
You already know this page describes the event "{eventName}" on {eventDate}. Extract the remaining details.

CONTACT DISAMBIGUATION — THIS IS CRITICAL:
There are often TWO different contacts on a charity event page:
1. EVENT CONTACT — the person handling tickets, RSVPs, table reservations, or event questions. This is who you want for contactName/contactEmail/contactPhone. Look for: "For tickets contact...", "RSVP to...", "Event questions?", "Event Chair:", "Event Coordinator:".
2. ORGANIZATION CONTACT — the general office phone, info@ email, executive director, webmaster. This is NOT the event contact. Put this in orgPhone/orgEmail instead.

If only one contact is listed and it's ambiguous, put it in BOTH event contact AND org contact fields.

PRICING RULES:
- ticketPrice: per-PERSON or per-TICKET price. "$X per person", "$X/ticket", "$X individual". If multiple tiers, use the LOWEST non-free tier.
- tablePrice: per-TABLE or SPONSORSHIP price. "$X per table", "$X table of 10", "$X sponsorship". If multiple levels, use the LOWEST sponsorship tier.
- Do NOT confuse auction item prices, donation amounts, or raffle ticket prices with event ticket/table prices.

ADDRESS RULES:
- eventVenue: NAME of the venue (e.g. "The Hilton Americas-Houston"), not the street address.
- eventAddress: STREET ADDRESS of the venue (e.g. "1600 Lamar St, Houston, TX 77010").
- orgAddress: the organization's mailing/office address — may differ from the event venue.
- orgCity: the city of the ORGANIZATION, not necessarily the event venue city.

Return ONLY valid JSON with these fields (omit fields you cannot determine):
eventVenue, eventAddress, eventDescription (1-2 sentences), auctionType ("silent"|"live"|"both"|"online"|"none"), hasSilentAuction (boolean), hasLiveAuction (boolean), ticketPrice (number|null), tablePrice (number|null), formality ("black-tie"|"gala"|"cocktail"|"casual"|"unknown"), rsvpLink, contactName, contactEmail, contactPhone, audienceNote, sponsorshipMentioned (boolean), orgName, orgAddress, orgCity, orgPhone, orgEmail, orgWebsite.`;
```

User message for Pass 2:
```
This page describes the event "{eventName}" on {eventDate}. Extract details.

Page URL: {url}

Page markdown:
{first 12000 chars}
```

#### Merging logic

```typescript
// Pass 1 fields (eventName, eventDate) take priority — they were extracted with
// focused disambiguation rules.
// Pass 2 fills in all remaining detail fields.
// Image extraction (see §1D) fills any remaining gaps.
const result: ExtractedEvent = {
  relevant: pass1.relevant,
  eventName: pass1.eventName,
  eventDate: pass1.eventDate,
  ...pass2Result,  // detail fields
};
// Then merge image data using existing mergeExtracted() — first-write-wins
```

---

### 1D. Improve image analysis

**File:** `extractor.ts`

1. **Process more images** (line 231): Change `.slice(0, 3)` to `.slice(0, 5)`.

2. **Higher resolution for priority images** (line 248): Use `detail: "high"` for the
   first 2 images (event-keyword-adjacent priority images). Keep `detail: "low"` for
   images 3–5 to control cost. The cost difference is ~$0.01/image but the accuracy
   improvement for reading text on flyers is dramatic.

```typescript
for (let i = 0; i < imageUrls.slice(0, 5).length; i++) {
  const url = imageUrls[i];
  // ... existing fetchImageAsBase64 ...
  const detailLevel = i < 2 ? "high" : "low";  // high-res for priority images
  // ... use detailLevel in the API call ...
}
```

3. **Parse srcset/data-srcset** (in `extractImageUrls`, line 150): Many modern sites
   lazy-load event flyers via `srcset`. Add:

```typescript
// After checking src, data-src, data-lazy-src:
const srcset = $(el).attr("srcset") || $(el).attr("data-srcset") || "";
if (srcset && !src) {
  // Pick the largest resolution from srcset
  const candidates = srcset.split(",").map(s => s.trim().split(/\s+/));
  const best = candidates.sort((a, b) => {
    const aW = parseInt(a[1] || "0");
    const bW = parseInt(b[1] || "0");
    return bW - aW;
  })[0];
  if (best?.[0]) src = best[0];
}
```

4. **Relax size filter for event-related images** (line 157): If an image has
   event-related alt text, skip the dimension check entirely — a small thumbnail of
   a flyer is still worth analyzing:

```typescript
const alt = ($(el).attr("alt") || "").toLowerCase();
const isEventAlt = ["gala", "auction", "fundraiser", "event", "benefit", "tournament"]
  .some(k => alt.includes(k));

// Skip tiny images UNLESS they have event-related alt text
if (!isEventAlt && ((width > 0 && width < 80) || (height > 0 && height < 80))) return;
```

---

### 1E. Increase text truncation limit

**File:** `extractor.ts` — line 377

Change `pageText.slice(0, 8000)` to `pageText.slice(0, 12000)`.

**Why:** Many charity event pages have contact info, pricing, and event details below
the 8000-char mark (after navigation, hero content, and sponsor logos). 12000 chars costs
~$0.003 more per page with gpt-4o-mini. Apply to both Pass 1 and Pass 2 prompts.

---

## Workstream 2 — Speed Optimization

### 2A. Concurrent site crawling

**File:** `crawlRuns.ts` — replace the sequential `for` loop (line 108)

**Problem:** URLs are processed one at a time. 500 URLs × ~2 min each = ~16 hours.

**Solution:** Process 5 sites simultaneously using a worker-pool pattern.

```typescript
const SITE_CONCURRENCY = 5;

async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
}
```

Replace the `for (let i = 0; i < urls.length; i++)` loop with:

```typescript
let completedCount = 0;

await processWithConcurrency(urls, SITE_CONCURRENCY, async (url, i) => {
  if (stoppedRuns.has(runId)) return;

  const startEvt: CrawlProgressEvent = {
    type: "url_start", url,
    progress: { done: completedCount, total: urls.length }
  };
  appendLog(toLogEntry(startEvt));
  emitProgress(runId, startEvt);

  try {
    const events = await crawlSite(url, config, (ev) => {
      if (ev.type === "page_crawled") pagesCrawled++;
      if (ev.type === "error") errorCount++;
      appendLog(toLogEntry(ev));
      emitProgress(runId, ev);
    });

    // Batch insert all events for this site at once (see §2D)
    if (events.length > 0) {
      await db.insert(eventsTable).values(
        events.map((event) => ({
          runId,
          score: event.score,
          tier: event.tier,
          status: "NEW" as const,
          eventName: event.eventName,
          eventDate: event.eventDate,
          eventVenue: event.eventVenue,
          eventAddress: event.eventAddress,
          eventDescription: event.eventDescription,
          auctionType: event.auctionType,
          hasSilentAuction: event.hasSilentAuction,
          hasLiveAuction: event.hasLiveAuction,
          ticketPrice: event.ticketPrice?.toString(),
          tablePrice: event.tablePrice?.toString(),
          formality: event.formality,
          rsvpLink: event.rsvpLink,
          contactName: event.contactName,
          contactEmail: event.contactEmail,
          contactPhone: event.contactPhone,
          eventPageUrl: event.eventPageUrl,
          audienceNote: event.audienceNote,
          sponsorshipMentioned: event.sponsorshipMentioned,
          orgName: event.orgName,
          orgAddress: event.orgAddress,
          orgCity: event.orgCity,
          orgPhone: event.orgPhone,
          orgEmail: event.orgEmail,
          orgWebsite: event.orgWebsite,
          isPast: event.isPast,
          errorMessage: event.errorMessage,
        }))
      );
      eventsMatched += events.length;
    }

    completedCount++;
    const doneEvt: CrawlProgressEvent = {
      type: "url_done", url,
      progress: { done: completedCount, total: urls.length }
    };
    appendLog(toLogEntry(doneEvt));
    emitProgress(runId, doneEvt);
  } catch (err) {
    errorCount++;
    completedCount++;
    logger.error({ err, url }, "Crawl site error");
    const errEvt: CrawlProgressEvent = { type: "error", url, errorMessage: String(err) };
    appendLog(toLogEntry(errEvt));
    emitProgress(runId, errEvt);
  }
});
```

**Important:** Remove the per-URL DB flush (lines 180–183 and 192–195). Keep only the
5-second interval flush (line 77–84) — with 5 concurrent sites completing URLs rapidly,
per-URL DB writes would be excessive.

---

### 2B. Concurrent page fetching within a site

**File:** `crawler.ts` — replace the sequential `while` loop (line 312)

```typescript
const PAGE_CONCURRENCY = 3;

while (toVisit.length > 0 && visited.size < config.maxPagesPerSite) {
  // Pull up to PAGE_CONCURRENCY URLs
  const batch: string[] = [];
  while (batch.length < PAGE_CONCURRENCY && toVisit.length > 0) {
    const url = toVisit.shift()!;
    if (visited.has(url) || getDomain(url) !== domain || isStaticAsset(url)) continue;
    visited.add(url);
    batch.push(url);
  }
  if (batch.length === 0) break;

  // Check visited.size limit
  if (visited.size > config.maxPagesPerSite) break;

  const batchResults = await Promise.all(
    batch.map(async (url) => {
      onProgress({ type: "page_crawled", pageUrl: url });

      const result = await fetchPage(url, domain, timeoutMs);
      if (!result) {
        onProgress({ type: "error", pageUrl: url, errorMessage: "Failed to fetch page" });
        return { events: [] as CrawledEvent[], newLinks: [] as string[] };
      }

      const { text, html } = result;

      // Extract links for BFS
      let newLinks: string[] = [];
      if (sitemapUrls.length === 0) {
        const rawLinks = result.links ?? extractInternalLinks(html, url);
        newLinks = rawLinks.filter((l) => !isStaticAsset(l));
      }

      // Archive gate
      if (isArchivePage(url)) {
        onProgress({ type: "error", pageUrl: url, errorMessage: "Skipped: archive/past URL path" });
        return { events: [], newLinks };
      }

      // Keyword gate + AI extraction
      try {
        const extracted = await extractEventFromPage(
          text, url,
          config.searchKeywords, config.avoidKeywords, config.overrideKeywords,
          html, config.imageReadingEnabled
        );

        if (extracted) {
          const { score, tier, isPast } = scoreEvent(
            {
              hasSilentAuction: extracted.hasSilentAuction,
              hasLiveAuction: extracted.hasLiveAuction,
              auctionType: extracted.auctionType,
              ticketPrice: extracted.ticketPrice,
              tablePrice: extracted.tablePrice,
              formality: extracted.formality,
              eventDate: extracted.eventDate,
              orgName: extracted.orgName,
            },
            config.scoringWeights
          );

          const crawledEvent: CrawledEvent = {
            ...extracted,
            eventPageUrl: url,
            score, tier, isPast,
            ticketPrice: extracted.ticketPrice ?? null,
            tablePrice: extracted.tablePrice ?? null,
          };
          onProgress({ type: "event_found", pageUrl: url, eventName: extracted.eventName, score });
          return { events: [crawledEvent], newLinks };
        }
      } catch (err) {
        logger.error({ err, url }, "Extraction error");
      }

      return { events: [] as CrawledEvent[], newLinks: [] as string[] };
    })
  );

  // Collect events
  for (const r of batchResults) {
    events.push(...r.events);
  }

  // Add discovered links: event-path first, others last
  for (const r of batchResults) {
    const eventLinks = r.newLinks.filter(isEventUrl);
    const otherLinks = r.newLinks.filter((l) => !isEventUrl(l));
    for (const link of eventLinks) {
      if (!visited.has(link)) toVisit.unshift(link);
    }
    for (const link of otherLinks) {
      if (!visited.has(link)) toVisit.push(link);
    }
  }
}
```

---

### 2C. Parallel AI + image extraction

**File:** `extractor.ts`

After Pass 1 returns `relevant: true`, run Pass 2 and image extraction **in parallel**:

```typescript
if (pass1Result.relevant === false) return null;

const [pass2Result, imageResult] = await Promise.all([
  runPass2(client, truncatedText, pageUrl, pass1Result.eventName, pass1Result.eventDate, pageMeta),
  (imageReadingEnabled && pageHtml)
    ? extractFromImages(extractImageUrls(pageHtml, pageUrl), client)
    : Promise.resolve({} as Partial<ExtractedEvent>),
]);

// Merge: Pass 1 (name + date) → Pass 2 (details) → Image (gap-fill)
let result: ExtractedEvent = {
  relevant: true,
  eventName: pass1Result.eventName,
  eventDate: pass1Result.eventDate,
  ...pass2Result,
};
result = mergeExtracted(result, imageResult);

// Image relevance override (same logic as current)
if (pass2Result.relevant === false && (imageResult as any).relevant === true) {
  result.relevant = true;
}
```

This cuts per-page AI latency from ~3 sequential calls to ~2 (Pass 1, then Pass 2 + images together).

---

### 2D. Batch DB inserts

**File:** `crawlRuns.ts`

Already shown in §2A above — replace the per-event `db.insert()` loop with a single
`db.insert(eventsTable).values(events.map(...))` call per site. Reduces DB round-trips
from N events to 1 per site.

---

### 2E. Early termination heuristics

**File:** `crawler.ts` — add inside the page-processing loop

```typescript
// Track keyword-gate failures for this site
let consecutiveNoKeywords = 0;
let tierACount = 0;

// Inside the per-page processing, after keyword gate:
if (!extracted) {
  consecutiveNoKeywords++;
} else {
  consecutiveNoKeywords = 0;
  if (extracted.tier === "A") tierACount++;
}

// EARLY EXIT 1: If first 3 pages all fail keyword gate, skip remaining
if (consecutiveNoKeywords >= 3 && visited.size <= 5) {
  onProgress({
    type: "error", url: siteUrl,
    errorMessage: `Early exit: first ${consecutiveNoKeywords} pages had no keyword matches`
  });
  break;
}

// EARLY EXIT 2: Already found 3+ Tier A events — no need to dig deeper
if (tierACount >= 3) {
  onProgress({
    type: "url_done", url: siteUrl,
    errorMessage: `Early exit: found ${tierACount} Tier A events`
  });
  break;
}
```

Also add sitemap truncation at the top of `crawlSite`:

```typescript
if (sitemapUrls.length > 200) {
  const eventUrls = sitemapUrls.filter((u) => !isStaticAsset(u) && isEventUrl(u)).slice(0, 100);
  const otherUrls = sitemapUrls.filter((u) => !isStaticAsset(u) && !isEventUrl(u)).slice(0, 50);
  toVisit.push(...eventUrls, ...otherUrls);
} else {
  // ... existing logic ...
}
```

---

## Workstream 3 — Enhanced Live Preview & Error Feedback

### 3A. Richer SSE progress events

**File:** `crawler.ts` — modify progress callback data

Add timing and metadata to every progress event:

```typescript
// At the start of each page:
const pageStartTime = Date.now();

// In the page_crawled event:
onProgress({
  type: "page_crawled",
  pageUrl: url,
  textLength: text.length,
  keywordsFound: hasSearch || hasOverride,
  durationMs: Date.now() - pageStartTime,
});

// In the event_found event — include full event data:
onProgress({
  type: "event_found",
  pageUrl: url,
  eventName: extracted.eventName,
  score,
  eventData: crawledEvent,  // full object for live preview cards
  durationMs: Date.now() - pageStartTime,
});

// For skipped pages — use a distinct "skipped" type instead of "error":
onProgress({
  type: "skipped",
  pageUrl: url,
  reason: "archive_path",  // or "keyword_gate", "avoid_keyword", "blacklisted"
  durationMs: Date.now() - pageStartTime,
});

// For actual errors — add structured error info:
onProgress({
  type: "error",
  pageUrl: url,
  errorType: "timeout" | "fetch_failed" | "ai_failed" | "unknown",
  errorMessage: String(err),
  durationMs: Date.now() - pageStartTime,
});
```

**File:** `crawlRuns.ts` — update `CrawlProgressEvent` type and `toLogEntry()`

Add the new fields to the `CrawlProgressEvent` interface:

```typescript
export interface CrawlProgressEvent {
  type: "url_start" | "url_done" | "page_crawled" | "event_found"
      | "error" | "skipped" | "complete";
  url?: string;
  pageUrl?: string;
  eventName?: string;
  score?: number;
  errorMessage?: string;
  errorType?: string;
  reason?: string;
  progress?: { done: number; total: number };
  // New fields:
  textLength?: number;
  keywordsFound?: boolean;
  durationMs?: number;
  eventData?: any;  // full CrawledEvent for live preview
}
```

Update `toLogEntry()` to include duration and new types:

```typescript
case "skipped":
  return {
    ts, type: event.type, url: event.pageUrl,
    msg: `Skipped: ${event.pageUrl ?? ""} (${event.reason})`,
    durationMs: event.durationMs,
  };
case "page_crawled":
  return {
    ts, type: event.type, url: event.pageUrl,
    msg: `Crawled: ${event.pageUrl ?? ""} (${event.textLength ?? 0} chars, ${event.durationMs ?? 0}ms)`,
    durationMs: event.durationMs,
  };
```

Also add `durationMs` to the `LogEntry` type.

---

### 3B. Enhanced run detail page (3-panel layout)

**File:** `detail.tsx` — major UI update

Replace the current 2-tab layout (Activity Log | Events Found) with a 3-panel view:

#### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Header: run name, status badge, stop button, progress bar     │
│  Stat cards: Pages | Events | Errors | Duration | Speed        │
├────────────────────────┬────────────────────────────────────────┤
│                        │                                        │
│   ACTIVITY LOG         │   LIVE EVENT CARDS                     │
│   (40% width)          │   (60% width, top section)             │
│                        │                                        │
│   - Color-coded        │   Cards animate in as events are       │
│   - Duration per page  │   found. Each card shows:              │
│   - Expandable detail  │   - Score pill + Tier badge            │
│   - Scroll + auto-     │   - Event name (bold)                  │
│     follow             │   - Org, date, venue on one line       │
│                        │   - Auction type badges                │
│                        │   - Contact info if found              │
│                        │   - "Open page" external link          │
│                        │   Sorted by score descending.          │
│                        ├────────────────────────────────────────┤
│                        │                                        │
│                        │   ERROR SUMMARY PANEL                  │
│                        │   (60% width, bottom section)          │
│                        │                                        │
│                        │   Grouped by error type:               │
│                        │   Timeouts: 12 | Fetch: 3 | No KW: 45 │
│                        │   Expandable per-type URL list         │
│                        │   [Analyze Errors with AI] button      │
│                        │                                        │
└────────────────────────┴────────────────────────────────────────┘
```

On mobile (< 768px): stack all 3 panels vertically.

#### Activity Log enhancements

- Show page duration as a badge: `2.3s` in muted text next to each entry
- Color-code the new "skipped" type: gray background, gray left border
- Add a new stat card: **Speed** — `avg X.Xs / page` calculated from durationMs values

#### Live Event Cards

Render directly from SSE `event_found` events (which now include full `eventData`).
No polling needed.

```tsx
function LiveEventCard({ event }: { event: CrawledEvent }) {
  return (
    <div className="border rounded-lg p-3 bg-card shadow-sm animate-in slide-in-from-top-2 fade-in duration-300">
      <div className="flex items-center gap-2 mb-1">
        <ScorePill score={event.score} />
        <TierBadge tier={event.tier} />
        {event.hasSilentAuction && <Badge variant="outline" className="text-xs">Silent Auction</Badge>}
        {event.hasLiveAuction && <Badge variant="outline" className="text-xs">Live Auction</Badge>}
      </div>
      <p className="font-semibold text-sm truncate">{event.eventName || "Unnamed"}</p>
      <p className="text-xs text-muted-foreground truncate">
        {[event.orgName, event.eventDate, event.eventVenue].filter(Boolean).join(" · ")}
      </p>
      {(event.contactEmail || event.contactPhone) && (
        <p className="text-xs text-muted-foreground mt-1">
          {event.contactEmail} {event.contactPhone && `· ${event.contactPhone}`}
        </p>
      )}
      {event.eventPageUrl && (
        <a href={event.eventPageUrl} target="_blank" rel="noopener noreferrer"
           className="text-xs text-primary hover:underline mt-1 inline-flex items-center gap-1">
          Open page <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </div>
  );
}
```

#### Error Summary Panel

```tsx
function ErrorSummary({ entries, runId }: { entries: LogEntry[]; runId: number }) {
  const errors = entries.filter(e => e.type === "error");
  const skipped = entries.filter(e => e.type === "skipped");

  // Group by errorType/reason
  const grouped = new Map<string, LogEntry[]>();
  for (const e of [...errors, ...skipped]) {
    const key = (e as any).errorType || (e as any).reason || e.type;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(e);
  }

  // ... render counts as badges, expandable URL lists per group ...
  // ... "Analyze Errors with AI" button that POSTs to /api/crawl-runs/:id/analyze-errors ...
}
```

---

### 3C. Error log → LLM analysis endpoint

**File:** `crawlRuns.ts` — add new route

```typescript
// POST /crawl-runs/:id/analyze-errors
router.post("/crawl-runs/:id/analyze-errors", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .select({ debugLog: crawlRunsTable.debugLog, totalUrls: crawlRunsTable.totalUrls,
              pagesCrawled: crawlRunsTable.pagesCrawled, eventsMatched: crawlRunsTable.eventsMatched,
              errorCount: crawlRunsTable.errorCount })
    .from(crawlRunsTable)
    .where(eq(crawlRunsTable.id, id));

  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const log = (row.debugLog ?? []) as LogEntry[];
  const errors = log.filter(e => e.type === "error" || e.type === "skipped");

  // Group errors by type
  const errorsByType = new Map<string, { count: number; sampleUrls: string[] }>();
  for (const e of errors) {
    const type = (e as any).errorType || (e as any).reason || "unknown";
    if (!errorsByType.has(type)) errorsByType.set(type, { count: 0, sampleUrls: [] });
    const group = errorsByType.get(type)!;
    group.count++;
    if (group.sampleUrls.length < 5 && e.url) group.sampleUrls.push(e.url);
  }

  // Group by domain
  const domainErrors = new Map<string, number>();
  for (const e of errors) {
    if (!e.url) continue;
    try {
      const domain = new URL(e.url).hostname;
      domainErrors.set(domain, (domainErrors.get(domain) || 0) + 1);
    } catch {}
  }

  // Get current settings for context
  const [settings] = await db.select().from(adminSettingsTable).limit(1);

  // Build analysis prompt
  const analysisPrompt = `You are analyzing the error log from a web scraping run that crawls charity/nonprofit websites looking for fundraising events (galas, auctions, golf tournaments, etc).

Run summary:
- Total URLs attempted: ${row.totalUrls}
- Pages crawled: ${row.pagesCrawled}
- Events found: ${row.eventsMatched}
- Errors: ${row.errorCount}

Current configuration:
- Search keywords: ${JSON.stringify(settings?.searchKeywords ?? [])}
- Avoid keywords: ${JSON.stringify(settings?.avoidKeywords ?? [])}
- Override keywords: ${JSON.stringify(settings?.overrideKeywords ?? [])}
- Timeout per page: ${settings?.timeoutPerPage ?? 30}s
- Max pages per site: ${settings?.maxPagesPerSite ?? 30}

Error breakdown by type:
${Array.from(errorsByType.entries()).map(([type, data]) =>
  `- ${type}: ${data.count} errors\n  Sample URLs: ${data.sampleUrls.join(", ")}`
).join("\n")}

Domains with most failures:
${Array.from(domainErrors.entries())
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)
  .map(([domain, count]) => `- ${domain}: ${count} errors`)
  .join("\n")}

Analyze and return JSON:
{
  "summary": "2-3 sentence overview of crawl health",
  "patterns": [{"pattern": "description", "affectedCount": N, "suggestion": "what to do"}],
  "configSuggestions": [{"setting": "settingName", "currentValue": "X", "suggestedValue": "Y", "reason": "why"}],
  "siteIssues": [{"domain": "example.com", "issue": "blocks scrapers", "workaround": "add to blacklist or skip"}],
  "possibleMissedEvents": [{"url": "https://...", "likelyReason": "event info was in image only"}],
  "overallHealthScore": 0-100
}`;

  // Call OpenAI
  const client = getOpenAIClient();
  if (!client) {
    res.status(503).json({ error: "AI not configured" });
    return;
  }

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "You are a web scraping diagnostics expert. Analyze error logs and provide actionable suggestions. Return only valid JSON." },
      { role: "user", content: analysisPrompt },
    ],
    response_format: { type: "json_object" },
    max_tokens: 2000,
  });

  const analysis = JSON.parse(response.choices[0]?.message?.content || "{}");
  res.json(analysis);
});
```

#### Frontend rendering for analysis results

After the "Analyze Errors with AI" button click, render the response:

```
┌─────────────────────────────────────────────────────┐
│  CRAWL HEALTH: ██████████░░ 78/100                  │
│  "78% of URLs processed successfully. Main issues   │
│   are timeouts on WordPress sites and..."            │
├─────────────────────────────────────────────────────┤
│  PATTERNS                                           │
│  ▸ WordPress sites timing out (12 URLs)             │
│    → Increase timeout to 45s                        │
│  ▸ "wine" avoid keyword blocking galas with wine    │
│    bars (8 URLs)                                    │
│    → Remove "wine" from avoid keywords              │
├─────────────────────────────────────────────────────┤
│  CONFIG SUGGESTIONS                                 │
│  ┌──────────────┬─────────┬──────────┬───────────┐  │
│  │ Setting      │ Current │ Suggest  │ Action    │  │
│  │ timeoutPage  │ 30s     │ 45s      │ [Apply]   │  │
│  │ avoidKeywords│ [wine]  │ remove   │ [Apply]   │  │
│  └──────────────┴─────────┴──────────┴───────────┘  │
├─────────────────────────────────────────────────────┤
│  SITE ISSUES                                        │
│  • scraper-blocking.org — Cloudflare challenge      │
│    → [Add to Blacklist]                             │
├─────────────────────────────────────────────────────┤
│  POSSIBLE MISSED EVENTS                             │
│  • https://example.com/gala2026 — likely image-only │
│    → [Re-crawl]                                     │
└─────────────────────────────────────────────────────┘
```

Each **[Apply]** button sends `PATCH /api/admin/settings` with the suggested value.
Each **[Add to Blacklist]** sends `POST /api/admin/domain-blacklist`.
Each **[Re-crawl]** collects selected URLs for the retry endpoint (§3D).

---

### 3D. Per-URL retry from error log

**File:** `crawlRuns.ts` — add new route

```typescript
// POST /crawl-runs/:id/retry-urls
router.post("/crawl-runs/:id/retry-urls", async (req, res) => {
  const id = Number(req.params.id);
  const { urls } = req.body as { urls: string[] };

  if (!id || !Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: "Invalid id or urls array" });
    return;
  }

  // Get the original run's url_list_id for association
  const [originalRun] = await db
    .select({ urlListId: crawlRunsTable.urlListId })
    .from(crawlRunsTable)
    .where(eq(crawlRunsTable.id, id));

  if (!originalRun) { res.status(404).json({ error: "Not found" }); return; }

  // Create a new run with only the retry URLs
  const [newRun] = await db
    .insert(crawlRunsTable)
    .values({
      urlListId: originalRun.urlListId,
      status: "pending",
      triggeredBy: "manual",
      totalUrls: urls.length,
      pagesCrawled: 0,
      eventsMatched: 0,
      errorCount: 0,
      archived: false,
      debugLog: [],
    })
    .returning();

  const [listRow] = await db
    .select({ name: urlListsTable.name })
    .from(urlListsTable)
    .where(eq(urlListsTable.id, originalRun.urlListId));

  // Fire and forget
  startCrawlRun(newRun.id, urls, "manual").catch((err) =>
    logger.error({ err, runId: newRun.id }, "Retry run failed")
  );

  res.status(202).json(serializeRun(newRun, listRow?.name ?? ""));
});
```

---

## Testing Checklist

After implementing all three workstreams, verify:

### Accuracy (Workstream 1)
- [ ] A page mentioning "past sponsors" is NOT skipped by archive detection
- [ ] A page at `/past-events/` IS skipped
- [ ] Event-path links are crawled before generic links
- [ ] Two-pass extraction returns correct event name (not org name)
- [ ] Two-pass extraction returns correct event date (not registration deadline)
- [ ] Contact fields contain the event contact, not the general office contact
- [ ] Image analysis processes up to 5 images
- [ ] High-res image analysis reads text on flyer images correctly
- [ ] Pages with event info past the 8000-char mark still get correct extraction

### Speed (Workstream 2)
- [ ] 5 sites are crawled concurrently (check log timestamps — multiple url_start before url_done)
- [ ] 3 pages are fetched concurrently within each site
- [ ] Events are batch-inserted (one DB call per site, not per event)
- [ ] Early termination kicks in when first 3 pages have no keywords
- [ ] Early termination kicks in when 3+ Tier A events are found
- [ ] Large sitemaps (200+) are truncated correctly
- [ ] Stop signal still works across concurrent sites
- [ ] No duplicate events are created

### Live Preview (Workstream 3)
- [ ] SSE events include durationMs for pages
- [ ] Live event cards appear immediately when events are found (no 5s polling delay)
- [ ] Error summary groups errors by type with correct counts
- [ ] "Analyze Errors with AI" returns structured analysis
- [ ] [Apply] buttons update admin settings correctly
- [ ] [Add to Blacklist] adds domain correctly
- [ ] Retry endpoint creates a new run with only selected URLs
- [ ] Mobile layout stacks panels vertically
- [ ] Progress bar and stat cards update correctly with concurrent crawling

---

## Expected Outcomes

| Metric | Before | After |
|---|---|---|
| **Crawl speed** (500 URLs) | ~16 hours | ~1.5–2 hours |
| **Event name accuracy** | ~70% (often returns org name) | ~95% (two-pass disambiguation) |
| **Event date accuracy** | ~65% (picks up deadlines, past dates) | ~92% (explicit date rules) |
| **Contact accuracy** | ~50% (general office vs event contact) | ~85% (disambiguation rules) |
| **Image event detection** | ~40% (3 images, low-res) | ~75% (5 images, high-res priority) |
| **False page skips** | ~15% of event pages skipped | ~3% (URL-only archive check) |
| **Cost per 500-URL run** | ~$8 (AI calls) | ~$12 (more images + two-pass) |
| **Error visibility** | Flat text log | Grouped errors + AI analysis + retry |
