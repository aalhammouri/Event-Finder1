import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";
import got from "got";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { logger } from "../lib/logger";
import { createLimiter } from "./rateLimiter";
import { todayForPrompt } from "./dates";
import { passesKeywordGate as gatePasses } from "./gate";
import { resolveHostIsSafe, ssrfRedirectHook } from "../utils/ssrf";

// Global cap on concurrent Anthropic calls — with multiple sites crawled in
// parallel, this prevents a burst of simultaneous AI requests from tripping
// provider rate limits.
const aiLimit = createLimiter(Math.max(1, Number(process.env.AI_MAX_CONCURRENCY) || 4));

let anthropicClient: Anthropic | null = null;

export function getAnthropicClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ maxRetries: 3 });
  }
  return anthropicClient;
}

/** Backward-compat alias — importers updated incrementally. */
export const getOpenAIClient = getAnthropicClient;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

function usageFromResponse(usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

export interface ExtractedEvent {
  eventName?: string;
  eventDate?: string;
  eventVenue?: string;
  eventAddress?: string;
  eventDescription?: string;
  auctionType?: string;
  hasSilentAuction?: boolean;
  hasLiveAuction?: boolean;
  hasOnlineAuction?: boolean;
  hasRaffle?: boolean;
  hasDonationRequest?: boolean;
  ticketPrice?: number | null;
  tablePrice?: number | null;
  formality?: string;
  rsvpLink?: string;
  contactTitle?: string;
  contactFirstName?: string;
  contactLastName?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  audienceNote?: string;
  sponsorshipMentioned?: boolean;
  orgName?: string;
  orgAddress?: string;
  orgCity?: string;
  orgState?: string;
  orgZip?: string;
  orgPhone?: string;
  orgEmail?: string;
  orgWebsite?: string;
  relevant?: boolean;
}

// ── B1: Broad recall-tuned keyword set ────────────────────────────────────────
// Any page matching ANY signal is sent to AI. "A wasted cheap AI call is fine;
// a missed event is not." — spec
const BROAD_RECALL_KEYWORDS = [
  "silent auction", "live auction", "online auction", "virtual auction",
  "gala", "raffle", "drawing", "50/50", "50-50",
  "benefit dinner", "benefit concert", "benefit luncheon", "benefit lunch",
  "fundrais",        // covers: fundraiser, fundraising, fundraise
  "charity", "charitable",
  "save the date",
  "sponsorship", "sponsor level", "sponsor package",
  "rsvp",
  "table of ",       // "table of 10", "table of 8"
  "paddle raise",
  "in-kind",
  "gift certificate",
  "honoree",
  "luncheon",
  "nonprofit", "non-profit",
  "proceeds benefit", "proceeds go to",
  "auction item", "auction catalog",
  "bid",
  "gala dinner", "gala event",
  "black tie", "black-tie",
  "cocktail attire",
  "annual dinner", "annual luncheon", "annual gala",
  "golf tournament",  // charity golf
  "golf outing",
  "buy a table", "purchase tickets",
  "join us for",      // weak signal but combined with price/date = event
  "register now",
  "tickets available", "tickets on sale",
  "sponsorship opportunities",
  "auction preview",
  "check-in", "check in",
  "vip table",
];

// Date regex: month names or MM/DD patterns
const DATE_SIGNAL_RE = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/i;

// Price regex: $ followed by digits
const PRICE_SIGNAL_RE = /\$\s*\d[\d,]*/;

/**
 * B1 gate — now delegated to services/gate.ts.
 *
 * The previous implementation let the admin "avoid" list veto ANY page by plain
 * substring match, which silently deleted real targets (a "Wine & Dine" auction
 * gala died on the word "wine"; every page of a "Museum of Fine Arts" died on
 * "arts"). The replacement makes exclusion conditional: pages carrying hard
 * fundraising evidence always pass, and avoid words only break ties on weak
 * pages. Re-exported here so existing callers keep working.
 */
export { passesKeywordGate, evaluateKeywordGate } from "./gate";

// ── B3: Keyword-dense section extraction for long pages ────────────────────────
/**
 * For pages longer than maxLen, find the keyword-dense section and return
 * a trimmed version instead of blindly truncating from the start.
 * Always preserves the first 800 chars (page title / metadata context).
 */
function extractRelevantSection(text: string, maxLen: number, allKeywords: string[]): string {
  if (text.length <= maxLen) return text;

  const lower = text.toLowerCase();
  const windowSize = maxLen - 800;
  const step = 500;
  let bestStart = 0;
  let bestScore = -1;

  for (let i = 800; i < text.length - windowSize; i += step) {
    const window = lower.slice(i, i + windowSize);
    let score = 0;
    for (const k of allKeywords) score += window.split(k.toLowerCase()).length - 1;
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  const header = text.slice(0, 800);
  if (bestStart <= 800) return text.slice(0, maxLen);
  const body = text.slice(bestStart, bestStart + windowSize);
  return `${header}\n…\n${body}`;
}

// ── B2: Strict structured output schema ───────────────────────────────────────
const EVENT_EXTRACTION_SCHEMA = {
  name: "event_extraction",
  strict: true,
  schema: {
    type: "object",
    properties: {
      relevant: { type: "boolean" },
      eventName: { anyOf: [{ type: "string" }, { type: "null" }] },
      eventDate: { anyOf: [{ type: "string" }, { type: "null" }] },
      eventVenue: { anyOf: [{ type: "string" }, { type: "null" }] },
      eventAddress: { anyOf: [{ type: "string" }, { type: "null" }] },
      eventDescription: { anyOf: [{ type: "string" }, { type: "null" }] },
      auctionType: {
        anyOf: [
          { type: "string", enum: ["silent", "live", "both", "online", "none"] },
          { type: "null" },
        ],
      },
      hasSilentAuction: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      hasLiveAuction: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      hasOnlineAuction: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      hasRaffle: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      hasDonationRequest: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      ticketPrice: { anyOf: [{ type: "number" }, { type: "null" }] },
      tablePrice: { anyOf: [{ type: "number" }, { type: "null" }] },
      formality: {
        anyOf: [
          { type: "string", enum: ["black-tie", "gala", "cocktail", "casual", "unknown"] },
          { type: "null" },
        ],
      },
      rsvpLink: { anyOf: [{ type: "string" }, { type: "null" }] },
      contactTitle: { anyOf: [{ type: "string" }, { type: "null" }] },
      contactFirstName: { anyOf: [{ type: "string" }, { type: "null" }] },
      contactLastName: { anyOf: [{ type: "string" }, { type: "null" }] },
      contactName: { anyOf: [{ type: "string" }, { type: "null" }] },
      contactEmail: { anyOf: [{ type: "string" }, { type: "null" }] },
      contactPhone: { anyOf: [{ type: "string" }, { type: "null" }] },
      audienceNote: { anyOf: [{ type: "string" }, { type: "null" }] },
      sponsorshipMentioned: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      orgName: { anyOf: [{ type: "string" }, { type: "null" }] },
      orgAddress: { anyOf: [{ type: "string" }, { type: "null" }] },
      orgCity: { anyOf: [{ type: "string" }, { type: "null" }] },
      orgState: { anyOf: [{ type: "string" }, { type: "null" }] },
      orgZip: { anyOf: [{ type: "string" }, { type: "null" }] },
      orgPhone: { anyOf: [{ type: "string" }, { type: "null" }] },
      orgEmail: { anyOf: [{ type: "string" }, { type: "null" }] },
      orgWebsite: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: [
      "relevant", "eventName", "eventDate", "eventVenue", "eventAddress",
      "eventDescription", "auctionType", "hasSilentAuction", "hasLiveAuction",
      "hasOnlineAuction", "hasRaffle", "hasDonationRequest", "ticketPrice",
      "tablePrice", "formality", "rsvpLink", "contactTitle", "contactFirstName",
      "contactLastName", "contactName", "contactEmail", "contactPhone",
      "audienceNote", "sponsorshipMentioned", "orgName", "orgAddress",
      "orgCity", "orgState", "orgZip", "orgPhone", "orgEmail", "orgWebsite",
    ],
    additionalProperties: false,
  },
};

// 1C Pass 1 schema — fast relevance + name/date classification
const EVENT_CLASSIFY_SCHEMA = {
  name: "event_classification",
  strict: true,
  schema: {
    type: "object",
    properties: {
      relevant: { type: "boolean" },
      eventName: { anyOf: [{ type: "string" }, { type: "null" }] },
      eventDate: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: ["relevant", "eventName", "eventDate"],
    additionalProperties: false,
  },
};

// Schema for vision-based extraction — all fields optional except relevant
// (prompt says "omit if you cannot determine")
const IMAGE_EXTRACTION_SCHEMA: { [key: string]: unknown } = {
  type: "object",
  properties: {
    relevant: { type: "boolean" },
    eventName: { anyOf: [{ type: "string" }, { type: "null" }] },
    eventDate: { anyOf: [{ type: "string" }, { type: "null" }] },
    eventVenue: { anyOf: [{ type: "string" }, { type: "null" }] },
    ticketPrice: { anyOf: [{ type: "number" }, { type: "null" }] },
    tablePrice: { anyOf: [{ type: "number" }, { type: "null" }] },
    auctionType: {
      anyOf: [
        { type: "string", enum: ["silent", "live", "both", "online", "none"] },
        { type: "null" },
      ],
    },
    hasSilentAuction: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    hasLiveAuction: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    orgName: { anyOf: [{ type: "string" }, { type: "null" }] },
    contactEmail: { anyOf: [{ type: "string" }, { type: "null" }] },
    contactPhone: { anyOf: [{ type: "string" }, { type: "null" }] },
    rsvpLink: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["relevant"],
  additionalProperties: false,
};

// Built per call, never cached: the server is long-running, so a module-level
// constant would freeze "today" at boot time and drift after midnight.
const classifySystemPrompt = (): string => `Today's date is ${todayForPrompt()}.

You are a strict charity fundraising event classifier for a financial advisory firm that sponsors charity galas, silent auctions, and major nonprofit fundraisers.

Decide whether the page describes a SINGLE qualifying charity fundraising event, then identify its name and date.

QUALIFYING events MUST be a charity gala, fundraising dinner, silent/live auction, benefit concert, charity golf tournament, or similar nonprofit fundraiser that is hosted by or benefits a nonprofit/foundation/hospital/school/charity, raises money for a cause, and is an actual ticketed or sponsored event (not just an article ABOUT events).

Set relevant=false when the page is: a business/corporate conference or trade show; a community/craft/farmer's market or vendor fair; a sporting event where charity is not the primary purpose; a recurring class or meetup; a general events-calendar listing (multiple events, no single detail); or any page with NO fundraising, donation, ticket, or sponsorship language.

DATE HANDLING — READ CAREFULLY:
- Do NOT decide whether the event has already happened. That is computed in code from the date you return. Never set relevant=false because a date looks past.
- An event described in the past tense as a COMPLETED recap ("thank you to everyone who attended", "we raised $X") is a recap article — set relevant=false for that reason, not because of the date.
- If the page announces a future edition ("Save the Date", "2027 tickets on sale"), that IS relevant.
- eventDate: copy the date EXACTLY as printed on the page. Do not reformat, do not convert, do not infer a year that is not written.

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

ALSO DISQUALIFY (relevant=false) if the page is:
- A SOFTWARE VENDOR or PLATFORM marketing page — a company that SELLS auction
  software, event management tools, or fundraising platforms. Signs: "our platform",
  "our software", "schedule a demo", "pricing plans", "features", "testimonials",
  "case studies".
- An EVENT AGGREGATOR listing page (AllEvents.in, Eventbrite, Facebook Events) —
  these have incomplete data and are not the org's own website.

When relevant=true:
- eventName: the EVENT's own title (e.g. "2026 Hearts of Gold Gala"), NEVER the hosting organization's name. Use the supplied page title or first heading if the body has no clearer name. Never return null when relevant=true.
- eventDate: the specific date as written (e.g. "April 30, 2026"). Return null only if genuinely absent.

Return ONLY valid JSON matching the schema. No markdown, no explanation.`;

const systemPrompt = (): string => `Today's date is ${todayForPrompt()}.

You are a strict charity fundraising event analyst for a financial advisory firm that sponsors charity galas, silent auctions, and major nonprofit fundraisers.

Your job: determine whether a webpage describes a QUALIFYING charity fundraising event, and if so, extract all structured details.

INPUT FORMAT: The page content you receive is the clean main article text of the page (navigation menus, breadcrumbs, cookie banners, sidebars, and footers have been stripped out). The user message also supplies the page title and first heading separately — these are reliable sources for the event name. Use them:
- The supplied page title or first heading is almost always the event name — use it when no clearer name appears in the body.
- Dates, ticket prices, and venue names usually appear near the top of the content.
- Pricing tiers, schedule details, and sponsorship levels appear as lists in the body.

ABSOLUTE REQUIREMENTS — these two fields are MANDATORY and must NEVER be null, empty, or "Unnamed event":
- eventName: REQUIRED. If no explicit event name is in the body, use the page title or first heading from the user message. A name is ALWAYS derivable — never return null or "Unnamed event".
- orgName: REQUIRED. Check the page title, headings, "Presented by"/"Benefiting"/"About" text, and any branding. Make a best effort — never return null.

QUALIFYING events MUST be:
- A charity gala, fundraising dinner, silent auction, live auction, benefit concert, golf tournament for charity, or similar nonprofit fundraiser
- Hosted by or benefiting a nonprofit, foundation, hospital, school, or charity organization
- Raising money for a cause (proceeds benefit someone or something beyond the organizer)
- An actual ticketed or sponsored event (not just a webpage, blog post, or news article ABOUT events)

DISQUALIFY and return relevant=false if the page is:
- A business conference, trade show, corporate event, or company open house
- A community market, craft fair, farmer's market, or local vendor fair (even if it benefits charity tangentially)
- A sporting event or competition where charity is not the primary stated purpose
- A recurring class, meetup, or organizational staff meeting
- A general "events calendar" listing page (multiple events, no single event detail)
- A completed-event RECAP written in the past tense ("thank you to all who attended", "we raised $X this year") with no future edition announced
- Any event where there is NO clear fundraising, donation, ticket purchase, or sponsorship language

DATE HANDLING — READ CAREFULLY:
- Do NOT decide whether an event has already occurred. Whether a date is past is computed in code from the string you return. Never set relevant=false because a date looks past.
- Extract the date EXACTLY as printed. Do not reformat it, do not convert it, and do not invent a year that is not written on the page.

FIELD POPULATION RULES — READ THESE CAREFULLY:
- event_name: NEVER return null, empty string, or "Unnamed event". The first # or ## heading is usually the event name — use it. If no heading exists, use the page title provided in the user message. A name is ALWAYS derivable.
- event_date: Check ## headings, **bold spans**, and the first few paragraphs first — dates are frequently bolded or placed under a heading. Extract the date as written.
- venue name and address: Look for a heading or bold label like "Venue:", "Location:", or "Where:" followed by the venue name. Also check bulleted details sections and any address-like text.
- org_name: Check the page footer text, copyright line, "About" or "Presented by" sections, and any header branding text.
- contact info: Try to find at least one contact method (email, phone, or RSVP link). Emails and phone numbers are often in a "Contact" or "Questions?" section at the bottom.
- For every field: exhaust ALL sources on the page before returning null. Only return null when the information is genuinely absent.
- If a field is not present on the page, return null. Do NOT infer or fabricate any value.

EXTRACTION RULES (when relevant=true):
- eventDate: extract the specific date as written (e.g. "April 30, 2026" or "Thursday, April 30, 2026"). If only a year is mentioned, skip it.
- eventVenue: the name of the venue or location where the event is held
- ticketPrice: numeric dollar amount per person/ticket (e.g. 150 for $150/ticket). null if not stated.
- tablePrice: numeric dollar amount for a full table/sponsorship (e.g. 2500 for $2,500/table). null if not stated.
- formality: one of "black-tie", "gala", "cocktail", "casual", "unknown"
- auctionType: one of "silent", "live", "both", "online", "none"
- hasSilentAuction / hasLiveAuction: true only if explicitly stated
- orgName: the charity/nonprofit hosting or benefiting from the event
- eventDescription: 1-2 sentences describing what the event is and who it benefits
- contactTitle: honorific or professional title of contact (e.g. "Dr.", "Mrs.", "Executive Director")
- contactFirstName: first name of the primary contact person
- contactLastName: last name of the primary contact person
- contactName: full name of contact (fill even if first/last are also filled)
- contactEmail, contactPhone: contact methods for tickets/info
- rsvpLink: direct URL or page for registration/tickets if found
- sponsorshipMentioned: true if sponsorship packages are described
- audienceNote: brief note on attendee demographics if mentioned (e.g. "Houston philanthropic community")
- hasOnlineAuction: true if an online or virtual auction component is mentioned
- hasRaffle: true if a raffle, drawing, or prize giveaway is mentioned
- hasDonationRequest: true if a direct donation or "fund-a-need" appeal is mentioned
- orgState: 2-letter state abbreviation where the org is located (e.g. "TX", "CA")
- orgZip: zip/postal code of the org or event venue if present

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

Return ONLY valid JSON matching the schema. No markdown, no explanation.`;

const imageSystemPrompt = (): string => `Today's date is ${todayForPrompt()}.

You are analyzing an image from a webpage to determine if it is a flyer for a charity fundraising event and, if so, to extract details. Do NOT judge whether the event has already happened — copy the date as printed and let the caller decide.

FIRST, decide whether this is a charity fundraising event flyer:
- relevant: true ONLY if the image is a flyer/poster for a charity gala, silent auction, benefit dinner, fundraising event, or nonprofit fundraiser with clear fundraising language (auction, donate, proceeds benefit, sponsorship, etc.)
- relevant: false for general community events, business/corporate events, sports, photos, logos, decorative images, or any image without explicit charity/fundraising language

If relevant=true, extract any of these fields that are clearly visible:
- eventName: the event title as shown
- eventDate: the date as written on the image
- eventVenue: the venue/location name
- ticketPrice: numeric dollar amount per ticket/person
- tablePrice: numeric dollar amount per table
- auctionType: "silent", "live", "both", or "none"
- hasSilentAuction: true/false
- hasLiveAuction: true/false
- orgName: the charity or organization name
- contactEmail or contactPhone if visible
- rsvpLink: any URL shown for registration

Return ONLY a JSON object. Always include "relevant": true or false. Omit other fields you cannot determine. If this is not a fundraiser flyer, return {"relevant": false}.`;

// ── B2: Post-parse validation ──────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Full US state names → USPS 2-letter codes. JSON-LD `addressRegion` (and
// occasionally the AI) returns full names like "Texas"; the geography filter
// compares against 2-letter codes, so normalize here for every extraction path.
const US_STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};

function normalizeStateCode(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (!t) return undefined;
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  return US_STATE_CODES[t.toLowerCase()] ?? t;
}

function validateAndNormalize(result: ExtractedEvent): ExtractedEvent {
  // Validate email
  if (result.contactEmail && !EMAIL_RE.test(result.contactEmail)) {
    result.contactEmail = undefined;
  }

  // Normalize phone to digits + formatting chars only
  if (result.contactPhone) {
    const digits = result.contactPhone.replace(/[^\d+\-().x ]/g, "").trim();
    result.contactPhone = digits || undefined;
  }

  // Validate date — reject clearly unparseable strings, keep as-is otherwise
  // (we store as text, not Date objects, so just sanity-check)
  if (result.eventDate) {
    const hasSomeNumber = /\d/.test(result.eventDate);
    if (!hasSomeNumber) result.eventDate = undefined;
  }

  // Org email validation
  if (result.orgEmail && !EMAIL_RE.test(result.orgEmail)) {
    result.orgEmail = undefined;
  }

  // Normalize full state names ("Texas") to USPS codes ("TX") so the
  // geography filter compares like against like on every extraction path.
  result.orgState = normalizeStateCode(result.orgState);

  return result;
}

// ── JSON-LD structured data extraction (schema.org Event) ──────────────────────
// Many event pages (especially aggregators like allevents.in, eventbrite.com,
// facebook.com/events) embed schema.org Event data in <script type="application/ld+json">.
// This is machine-readable, free, instant, and 100% accurate — parse it BEFORE the AI.

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function jsonLdText(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") {
    const t = decodeHtmlEntities(v).trim();
    return t || undefined;
  }
  if (typeof v === "number") return String(v);
  return undefined;
}

function parsePriceValue(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isNaN(v) ? null : v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^\d.]/g, "");
    if (!cleaned) return null;
    const n = parseFloat(cleaned);
    return isNaN(n) ? null : n;
  }
  return null;
}

