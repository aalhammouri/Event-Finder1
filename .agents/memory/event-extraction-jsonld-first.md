---
name: Event crawler extracts JSON-LD before AI
description: Extraction order, why, and the gotchas around aggregator pages
---

The charity event crawler tries schema.org JSON-LD (`extractEventFromJsonLd`)
BEFORE any AI call. A complete JSON-LD event (name+date+venue) skips the AI
entirely — free, instant, accurate. Aggregators (allevents.in, eventbrite,
facebook events) almost always embed it.

**Why / gotchas:**
- Firecrawl's cleaned `html` format strips `<script>` tags, so JSON-LD is only
  visible in the `rawHtml` format. The crawler requests `rawHtml`.
- A JSON-LD event's own `description` is often a short blurb; the detailed
  "Silent Auction / Live Auction / Raffle" copy lives in the page body. So the
  auction/raffle/donation keyword scan also takes the page text (passed as
  `extraScanText`) — not just the JSON-LD description.
- A complete JSON-LD event still must pass the charity keyword gate (gate text =
  page text + JSON-LD name + description) so non-charity aggregator events don't
  flood results. That gate runs with NO AI call.
- When AI IS needed, content is cleaned with Mozilla Readability (jsdom) first;
  raw markdown carries nav/footer junk that produced "Unnamed event" results.
- eventName and orgName are hard-guaranteed non-null via post-parse backfill
  (derived title/H1/URL slug for name; event name or page host for org).
