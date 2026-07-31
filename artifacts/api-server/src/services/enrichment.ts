import * as cheerio from "cheerio";
import got from "got";
import { logger } from "../lib/logger";
import { resolveHostIsSafe, ssrfRedirectHook } from "../utils/ssrf";
import { isTicketPlatformUrl, scoreTicketLink, ticketPlatformName } from "./ticketPlatforms";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, type ExtractedEvent } from "./extractor";
import { createLimiter } from "./rateLimiter";
import { todayForPrompt } from "./dates";

/**
 * One-hop enrichment from third-party ticketing platforms.
 *
 * A nonprofit's own event page typically says "2026 Gala — Buy Tickets" and
 * nothing else. The date, venue, ticket price and sponsorship ladder live on
 * the linked qGiv / OneCause / GiveButter / DonorPerfect page. This module
 * fetches that ONE linked page and fills the gaps in an already-extracted
 * event. It never recurses and never treats the platform page as its own
 * event — the nonprofit page remains the source of record.
 */

// Enrichment is a bounded side-quest: cap parallel work so it cannot crowd out
// the main crawl or the AI budget.
const enrichLimit = createLimiter(Math.max(1, Number(process.env.ENRICH_MAX_CONCURRENCY) || 3));

/** Max platform pages fetched per source event. */
const MAX_LINKS_PER_EVENT = 2;

const ENRICH_SCHEMA = {
  name: "ticket_page_extraction",
  strict: true,
  schema: {
    type: "object",
    properties: {
      eventDate: { anyOf: [{ type: "string" }, { type: "null" }] },
      eventVenue: { anyOf: [{ type: "string" }, { type: "null" }] },
      eventAddress: { anyOf: [{ type: "string" }, { type: "null" }] },
      ticketPrice: { anyOf: [{ type: "number" }, { type: "null" }] },
      tablePrice: { anyOf: [{ type: "number" }, { type: "null" }] },
      hasSilentAuction: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      hasLiveAuction: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      hasRaffle: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      sponsorshipMentioned: { anyOf: [{ type: "boolean" }, { type: "null" }] },
      contactEmail: { anyOf: [{ type: "string" }, { type: "null" }] },
      contactPhone: { anyOf: [{ type: "string" }, { type: "null" }] },
      rsvpLink: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: [
      "eventDate", "eventVenue", "eventAddress", "ticketPrice", "tablePrice",
      "hasSilentAuction", "hasLiveAuction", "hasRaffle", "sponsorshipMentioned",
      "contactEmail", "contactPhone", "rsvpLink",
    ],
    additionalProperties: false,
  },
};

function buildEnrichPrompt(): string {
  return `Today's date is ${todayForPrompt()}.

You are reading a TICKETING or SPONSORSHIP page for a charity fundraising event (hosted on a platform such as qGiv, OneCause, GiveButter, DonorPerfect or similar). Extract only the logistical facts.

RULES:
- eventDate: copy the date EXACTLY as written on the page (e.g. "October 3, 2026"). Do NOT judge whether it has already happened — that is decided elsewhere. Return null only if no date appears.
- ticketPrice: the per-person / individual ticket price as a number. If several tiers exist, use the LOWEST individual admission price. Ignore table prices here.
- tablePrice: the price for a full table OR the lowest sponsorship level that includes a table. Numbers only.
- hasSilentAuction / hasLiveAuction / hasRaffle: true only when the page explicitly says so.
- sponsorshipMentioned: true when sponsorship or underwriting levels are listed.
- Return null for anything not stated. Never invent a value.

Return ONLY JSON matching the schema.`;
}

/**
 * Collect candidate ticket-platform links from a page's HTML, best first.
 */
export function findTicketLinks(html: string, baseUrl: string): string[] {
  if (!html) return [];
  let $: ReturnType<typeof cheerio.load>;
  try {
    $ = cheerio.load(html);
  } catch {
    return [];
  }

  const scored = new Map<string, number>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    let abs: string;
    try {
      abs = new URL(href, baseUrl).href;
    } catch {
      return;
    }
    if (!isTicketPlatformUrl(abs)) return;
    const text = $(el).text().replace(/\s+/g, " ").trim().slice(0, 120);
    const score = scoreTicketLink(abs, text);
    const existing = scored.get(abs) ?? -1;
    if (score > existing) scored.set(abs, score);
  });

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url]) => url)
    .slice(0, MAX_LINKS_PER_EVENT);
}