function extractOfferPrice(offers: unknown): number | null {
  if (!offers) return null;
  const list = Array.isArray(offers) ? offers : [offers];

  // 1. Prefer an explicit lowPrice (AggregateOffer "starting at" / lowest tier)
  for (const o of list) {
    if (o && typeof o === "object") {
      const n = parsePriceValue((o as Record<string, unknown>).lowPrice);
      if (n !== null && n > 0) return n;
    }
  }

  // 2. Otherwise use the first offer's price
  for (const o of list) {
    if (o === null || o === undefined) continue;
    if (typeof o !== "object") {
      const n = parsePriceValue(o);
      if (n !== null && n > 0) return n;
      continue;
    }
    const n = parsePriceValue((o as Record<string, unknown>).price);
    if (n !== null && n > 0) return n;
  }

  // 3. Last resort: any highPrice
  for (const o of list) {
    if (o && typeof o === "object") {
      const n = parsePriceValue((o as Record<string, unknown>).highPrice);
      if (n !== null && n > 0) return n;
    }
  }

  return null;
}

function isEventType(t: unknown): boolean {
  if (!t) return false;
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === "string" && x.toLowerCase().includes("event"));
}

/**
 * Parse JSON-LD schema.org Event data from page HTML. Returns a structured
 * ExtractedEvent when an Event object is found, or null when none exists.
 * The caller decides whether the result is "complete" (name + date + venue).
 */
