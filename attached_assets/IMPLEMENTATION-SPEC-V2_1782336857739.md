# Event Finder — Implementation Spec V2

> **Context:** This spec is written against the CURRENT codebase (June 24, 2026 export).
> Workstreams 1–3 from the previous spec have been implemented. This document covers
> only what is still MISSING or BROKEN based on actual crawl output.
>
> **The output problems:** A real crawl run produced results with blank contacts, blank
> org websites, vendor spam (LuxGive), duplicates (SoundRise 6x), out-of-geography
> results (Mumbai, India), and non-charity events passing the relevance gate. The CRM
> export format does not match the required 31-column ACT CRM layout.

---

## Table of Contents

1. [What's Already Done (do NOT re-implement)](#whats-already-done)
2. [Fix 1 — Contact Extraction (blank phones, emails, names)](#fix-1--contact-extraction)
3. [Fix 2 — Org Website Always Blank](#fix-2--org-website-always-blank)
4. [Fix 3 — Block Vendor/SaaS/Aggregator Spam](#fix-3--block-vendorsaasaggregator-spam)
5. [Fix 4 — Duplicate Events](#fix-4--duplicate-events)
6. [Fix 5 — Geographic Filter](#fix-5--geographic-filter)
7. [Fix 6 — Stricter Charity Relevance Gate](#fix-6--stricter-charity-relevance-gate)
8. [Fix 7 — CRM Export (31-column ACT format)](#fix-7--crm-export-31-column-act-format)
9. [Fix 8 — Admin Settings for Export and Geography](#fix-8--admin-settings)
10. [Testing Checklist](#testing-checklist)

---

## What's Already Done

The following features are ALREADY IMPLEMENTED in the current codebase. Do NOT
re-implement or overwrite them:

- ✅ Two-pass AI extraction (Pass 1 classify + Pass 2 detail) — `extractor.ts`
- ✅ Parallel Pass 2 + image extraction — `extractor.ts` line 1001
- ✅ JSON-LD structured data fast path — `extractor.ts:475`
- ✅ Readability content cleaning — `extractor.ts:828`
- ✅ Keyword-dense section extraction (12000 chars) — `extractor.ts:144`
- ✅ Broad recall keyword gate — `extractor.ts:58`
- ✅ Archive detection (URL-path-only) — `crawler.ts:111`
- ✅ BFS link prioritization (event→front, other→back) — `crawler.ts:606-611`
- ✅ Concurrent site crawling (5 sites) — `crawlRuns.ts:92`
- ✅ Concurrent page fetching (3 pages per site) — `crawler.ts:521`
- ✅ Batch DB inserts — `crawlRuns.ts:253`
- ✅ Early termination (no keywords / enough top-tier) — `crawler.ts:614-629`
- ✅ Sitemap truncation for large sites — `crawler.ts:511`
- ✅ Richer SSE events (durationMs, textLength, eventData, skipped type) — `crawlRuns.ts:51`
- ✅ Image srcset parsing, high-res for priority images — `extractor.ts:639, 761`
- ✅ Configurable tiers (not hardcoded A/B/C) — `scorer.ts:14-18`
- ✅ Score breakdown API — `scorer.ts:177`
- ✅ Coverage tracking — `crawler.ts:677, crawlRuns.ts:239`
- ✅ Cross-run event diff (NEW/UPDATED/UNCHANGED) — `crawlRuns.ts:173`
- ✅ SSRF protection — `crawler.ts:16, extractor.ts:604`
- ✅ `boolToCrm()` with "Unkown" typo — `events.ts:241`
- ✅ Basic CRM export endpoint — `events.ts:148` (but wrong column layout — see Fix 7)
- ✅ New DB columns: `hasOnlineAuction`, `hasRaffle`, `hasDonationRequest`,
  `contactTitle`, `contactFirstName`, `contactLastName`, `orgState`, `orgZip`
- ✅ `analyze-errors` endpoint — `crawlRuns.ts` (3C)
- ✅ `retry-urls` endpoint — `crawlRuns.ts` (3D)

---

## Fix 1 — Contact Extraction

**Problem:** Every row in the output has blank First Name, Last Name, Phone, Email.
The AI prompt (`SYSTEM_PROMPT` in `extractor.ts:264`) tells the model to extract
contacts but does not tell it WHERE to look on the page. The Readability cleaning
(`cleanContentWithReadability`) strips footers and sidebars — which is where most
nonprofits put their phone numbers and email addresses.

**File:** `extractor.ts`

### Change 1A: Preserve footer/contact text for AI

The `cleanContentWithReadability` function (line 828) strips footers. But contact info
lives there. Add a separate footer-text extraction step:

```typescript
function extractFooterContactText(html: string): string {
  try {
    const $ = cheerio.load(html);
    const footerText = $("footer").text().replace(/\s+/g, " ").trim();
    const contactSection = $("[class*='contact'], [id*='contact'], [class*='footer']")
      .text().replace(/\s+/g, " ").trim();
    return [footerText, contactSection].filter(Boolean).join("\n").slice(0, 2000);
  } catch {
    return "";
  }
}
```

Then in `extractEventFromPage` (around line 953), append footer text to the user message:

```typescript
const footerText = pageHtml ? extractFooterContactText(pageHtml) : "";
const userContent = `Page URL: ${pageUrl}${pageMeta}\n\nPage content:\n${trimmedText}${
  footerText ? `\n\n--- Footer / Contact Section ---\n${footerText}` : ""
}`;
```

### Change 1B: Stronger contact instructions in AI prompt

Add this block to `SYSTEM_PROMPT` (line 264), after the existing contact field rules:

```
CONTACT SEARCH STRATEGY — LOOK IN ALL OF THESE LOCATIONS:
1. FOOTER: Most nonprofit sites put phone and email in the page footer.
   The footer text is provided separately at the end of the content — always read it.
2. "CONTACT" SECTION: Look for headings like "Contact", "Contact Us", "Questions?",
   "For More Information", "Get In Touch".
3. REGISTRATION/RSVP SECTION: Contact info is often near ticket purchase buttons.
4. COPYRIGHT LINE: Often has org name, address, phone.

WHAT TO EXTRACT — these are CRITICAL:
- orgPhone: the org's main phone number. Format: (XXX) XXX-XXXX or XXX-XXX-XXXX.
  Almost every nonprofit website has one. NEVER return null if a phone number appears
  ANYWHERE on the page, including the footer.
- orgEmail: the org's email. Look for info@, contact@, office@, or any email on page.
  NEVER return null if an email address appears ANYWHERE on the page.
- contactFirstName + contactLastName: if a specific person is named as event contact,
  extract their name separately. If only a full name appears, split it yourself.
- contactEmail / contactPhone: event-specific contact if different from org contact.

A value in orgPhone/orgEmail is ALWAYS better than null. If you find a phone/email
but aren't sure whose it is, put it in orgPhone/orgEmail.
```

---

## Fix 2 — Org Website Always Blank

**Problem:** `orgWebsite` is blank for every row. The AI prompt asks for it but rarely
extracts it because the website URL is often just the domain of the page being crawled.

**File:** `crawler.ts` — in `processPage` (line 209), after extraction

Add an auto-populate fallback after line 280 (`if (!extracted) return null;`):

```typescript
// Auto-populate orgWebsite from the crawled URL if AI didn't extract it
if (!extracted.orgWebsite) {
  try {
    const parsed = new URL(url);
    extracted.orgWebsite = `${parsed.protocol}//${parsed.hostname}`;
  } catch {}
}
```

This guarantees orgWebsite is NEVER blank — worst case it's the root domain.

---

## Fix 3 — Block Vendor/SaaS/Aggregator Spam

**Problem:** LuxGive.com (auction software vendor) appears 8+ times. Their marketing
pages mention "gala" and "silent auction" because they sell TO charities. Also,
`allevents.in` is an aggregator with incomplete data (no org phone, email, address).

**File:** `crawler.ts`

### Change 3A: Default vendor domain blacklist

Add a constant alongside the existing `ARCHIVE_PATH_SEGMENTS`:

```typescript
const DEFAULT_VENDOR_DOMAINS = [
  "luxgive.com",
  "onecause.com",
  "bidpal.net",
  "gofundme.com",
  "eventbrite.com",
  "allevents.in",
  "givebutter.com",
  "classy.org",
  "handbid.com",
  "32auctions.com",
  "biddingforgood.com",
  "charitybuzz.com",
  "galabid.com",
  "auctria.com",
  "givesmart.com",
  "facebook.com",
  "meetup.com",
];
```

In `crawlSite` (line 700), merge with the user blacklist:

```typescript
const allBlacklisted = [
  ...config.blacklistedDomains,
  ...DEFAULT_VENDOR_DOMAINS,
];
if (allBlacklisted.some((d) => domain.includes(d))) {
  onProgress({ type: "error", url: siteUrl, errorMessage: "Domain is blacklisted (vendor/aggregator)" });
  return { events: [], coverage };
}
```

### Change 3B: Vendor detection in AI Pass 1

Add to `CLASSIFY_SYSTEM_PROMPT` (line 248):

```
DISQUALIFY (relevant=false) if the page is:
- A SOFTWARE VENDOR or PLATFORM marketing page — a company that SELLS auction software,
  event management tools, or fundraising platforms. Signs: "our platform", "our software",
  "schedule a demo", "pricing plans", "features", "testimonials", "case studies".
- An EVENT AGGREGATOR listing page (AllEvents.in, Eventbrite, Facebook Events) — these
  have incomplete data and are not the org's own website.
```

---

## Fix 4 — Duplicate Events

**Problem:** SoundRise appears 6 identical times (same event, same URL).

**File:** `crawler.ts` — `deduplicateEvents` (line 170)

The current dedup uses `name + date + venue` as key. Add URL-based dedup first:

```typescript
function deduplicateEvents(events: CrawledEvent[]): CrawledEvent[] {
  const keyMap = new Map<string, CrawledEvent>();
  const urlSet = new Set<string>();
  const countFilled = (e: CrawledEvent): number =>
    Object.values(e).filter((v) => v !== null && v !== undefined && v !== "").length;

  for (const event of events) {
    // URL-based dedup first (exact same page)
    const urlKey = (event.eventPageUrl ?? "").toLowerCase().trim();
    if (urlKey && urlSet.has(urlKey)) continue;
    if (urlKey) urlSet.add(urlKey);

    // Then name+date+venue dedup (same event on different pages)
    const name = (event.eventName ?? "").toLowerCase().trim();
    const date = (event.eventDate ?? "").toLowerCase().trim();
    const venue = (event.eventVenue ?? "").toLowerCase().trim();
    const key = name || date ? `${name}|||${date}|||${venue}` : `__no-key-${Math.random()}`;
    const existing = keyMap.get(key);
    if (!existing || countFilled(event) > countFilled(existing)) {
      keyMap.set(key, event);
    }
  }
  return Array.from(keyMap.values());
}
```

---

## Fix 5 — Geographic Filter

**Problem:** SoundRise in Mumbai, India appeared. Scope is Texas.

### Change 5A: Admin settings (see Fix 8)

Add `geographic_states` (default `['TX']`) to admin_settings.

### Change 5B: Post-extraction filter

**File:** `crawler.ts` — in `processPage`, after scoring (after line 305):

```typescript
// Geographic filter: skip events clearly outside configured scope
if (config.geographicStates && config.geographicStates.length > 0) {
  const eventState = crawledEvent.orgState?.toUpperCase().trim();
  if (eventState && !config.geographicStates.includes(eventState)) {
    onProgress({
      type: "skipped", pageUrl: url, reason: "out_of_geography",
      errorMessage: `Filtered: org in ${eventState}, outside scope [${config.geographicStates.join(",")}]`,
      durationMs: Date.now() - pageStartTime,
    });
    return null;
  }
}
```

Add `geographicStates: string[]` to `CrawlConfig` interface and populate it from
admin settings in `crawlRuns.ts`:

```typescript
geographicStates: (settings?.geographicStates as string[]) ?? [],
```

When the array is empty, no geographic filtering is applied (all states allowed).

---

## Fix 6 — Stricter Charity Relevance Gate

**Problem:** "Premium Spirits & Cigars Festival" and award shows passed the gate.

**File:** `extractor.ts` — add to `CLASSIFY_SYSTEM_PROMPT` (line 248):

```
A QUALIFYING event must have at least ONE clear FUNDRAISING SIGNAL:
- Explicit mention of: "fundraiser", "fundraising", "charity", "nonprofit",
  "501(c)(3)", "tax-deductible", "proceeds benefit", "in support of"
- Sponsorship packages with levels (Gold, Silver, Platinum)
- Donation language: "donate", "contribute", "support our mission"
- Auction language: "silent auction items", "auction donations", "bid on"
- A named beneficiary charity/nonprofit organization

DISQUALIFY if NONE of these signals are present, even if the event uses words
like "gala", "ball", "festival", or "tournament" — those words alone are
NOT sufficient. A "Whiskey Tasting Gala" is NOT a charity fundraiser unless
it explicitly says proceeds benefit a nonprofit.
```

---

## Fix 7 — CRM Export (31-column ACT format)

**Problem:** The current CRM export (`events.ts:148`) has the wrong column layout.
It uses developer-friendly headers ("First Name", "Has Silent Auction") instead of the
exact ACT CRM import headers ("GCP - Silent Auction"). It's also missing columns
like `GCP - Donation Needed By`, `GCP - Event Status`, `Primary Group 2`, `Contact`,
`Company2`, and `Primary Group 3`.

**File:** `events.ts` — replace the `/events/export/crm` route (line 148) entirely:

```typescript
router.get("/events/export/crm", async (req, res) => {
  const conditions = [];
  if (req.query.runId) conditions.push(eq(eventsTable.runId, Number(req.query.runId)));
  if (req.query.tier) conditions.push(eq(eventsTable.tier, req.query.tier as string));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db.select().from(eventsTable).where(where)
    .orderBy(sql`${eventsTable.score} desc`);

  const [settings] = await db.select().from(adminSettingsTable).limit(1);
  const primaryGroup1 = (settings?.primaryGroup1Label as string) ?? "2026 Events";
  const primaryGroup3 = (settings?.primaryGroup3Label as string) ?? "";
  const defaultState = (settings?.defaultMailingState as string) ?? "TX";

  // Date formatter: M/D/YYYY (no leading zeros) — matches ACT CRM convention
  const formatDate = (dateStr: string | null | undefined): string => {
    if (!dateStr) return "";
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr; // keep as-is if unparseable
      return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
    } catch {
      return dateStr;
    }
  };

  // Exact 31-column ACT CRM import format
  const headers = [
    "GCP - Donation Needed By",
    "GCP - Online Auction",
    "GCP - Live Auction",
    "GCP - Silent Auction",
    "GCP - Raffle",
    "GCP - Event Web Page",
    "Organization ID",
    "GCP - Event Date Sort",
    "GCP - Beneficiary of Fundraiser",
    "GCP - Event",
    "First Name",
    "Last name",  // lowercase 'n' — matches ACT template
    "Salutation",
    "Title 1",
    "Mailing Address 1",
    "Mailing Address 2",
    "Mailing City",
    "Mailing State",
    "Mailing Zip",
    "Phone - Business",
    "E-mail",
    "GCP - Event Status",
    "Primary Group 1",
    "Primary Group 2",
    "Web Site",
    "GC - Estate Planning Expiration Date",
    "GCP - Items Donated",
    "Contact",
    "Imported into ACT",
    "Company2",
    "Primary Group 3",
  ];

  const csvRows = [
    headers.map(csvEscape).join(","),
    ...rows.map((e) => [
      boolToCrm(e.hasDonationRequest),
      boolToCrm(e.hasOnlineAuction),
      boolToCrm(e.hasLiveAuction),
      boolToCrm(e.hasSilentAuction),
      boolToCrm(e.hasRaffle),
      csvEscape(e.eventPageUrl),
      "",  // Organization ID (blank — filled in CRM)
      csvEscape(formatDate(e.eventDate)),
      csvEscape(e.orgName),  // Beneficiary = org name
      csvEscape(e.eventName),
      csvEscape(e.contactFirstName),
      csvEscape(e.contactLastName),
      "",  // Salutation (usually blank)
      csvEscape(e.contactTitle),
      csvEscape(e.orgName),  // Mailing Address 1 = org name (NOT street)
      csvEscape(e.orgAddress),  // Mailing Address 2 = street address
      csvEscape(e.orgCity),
      csvEscape(e.orgState ?? defaultState),
      csvEscape(e.orgZip),
      csvEscape(e.orgPhone),
      csvEscape(e.contactEmail ?? e.orgEmail),
      "Pending",  // GCP - Event Status (always)
      csvEscape(primaryGroup1),
      "Charity",  // Primary Group 2 (always)
      csvEscape(e.orgWebsite),
      "",  // GC - Estate Planning Expiration Date (blank)
      "",  // GCP - Items Donated (blank)
      csvEscape([e.contactFirstName, e.contactLastName].filter(Boolean).join(" ")),  // Contact
      "",  // Imported into ACT (blank on export)
      csvEscape((e.orgName ?? "").toUpperCase()),  // Company2 (uppercase legal name)
      csvEscape(primaryGroup3),
    ].join(",")),
  ];

  const runLabel = req.query.runId ? `run-${req.query.runId}` : "all";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",
    `attachment; filename="ACT_CRM_Export_${runLabel}_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csvRows.join("\n"));
});
```

---

## Fix 8 — Admin Settings

**File:** `lib/db/src/schema.ts` (or wherever `adminSettingsTable` is defined)

Add these columns to the `admin_settings` table:

```sql
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS primary_group_1_label TEXT DEFAULT '2026 Events';
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS primary_group_3_label TEXT DEFAULT '';
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS default_mailing_state TEXT DEFAULT 'TX';
ALTER TABLE admin_settings ADD COLUMN IF NOT EXISTS geographic_states TEXT[] DEFAULT ARRAY['TX'];
```

Update the Drizzle schema to match, then run `drizzle-kit generate` and `drizzle-kit push`.

Add an **"Export Settings"** section in the Admin UI (`pages/admin/index.tsx`) with
editable fields for these 4 settings.

Add `geographicStates` to the `CrawlConfig` interface in `crawler.ts`.

---

## Testing Checklist

### Contact extraction
- [ ] orgPhone is populated when a phone number appears in the page footer
- [ ] orgEmail is populated when an email appears anywhere on the page
- [ ] contactFirstName / contactLastName are populated when a contact person is named
- [ ] Footer text is passed to the AI even after Readability strips it

### Org website
- [ ] orgWebsite is NEVER blank — at minimum it's the root domain of the crawled URL
- [ ] When the AI extracts a specific website, that value is used instead of the fallback

### Vendor/aggregator blocking
- [ ] LuxGive.com URLs return 0 events (blacklisted)
- [ ] allevents.in URLs return 0 events (blacklisted)
- [ ] A SaaS marketing page ("schedule a demo", "our platform") returns relevant=false

### Deduplication
- [ ] Same URL appearing in multiple Firecrawl /crawl pages → deduplicated to 1 event
- [ ] Same event name+date found on different pages → kept as 1 event (richest fields)

### Geographic filter
- [ ] Event with orgState="MH" (Mumbai) is filtered out when scope is ["TX"]
- [ ] Event with orgState="TX" passes the filter
- [ ] Event with no orgState passes the filter (not filtered — we can't be sure)
- [ ] When geographicStates is empty, no filtering occurs

### Charity relevance
- [ ] "Premium Spirits & Cigars Festival" (no charity signal) → relevant=false
- [ ] "3rd Annual Black Gala Award Show" (award show, not fundraiser) → relevant=false
- [ ] "Hearts of Gold Gala benefiting Children's Hospital" → relevant=true

### CRM export
- [ ] Export has exactly 31 columns in the correct order
- [ ] Column headers match ACT CRM template exactly (including "Last name" lowercase 'n')
- [ ] Boolean fields: "Yes" / "No" / "Unkown" (with the typo)
- [ ] Dates: M/D/YYYY (no leading zeros)
- [ ] Mailing Address 1 = org name (NOT street address)
- [ ] Company2 = org name in UPPERCASE
- [ ] GCP - Event Status = "Pending" for every row
- [ ] Primary Group 1 uses admin setting value
- [ ] Primary Group 2 = "Charity" for every row

### Admin settings
- [ ] primaryGroup1Label editable in Admin UI
- [ ] primaryGroup3Label editable in Admin UI
- [ ] defaultMailingState editable in Admin UI
- [ ] geographicStates editable in Admin UI