/** Fetch a platform page and reduce it to readable text. */
async function fetchPlatformText(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const { hostname } = new URL(url);
    if (!(await resolveHostIsSafe(hostname))) {
      logger.warn({ url }, "Enrichment: DNS check blocked host");
      return null;
    }
    const response = await got(url, {
      timeout: { request: timeoutMs },
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; EventFinderBot/1.0)",
        Accept: "text/html",
      },
      followRedirect: true,
      retry: { limit: 1 },
      hooks: ssrfRedirectHook,
    });
    const $ = cheerio.load(response.body);
    $("script, style, noscript, svg, iframe").remove();
    const text = $("body").text().replace(/\s+/g, " ").trim();
    return text.length > 80 ? text.slice(0, 8000) : null;
  } catch (err) {
    logger.warn({ url, err }, "Enrichment fetch failed");
    return null;
  }
}

type EnrichableFields = Pick<
  ExtractedEvent,
  | "eventDate" | "eventVenue" | "eventAddress" | "ticketPrice" | "tablePrice"
  | "hasSilentAuction" | "hasLiveAuction" | "hasRaffle" | "sponsorshipMentioned"
  | "contactEmail" | "contactPhone" | "rsvpLink"
>;

/** Ask the model for the logistics on one platform page. */
async function extractFromPlatformPage(url: string, text: string): Promise<Partial<EnrichableFields> | null> {
  const client = getAnthropicClient();
  if (!client) return null;
  try {
    const response = await enrichLimit(() =>
      client.messages.create({
        model: "claude-opus-5",
        max_tokens: 600,
        system: [{ type: "text", text: buildEnrichPrompt(), cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: `Ticket page URL: ${url}\n\nPage content:\n${text}` },
        ],
        output_config: {
          format: { type: "json_schema", schema: ENRICH_SCHEMA.schema as Record<string, unknown> },
          effort: "low",
        },
      })
    );
    if (response.stop_reason === "refusal") return null;
    const raw = response.content.find((b) => b.type === "text")?.text;
    if (!raw) return null;
    return JSON.parse(raw) as Partial<EnrichableFields>;
  } catch (err) {
    logger.warn({ url, err }, "Enrichment extraction failed");
    return null;
  }
}

export interface EnrichmentOutcome {
  /** Fields recovered from platform pages, already gap-filled onto the event. */
  applied: Partial<EnrichableFields>;
  /** Platform URLs actually read. */
  sources: string[];
}

/**
 * Enrich an extracted event using ticket-platform links found on its page.
 * Fills GAPS ONLY — a value already extracted from the nonprofit's own page
 * always wins, since that is the authoritative source.
 */
export async function enrichFromTicketLinks(
  event: ExtractedEvent,
  pageHtml: string | undefined,
  pageUrl: string,
  timeoutMs: number
): Promise<EnrichmentOutcome> {
  const outcome: EnrichmentOutcome = { applied: {}, sources: [] };
  if (!pageHtml) return outcome;

  const links = findTicketLinks(pageHtml, pageUrl);
  if (links.length === 0) return outcome;

  // Only spend calls when something worth recovering is actually missing.
  const missing = (): boolean =>
    !event.eventDate || !event.eventVenue ||
    event.ticketPrice == null || event.tablePrice == null;

  for (const link of links) {
    if (!missing()) break;

    const text = await fetchPlatformText(link, timeoutMs);
    if (!text) continue;

    const data = await extractFromPlatformPage(link, text);
    if (!data) continue;

    outcome.sources.push(link);
    logger.info(
      { pageUrl, link, platform: ticketPlatformName(link) },
      "Enriched event from ticket platform page"
    );

    for (const [key, value] of Object.entries(data)) {
      if (value === null || value === undefined || value === "") continue;
      const current = (event as any)[key];
      const isEmpty =
        current === null || current === undefined || current === "" || current === false;
      if (isEmpty) {
        (event as any)[key] = value;
        (outcome.applied as any)[key] = value;
      }
    }

    // Record where the ticket detail came from when the page had no RSVP link.
    if (!event.rsvpLink) {
      event.rsvpLink = link;
      (outcome.applied as any).rsvpLink = link;
    }
  }

  return outcome;
}