function normalizeJsonLdDate(raw: string | undefined): string | undefined {
  if (!raw) return raw;
  // ISO datetime like 2026-08-15T16:00:00-05:00 → keep the calendar date as written
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  return raw;
}

export function extractEventFromJsonLd(html: string, extraScanText?: string): ExtractedEvent | null {
  if (!html) return null;

  let $: ReturnType<typeof cheerio.load>;
  try {
    $ = cheerio.load(html);
  } catch {
    return null;
  }

  // Flatten every JSON-LD block, descending into @graph arrays
  const candidates: Record<string, unknown>[] = [];
  const collect = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(collect);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj["@graph"])) (obj["@graph"] as unknown[]).forEach(collect);
    candidates.push(obj);
  };

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text() || $(el).text();
    if (!raw || !raw.trim()) return;
    try {
      collect(JSON.parse(raw));
    } catch {
      // ignore malformed JSON-LD blocks
    }
  });

  const events = candidates.filter((c) => isEventType(c["@type"]));
  if (events.length === 0) return null;

  // Pick the most complete Event object when a page declares several
  const completeness = (e: Record<string, unknown>): number => {
    let s = 0;
    if (jsonLdText(e.name)) s++;
    if (jsonLdText(e.startDate)) s++;
    const loc = Array.isArray(e.location) ? e.location[0] : e.location;
    if (loc && typeof loc === "object" && (jsonLdText((loc as Record<string, unknown>).name) || (loc as Record<string, unknown>).address)) s++;
    else if (typeof loc === "string" && loc.trim()) s++;
    if (e.offers) s++;
    if (jsonLdText(e.description)) s++;
    return s;
  };
  events.sort((a, b) => completeness(b) - completeness(a));
  const ev = events[0];

  // Location / venue + address
  const loc = Array.isArray(ev.location) ? ev.location[0] : ev.location;
  let venue: string | undefined;
  let streetAddress: string | undefined;
  let city: string | undefined;
  let state: string | undefined;
  let zip: string | undefined;
  if (loc && typeof loc === "object") {
    const locObj = loc as Record<string, unknown>;
    venue = jsonLdText(locObj.name);
    const addr = locObj.address;
    if (typeof addr === "string") {
      streetAddress = addr.trim() || undefined;
    } else if (addr && typeof addr === "object") {
      const addrObj = addr as Record<string, unknown>;
      streetAddress = jsonLdText(addrObj.streetAddress);
      city = jsonLdText(addrObj.addressLocality);
      state = jsonLdText(addrObj.addressRegion);
      zip = jsonLdText(addrObj.postalCode);
    }
    if (!venue && streetAddress) venue = streetAddress;
  } else if (typeof loc === "string") {
    venue = loc.trim() || undefined;
  }

  // Organizer name (helps the beneficiary scoring signal)
  const organizer = Array.isArray(ev.organizer) ? ev.organizer[0] : ev.organizer;
  const orgName = organizer && typeof organizer === "object"
    ? jsonLdText((organizer as Record<string, unknown>).name)
    : jsonLdText(organizer);

  const name = jsonLdText(ev.name);
  const startDate = normalizeJsonLdDate(jsonLdText(ev.startDate));
  const description = jsonLdText(ev.description);
  const ticketPrice = extractOfferPrice(ev.offers);

  // Scan name + description (plus the page body when provided) for auction /
  // raffle / donation signals. The JSON-LD `description` is often a short blurb,
  // so the detailed "Silent Auction, Live Auction, Raffle" copy usually lives in
  // the page body — include extraScanText so those flags are not missed.
  const scanText = `${name ?? ""} ${description ?? ""} ${extraScanText ?? ""}`.toLowerCase();
  const hasSilentAuction = scanText.includes("silent auction");
  const hasLiveAuction = scanText.includes("live auction");
  const hasOnlineAuction = scanText.includes("online auction") || scanText.includes("virtual auction");
  const hasRaffle = /\braffle\b/.test(scanText) || scanText.includes("50/50") || scanText.includes("drawing");
  const hasDonationRequest = scanText.includes("donat") || scanText.includes("fund-a-need") || scanText.includes("paddle raise");

  let auctionType: string | undefined;
  if (hasSilentAuction && hasLiveAuction) auctionType = "both";
  else if (hasSilentAuction) auctionType = "silent";
  else if (hasLiveAuction) auctionType = "live";
  else if (hasOnlineAuction) auctionType = "online";

  const result: ExtractedEvent = {
    eventName: name,
    eventDate: startDate,
    eventVenue: venue,
    eventAddress: streetAddress,
    eventDescription: description,
    ticketPrice,
    tablePrice: null,
    orgName,
    orgCity: city,
    orgState: state,
    orgZip: zip,
    hasSilentAuction,
    hasLiveAuction,
    hasOnlineAuction,
    hasRaffle,
    hasDonationRequest,
    auctionType,
    relevant: true,
  };

  return validateAndNormalize(result);
}

// ── SSRF guard ─────────────────────────────────────────────────────────────────
function isPrivateHostname(hostname: string): boolean {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  const parts = h.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
  }
  return false;
}

// ── Image URL extraction from HTML ────────────────────────────────────────────
export function extractImageUrls(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const domain = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return "";
    }
  })();
  const priorityUrls: string[] = [];
  const regularUrls: string[] = [];

  $("img").each((_, el) => {
    // 1D: also parse srcset / data-srcset (take the first candidate URL) so
    // lazy-loaded and responsive flyer images are not missed.
    const srcsetRaw = $(el).attr("srcset") || $(el).attr("data-srcset") || "";
    const srcsetFirst = srcsetRaw.split(",")[0]?.trim().split(/\s+/)[0] || "";
    const src =
      $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-lazy-src") || srcsetFirst;
    if (!src) return;

    const srcLower = src.toLowerCase();
    if (
      srcLower.includes("logo") || srcLower.includes("icon") ||
      srcLower.includes("avatar") || srcLower.includes("thumbnail") ||
      srcLower.includes("sprite") || srcLower.includes(".svg")
    ) return;

    // 1D: compute alt / surrounding-text relevance BEFORE the dimension filter
    // so event flyers tagged with small width/height attrs are still kept.
    const alt = ($(el).attr("alt") || "").toLowerCase();
    const surroundingText = ($(el).closest("section, article, div").text() || "").toLowerCase().slice(0, 300);
    const isEventRelated =
      alt.includes("gala") || alt.includes("auction") || alt.includes("fundraiser") ||
      alt.includes("event") || alt.includes("benefit") || alt.includes("tournament") ||
      surroundingText.includes("gala") || surroundingText.includes("auction") ||
      surroundingText.includes("fundraiser") || surroundingText.includes("benefit");

    // 1D: relax the tiny-image filter for event-related images
    const width = parseInt($(el).attr("width") || "0", 10);
    const height = parseInt($(el).attr("height") || "0", 10);
    if (!isEventRelated && ((width > 0 && width < 80) || (height > 0 && height < 80))) return;

    try {
      const absoluteUrl = new URL(src, baseUrl).href;
      const parsed = new URL(absoluteUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
      if (parsed.hostname !== domain) return;
      if (isPrivateHostname(parsed.hostname)) return;

      if (isEventRelated) {
        priorityUrls.push(absoluteUrl);
      } else {
        regularUrls.push(absoluteUrl);
      }
    } catch {
      // skip malformed
    }
  });

  return [...new Set([...priorityUrls, ...regularUrls])].slice(0, 5);
}

/**
 * C2: Filter direct image URLs (from Firecrawl /crawl images list) by filename signals.
 * No cheerio needed — apply filename-based heuristics only.
 */
export function filterDirectImageUrls(imageUrls: string[], baseUrl: string): string[] {
  const domain = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return "";
    }
  })();

  const SKIP_SIGNALS = ["logo", "icon", "avatar", "sprite", "banner-bg", "header-bg", "footer"];
  const FLYER_SIGNALS = ["flyer", "gala", "auction", "event", "benefit", "fundrais", "2025", "2026", "2027", "poster", "invite"];

  const priority: string[] = [];
  const regular: string[] = [];

  for (const url of imageUrls) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      if (isPrivateHostname(parsed.hostname)) continue;
      // Allow same-domain and CDN images (no strict domain check for /crawl images)
      const pathLower = parsed.pathname.toLowerCase();
      const ext = pathLower.split(".").pop() ?? "";
      if (["svg", "gif", "ico", "webp"].includes(ext)) continue;

      if (SKIP_SIGNALS.some((s) => pathLower.includes(s))) continue;
      if (FLYER_SIGNALS.some((s) => pathLower.includes(s))) {
        priority.push(url);
      } else {
        regular.push(url);
      }
    } catch {
      // skip malformed
    }
  }

  return [...priority, ...regular].slice(0, 5);
}

async function fetchImageAsBase64(url: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const { hostname } = new URL(url);
    if (!(await resolveHostIsSafe(hostname))) return null;
    const response = await got(url, {
      timeout: { request: 8000 },
      responseType: "buffer",
      hooks: ssrfRedirectHook,
    });
    const contentType = (response.headers["content-type"] || "image/jpeg").split(";")[0].trim();
    if (!contentType.startsWith("image/")) return null;
    const buffer = response.body as Buffer;
    if (buffer.length < 5000 || buffer.length > 4_000_000) return null;
    return { base64: buffer.toString("base64"), mimeType: contentType };
  } catch {
    return null;
  }
}

async function extractFromImages(
  imageUrls: string[],
  client: Anthropic,
  onImageFetch?: (success: boolean) => void
): Promise<{ result: Partial<ExtractedEvent>; tokenUsage: TokenUsage }> {
  const merged: Partial<ExtractedEvent> = {};
  let totalUsage = zeroUsage();

  // 1D: analyze up to 5 candidate images, with HIGH detail for the first 2
  // (most likely the hero flyer) and LOW detail for the rest to control cost.
  const candidates = imageUrls.slice(0, 5);
  for (let idx = 0; idx < candidates.length; idx++) {
    const url = candidates[idx];
    try {
      const img = await fetchImageAsBase64(url);
      onImageFetch?.(img !== null);
      if (!img) continue;

      // claude-opus-5 native vision — no `detail` param; raw base64 not a data URI
      const response = await aiLimit(() => client.messages.create({
        model: "claude-opus-5",
        max_tokens: 600,
        system: [{ type: "text", text: imageSystemPrompt(), cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: img.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                  data: img.base64,
                },
              },
            ],
          },
        ],
        output_config: {
          format: { type: "json_schema", schema: IMAGE_EXTRACTION_SCHEMA },
        },
      }));

      // Record usage before any refusal/content check — the call was billed regardless.
      totalUsage = addUsage(totalUsage, usageFromResponse(response.usage));
      if (response.stop_reason === "refusal") continue;
      const raw = response.content.find((b) => b.type === "text")?.text;
      if (!raw) continue;

      const parsed = JSON.parse(raw) as Partial<ExtractedEvent> & { relevant?: boolean };

      if (parsed.relevant === true) {
        (merged as any).relevant = true;
      } else if (!("relevant" in merged)) {
        (merged as any).relevant = parsed.relevant ?? false;
      }

      for (const [k, v] of Object.entries(parsed)) {
        if (k === "relevant") continue;
        if (v !== null && v !== undefined && v !== "" && !(k in merged)) {
          (merged as any)[k] = v;
        }
      }

      if ((merged as any).relevant === true && merged.eventDate && merged.eventName) break;
    } catch (err) {
      logger.warn({ url, err }, "Image vision extraction failed");
    }
  }

  return { result: merged, tokenUsage: totalUsage };
}

function mergeExtracted(textResult: ExtractedEvent, imageResult: Partial<ExtractedEvent>): ExtractedEvent {
  const merged = { ...textResult };
  for (const [k, v] of Object.entries(imageResult)) {
    if (v !== null && v !== undefined && v !== "") {
      const existing = (merged as any)[k];
      if (existing === null || existing === undefined || existing === "" || existing === false) {
        (merged as any)[k] = v;
      }
    }
  }
  return merged;
}

/**
 * Produce clean main-content text for the AI from raw HTML, stripping nav menus,
 * breadcrumbs, cookie banners, sidebars, and footers. Uses Mozilla Readability
 * first; falls back to the text inside <main>/<article>/[role=main]; returns null
 * when nothing usable is found so the caller can fall back to its markdown text.
 */
function cleanContentWithReadability(html: string, pageUrl: string): string | null {
  // Primary: Readability on a jsdom document
  try {
    const dom = new JSDOM(html, { url: pageUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const text = article?.textContent?.replace(/\s+/g, " ").trim();
    if (text && text.length > 100) return text;
  } catch (err) {
    logger.warn({ pageUrl, err }, "Readability parse failed; falling back to main/article");
  }

  // Fallback: only the primary content containers
  try {
    const $ = cheerio.load(html);
    const el = $("main, article, [role='main']").first();
    if (el.length) {
      const text = el.text().replace(/\s+/g, " ").trim();
      if (text.length > 100) return text;
    }
  } catch {
    // ignore
  }

  return null;
}

// Fix 1: Readability/main-content cleaning strips footers and contact sidebars, but
// that is exactly where most nonprofits publish their phone and email. Pull that text
// out separately so it can be handed to the detail-extraction pass.
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

// 1C: mandatory-field guards — eventName and orgName must never be null/empty.
// Applied AFTER Pass 1 + Pass 2 + image merge so a value from any source wins.
function applyNameOrgGuards(result: ExtractedEvent, derivedTitle: string, pageUrl: string): void {
  const nameLower = (result.eventName ?? "").trim().toLowerCase();
  if (!nameLower || nameLower === "unknown" || nameLower === "unnamed event") {
    result.eventName = derivedTitle || undefined;
  }

  const orgLower = (result.orgName ?? "").trim().toLowerCase();
  if (!orgLower || orgLower === "unknown") {
    let hostName = "";
    try {
      hostName = new URL(pageUrl).hostname
        .replace(/^www\./, "")
        .split(".")[0]
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
    } catch {}
    result.orgName = result.eventName || hostName || undefined;
  }
}

// ── Main extraction function ───────────────────────────────────────────────────
export async function extractEventFromPage(
  pageText: string,
  pageUrl: string,
  searchKeywords: string[],
  avoidKeywords: string[],
  overrideKeywords: string[],
  pageHtml?: string,
  imageReadingEnabled?: boolean,
  directImageUrls?: string[],  // pre-extracted URLs from Firecrawl /crawl
  onImageFetch?: (success: boolean) => void
): Promise<{ event: ExtractedEvent | null; tokenUsage: TokenUsage }> {

  // B1: Broad recall-tuned keyword gate (see services/gate.ts)
  if (!gatePasses(pageText, searchKeywords, avoidKeywords, overrideKeywords)) {
    return { event: null, tokenUsage: zeroUsage() };
  }

  const client = getAnthropicClient();
  if (!client) {
    return { event: basicExtraction(pageText, pageUrl, searchKeywords), tokenUsage: zeroUsage() };
  }

  // Derive page title for fallback event name
  let pageMeta = "";
  let derivedTitle = "";
  {
    const parts: string[] = [];

    if (pageHtml) {
      const $m = cheerio.load(pageHtml);
      const title = $m("title").text().trim();
      const h1 = $m("h1").first().text().trim();
      const h2 = $m("h2").first().text().trim();
      if (title) { parts.push(`Page title: ${title}`); if (!derivedTitle) derivedTitle = title; }
      if (h1) { parts.push(`First H1: ${h1}`); if (!derivedTitle) derivedTitle = h1; }
      else if (h2) { parts.push(`First H2: ${h2}`); if (!derivedTitle) derivedTitle = h2; }
    }

    const mdHeadingMatch = pageText.match(/^#{1,2}\s+(.{3,80})$/m);
    if (mdHeadingMatch) {
      const mdHeading = mdHeadingMatch[1].trim();
      parts.push(`First markdown heading: ${mdHeading}`);
      if (!derivedTitle) derivedTitle = mdHeading;
    }

    if (!derivedTitle) {
      try {
        const segments = new URL(pageUrl).pathname.split("/").filter(Boolean);
        const last = segments[segments.length - 1] ?? "";
        derivedTitle = last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
      } catch {}
    }

    if (parts.length) pageMeta = "\n" + parts.join("\n");
  }

  // FIX 2: Clean the content before sending to the AI. Raw markdown from
  // Firecrawl/cheerio carries nav menus, breadcrumbs, cookie banners, and
  // footers that confuse the model into "Unnamed event" with empty fields.
  // When HTML is available, run Mozilla Readability to isolate the main article
  // text; fall back to the markdown only when cleaning yields nothing usable.
  let contentText = pageText;
  if (pageHtml) {
    const cleaned = cleanContentWithReadability(pageHtml, pageUrl);
    if (cleaned) contentText = cleaned;
  }

  // B3: Keyword-dense section extraction (replaces blind truncation)
  const allKeywords = [
    ...BROAD_RECALL_KEYWORDS,
    ...searchKeywords,
    ...overrideKeywords,
  ];
  // 1E: send a larger keyword-dense window to the model (8000 → 12000)
  const trimmedText = extractRelevantSection(contentText, 12000, allKeywords);
  const userContent = `Page URL: ${pageUrl}${pageMeta}\n\nPage content:\n${trimmedText}`;

  // Fix 1: footer/contact text is stripped by Readability but holds most org
  // phone/email. Provide it ONLY to Pass 2 (detail extraction) so it cannot bias
  // Pass 1 relevance/name/date classification.
  const footerText = pageHtml ? extractFooterContactText(pageHtml) : "";
  const footerBlock = footerText
    ? `\n\n--- Footer / Contact Section (use ONLY for contact/org fields, NOT for event identity) ---\n${footerText}`
    : "";

  // C1: candidate images, resolved once and shared by both branches below
  const imageUrls = imageReadingEnabled
    ? (directImageUrls && directImageUrls.length > 0
        ? filterDirectImageUrls(directImageUrls, pageUrl)
        : (pageHtml ? extractImageUrls(pageHtml, pageUrl) : []))
    : [];

  // Accumulator lives outside try/catch so tokens billed before any error/refusal
  // are preserved and returned even when extraction ultimately fails.
  let totalUsage = zeroUsage();

  try {
    // ── 1C Pass 1: classify relevance + identify the event name and date ──
    const pass1Resp = await aiLimit(() => client.messages.create({
      model: "claude-opus-5",
      max_tokens: 300,
      system: [{ type: "text", text: classifySystemPrompt(), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userContent }],
      output_config: {
        format: { type: "json_schema", schema: EVENT_CLASSIFY_SCHEMA.schema as Record<string, unknown> },
        effort: "low",
      },
    }));

    totalUsage = addUsage(totalUsage, usageFromResponse(pass1Resp.usage));

    if (pass1Resp.stop_reason === "refusal") {
      logger.warn({ pageUrl }, "AI classify pass refused");
      return { event: null, tokenUsage: totalUsage };
    }
    const pass1Raw = pass1Resp.content.find((b) => b.type === "text")?.text;
    if (!pass1Raw) return { event: null, tokenUsage: totalUsage };
    const classify = JSON.parse(pass1Raw) as {
      relevant: boolean;
      eventName: string | null;
      eventDate: string | null;
    };

    if (classify.relevant) {
      // ── 1C Pass 2: extract all remaining detail fields. Pass 1's name/date
      // are supplied as authoritative hints so the model does not confuse the
      // hosting organization with the event title. ──
      const pass1Hints =
        `\n\nAlready identified (authoritative — confirm and keep these exact values):` +
        `\n- eventName (the EVENT title, NOT the hosting organization): ${classify.eventName ?? "(none — derive the best event name)"}` +
        `\n- eventDate: ${classify.eventDate ?? "(none found)"}` +
        `\nExtract ALL remaining structured fields for this event.`;

      // 2C: run Pass 2 (details) and image vision in parallel
      const [pass2Resp, imageExtraction] = await Promise.all([
        aiLimit(() => client.messages.create({
          model: "claude-opus-5",
          max_tokens: 4000,
          system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: userContent + pass1Hints + footerBlock }],
          output_config: {
            // json_schema omitted — EVENT_EXTRACTION_SCHEMA has 31 nullable unions,
            // above Anthropic's 16-union compilation limit; rely on the system prompt.
            effort: "medium",
          },
        })),
        imageReadingEnabled && imageUrls.length > 0
          ? extractFromImages(imageUrls, client, onImageFetch).catch((err) => {
              logger.warn({ err, pageUrl }, "Image extraction failed — using text-only result");
              return { result: {} as Partial<ExtractedEvent>, tokenUsage: zeroUsage() };
            })
          : Promise.resolve({ result: {} as Partial<ExtractedEvent>, tokenUsage: zeroUsage() }),
      ]);

      totalUsage = addUsage(totalUsage, usageFromResponse(pass2Resp.usage));
      totalUsage = addUsage(totalUsage, imageExtraction.tokenUsage);

      if (pass2Resp.stop_reason === "refusal") {
        logger.warn({ pageUrl }, "AI details pass refused");
        return { event: null, tokenUsage: totalUsage };
      }
      const pass2Raw = pass2Resp.content.find((b) => b.type === "text")?.text;
      if (!pass2Raw) return { event: null, tokenUsage: totalUsage };

      const textResult = JSON.parse(pass2Raw) as ExtractedEvent;

      // Pass 1 is authoritative for relevance, name, and date (disambiguation)
      textResult.relevant = true;
      if (classify.eventName) textResult.eventName = classify.eventName;
      if (classify.eventDate) textResult.eventDate = classify.eventDate;

      // Merge image-derived fields (fills gaps only), then apply mandatory guards
      const result = mergeExtracted(textResult, imageExtraction.result);
      applyNameOrgGuards(result, derivedTitle, pageUrl);
      validateAndNormalize(result);

      if (result.relevant === false) return { event: null, tokenUsage: totalUsage };
      return { event: result, tokenUsage: totalUsage };
    }

    // ── Pass 1 said not relevant. Let an image flyer override (C4) if one
    // clearly shows a fundraiser; otherwise drop the page. ──
    if (imageReadingEnabled && imageUrls.length > 0) {
      const imageExtraction = await extractFromImages(imageUrls, client, onImageFetch).catch((err) => {
        logger.warn({ err, pageUrl }, "Image extraction failed — using text-only result");
        return { result: {} as Partial<ExtractedEvent>, tokenUsage: zeroUsage() };
      });
      totalUsage = addUsage(totalUsage, imageExtraction.tokenUsage);
      if ((imageExtraction.result as any).relevant === true) {
        const result = mergeExtracted(
          {
            relevant: true,
            eventName: classify.eventName ?? undefined,
            eventDate: classify.eventDate ?? undefined,
          },
          imageExtraction.result
        );
        applyNameOrgGuards(result, derivedTitle, pageUrl);
        validateAndNormalize(result);
        return { event: result, tokenUsage: totalUsage };
      }
    }

    return { event: null, tokenUsage: totalUsage };
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      logger.warn({ pageUrl }, "Anthropic rate limit hit — SDK already retried; falling back to regex");
    } else if (err instanceof Anthropic.AuthenticationError) {
      logger.error({ pageUrl }, "Anthropic authentication failed — check ANTHROPIC_API_KEY");
    } else if (err instanceof Anthropic.APIError) {
      logger.error({ err, pageUrl }, "Anthropic API error — falling back to regex");
    } else {
      logger.error({ err, pageUrl }, "AI extraction failed — using fallback");
    }
    // Return any tokens billed before the error — they were paid for even though extraction failed.
    return { event: basicExtraction(pageText, pageUrl, searchKeywords), tokenUsage: totalUsage };
  }
}


function basicExtraction(
  pageText: string,
  _pageUrl: string,
  searchKeywords: string[]
): ExtractedEvent | null {
  const textLower = pageText.toLowerCase();
  const hasSearch = searchKeywords.some((k) => textLower.includes(k.toLowerCase()));
  if (!hasSearch) return null;

  const lines = pageText.split("\n").filter((l) => l.trim().length > 20).slice(0, 5);
  const hasSilentAuction = textLower.includes("silent auction");
  const hasLiveAuction = textLower.includes("live auction");
  const ticketMatch = pageText.match(/\$\s*(\d[\d,]*)\s*(ticket|per person|per seat)/i);
  const tableMatch = pageText.match(/\$\s*(\d[\d,]*)\s*(table|sponsorship)/i);

  return {
    eventDescription: lines.join(" ").slice(0, 200),
    hasSilentAuction,
    hasLiveAuction,
    auctionType: hasSilentAuction ? "silent" : hasLiveAuction ? "live" : "none",
    ticketPrice: ticketMatch ? parseFloat(ticketMatch[1].replace(/,/g, "")) : null,
    tablePrice: tableMatch ? parseFloat(tableMatch[1].replace(/,/g, "")) : null,
    relevant: true,
  };
}
