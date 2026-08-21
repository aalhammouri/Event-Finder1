import * as cheerio from "cheerio";
import got from "got";
import { Firecrawl as FirecrawlApp } from "@mendable/firecrawl-js";
import { logger } from "../lib/logger";
import {
  extractEventFromPage,
  extractEventFromJsonLd,
  extractImageUrls,
  filterDirectImageUrls,
  passesKeywordGate,
  zeroUsage,
  addUsage,
} from "./extractor";
import type { ExtractedEvent, TokenUsage } from "./extractor";
import { scoreEvent, getTopTierName } from "./scorer";
import { reconcileCoverage } from "./coverage";
import type { ScoringWeights, ScoringTier } from "./scorer";
import { isSafeUrl, resolveHostIsSafe, ssrfRedirectHook } from "../utils/ssrf";
import { politeDelay, withRetry } from "./rateLimiter";
import { enrichFromTicketLinks } from "./enrichment";
import { isEventPast } from "./dates";
import { evaluateKeywordGate } from "./gate";

export interface CrawlConfig {
  maxPagesPerSite: number;
  timeoutPerPage: number;
  imageReadingEnabled: boolean;
  searchKeywords: string[];
  avoidKeywords: string[];
  overrideKeywords: string[];
  blacklistedDomains: string[];
  scoringWeights: ScoringWeights;
  tiers: ScoringTier[];
  geographicStates: string[];
  // Politeness / resilience (admin-configurable)
  perDomainDelayMs: number;
  maxRetries: number;
}

export interface SiteCoverage {
  siteUrl: string;

  pagesDiscovered: number;

  pagesCrawled: number;

  pagesMissed: number;

  isComplete: boolean;

  missedUrls: string[];

  crawlErrors: Array<{ url: string; error: string }>;

  pagesKeywordMatched: number;

  pagesSentToAi: number;

  fallbackPages: number;
  /** Image fetch tracking (for run-level WARN when all fetches fail) */

  tokenUsage: TokenUsage;

  imageAttempts: number;

  imageSuccesses: number;
  /** Ticket-platform enrichment tracking */

  enrichmentAttempts: number;

  enrichmentSuccesses: number;
}

export interface CrawlProgressEvent {
  type:
    | "url_start"
    | "url_done"
    | "page_crawled"
    | "event_found"
    | "error"
    | "skipped"
    | "complete";
  url?: string;
  pageUrl?: string;
  eventName?: string;
  score?: number;
  errorMessage?: string;
  errorType?: string;
  reason?: string;
  progress?: { done: number; total: number };
  // 3A: richer live-preview metadata
  textLength?: number;
  keywordsFound?: boolean;
  durationMs?: number;
  eventData?: CrawledEvent;
}

export interface CrawledEvent {
  eventPageUrl: string;
  eventName?: string;
  eventDate?: string;
  eventVenue?: string;
  eventAddress?: string;
  eventDescription?: string;
  auctionType?: string;
  hasSilentAuction?: boolean;
  hasLiveAuction?: boolean;
  ticketPrice?: number | null;
  tablePrice?: number | null;
  formality?: string;
  rsvpLink?: string;
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
  hasOnlineAuction?: boolean;
  hasRaffle?: boolean;
  hasDonationRequest?: boolean;
  contactTitle?: string;
  contactFirstName?: string;
  contactLastName?: string;
  score: number;
  tier: string;
  isPast: boolean;
  errorMessage?: string;
}

// ── Archive / URL helpers ──────────────────────────────────────────────────────
// 1A: archive detection is URL-path-only. Scanning body text produced false
// negatives — current upcoming-event pages routinely mention "past sponsors",
// "photo gallery", or prior years while describing a future event. Match only
// explicit archive path segments.
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

// 3A: software vendors / SaaS platforms / event aggregators that mention "gala" and
// "silent auction" because they sell TO charities, plus aggregator listing sites with
// incomplete org data. Always blocked at the seed-domain level, on top of the
// user-configured blacklist.
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

const STATIC_ASSET_EXTENSIONS = [
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".mp4", ".mp3", ".mov", ".avi", ".zip", ".tar", ".gz",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".css", ".js", ".woff", ".woff2", ".ttf", ".eot", ".ico",
  // XML-family files (sitemaps, RSS feeds, Atom feeds) — never event pages
  ".xml", ".rss", ".atom",
];
const STATIC_PATH_SEGMENTS = ["/wp-content/uploads/", "/wp-json/", "/feed/", "/.well-known/", "/sitemap"];

// allowPdf: Firecrawl-backed paths parse PDFs to markdown (parsers: ["pdf"]) and
// should not skip them here; the plain got+cheerio fallback can't parse PDF
// binaries at all, so it always excludes them (allowPdf defaults to false).
function isStaticAsset(url: string, allowPdf = false): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const extensions = allowPdf ? STATIC_ASSET_EXTENSIONS.filter((ext) => ext !== ".pdf") : STATIC_ASSET_EXTENSIONS;
    if (extensions.some((ext) => pathname.endsWith(ext))) return true;
    if (STATIC_PATH_SEGMENTS.some((seg) => pathname.includes(seg))) return true;
  } catch {}
  return false;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function normalizeUrl(base: string, href: string): string | null {
  try {
    const url = new URL(href, base);
    url.hash = "";
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

function isEventUrl(url: string): boolean {
  const EVENT_PATH_KEYWORDS = [
    "event", "gala", "auction", "fundraiser", "calendar", "benefit",
    "banquet", "rsvp", "donate", "support", "tickets", "programs", "get-involved",
  ];
  const path = url.toLowerCase();
  return EVENT_PATH_KEYWORDS.some((k) => path.includes(k));
}

function deduplicateEvents(events: CrawledEvent[]): CrawledEvent[] {
  const keyMap = new Map<string, CrawledEvent>();
  const urlSet = new Set<string>();
  const countFilled = (e: CrawledEvent): number =>
    Object.values(e).filter((v) => v !== null && v !== undefined && v !== "").length;

  for (const event of events) {
    // Fix 4: URL-based dedup first (exact same page crawled more than once)
    const urlKey = (event.eventPageUrl ?? "").toLowerCase().trim();
    if (urlKey && urlSet.has(urlKey)) continue;
    if (urlKey) urlSet.add(urlKey);

    // Then name+date+venue dedup (same event surfaced on different pages)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Firecrawl client (singleton, lazy) ────────────────────────────────────────
let _firecrawlClient: FirecrawlApp | null | undefined = undefined;

function getFirecrawlClient(): FirecrawlApp | null {
  if (_firecrawlClient !== undefined) return _firecrawlClient;
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) {
    logger.warn("FIRECRAWL_API_KEY not set — falling back to got+cheerio");
    _firecrawlClient = null;
    return null;
  }
  _firecrawlClient = new FirecrawlApp({ apiKey: key });
  logger.info("Firecrawl client initialised");
  return _firecrawlClient;
}

// ── Per-page event processing ──────────────────────────────────────────────────
async function processPage(
  url: string,
  text: string,
  html: string,
  directImageUrls: string[] | undefined,
  config: CrawlConfig,
  coverage: SiteCoverage,
  onProgress: (e: CrawlProgressEvent) => void,
  pageStartTime: number = Date.now()
): Promise<CrawledEvent | null> {
  // 1A: archive detection is URL-path-only now
  if (isArchivePage(url)) {
    onProgress({ type: "skipped", pageUrl: url, reason: "archive_path", durationMs: Date.now() - pageStartTime });
    return null;
  }

  let extracted: ExtractedEvent | null = null;

  // Structured-data fast path: parse schema.org JSON-LD from the page HTML
  // BEFORE any AI call. If it yields a complete event (name + date + venue),
  // use it directly — free, instant, and 100% accurate. Still requires the
  // charity keyword gate (satisfied by the page text OR the JSON-LD event
  // text) so non-charity events on aggregator sites don't flood results.
  if (html) {
    const jsonLd = extractEventFromJsonLd(html, text);
    if (jsonLd && jsonLd.eventName && jsonLd.eventDate && jsonLd.eventVenue) {
      const gateText = `${text}\n${jsonLd.eventName}\n${jsonLd.eventDescription ?? ""}`;
      // Require an explicit fundraising signal (override keyword) before bypassing
      // the AI charity-qualification check. Pages that only match weaker search
      // keywords (e.g. "gala", "charity") still go through the AI path so a
      // schema.org Event on an aggregator site cannot slip through unchecked.
      const hasOverrideSignal = config.overrideKeywords.some(
        (kw) => gateText.toLowerCase().includes(kw.toLowerCase())
      );
      if (hasOverrideSignal) {
        coverage.pagesKeywordMatched++;
        // No AI used — intentionally do not increment coverage.pagesSentToAi
        extracted = jsonLd;
        logger.info({ url }, "Extracted event from JSON-LD structured data — skipped AI (override signal)");
      }
    }
  }

  // AI extraction path — only when JSON-LD did not produce a complete event
  if (!extracted) {
    // B1 keyword gate — use evaluateKeywordGate so the skip reason is precise
    const gateResult = evaluateKeywordGate(
      text, config.searchKeywords, config.avoidKeywords, config.overrideKeywords
    );
    if (!gateResult.pass) {
      onProgress({ type: "skipped", pageUrl: url, reason: gateResult.reason, durationMs: Date.now() - pageStartTime });
      return null;
    }
    coverage.pagesKeywordMatched++;
    coverage.pagesSentToAi++;

    try {
      const { event: evt, tokenUsage } = await extractEventFromPage(
        text,
        url,
        config.searchKeywords,
        config.avoidKeywords,
        config.overrideKeywords,
        html || undefined,
        config.imageReadingEnabled,
        directImageUrls,
        (success) => {
          coverage.imageAttempts++;
          if (success) coverage.imageSuccesses++;
        }
      );
      extracted = evt;
      coverage.tokenUsage = addUsage(coverage.tokenUsage, tokenUsage);
    } catch (err) {
      logger.error({ err, url }, "Extraction error");
      return null;
    }
  }

  if (!extracted) return null;

  // ── One-hop enrichment from ticketing platforms ────────────────────────────
  // Most nonprofit event pages say "2026 Gala — Buy Tickets" and nothing else:
  // the date, venue, ticket price and sponsorship ladder live on the linked
  // qGiv / OneCause / GiveButter / DonorPerfect page. Follow that ONE link and
  // fill the gaps. Values already extracted from the org's own page always win.
  if (html) {
    try {
      const enrichment = await enrichFromTicketLinks(
        extracted, html, url, config.timeoutPerPage * 1000
      );
      if (enrichment.sources.length > 0) {
        coverage.enrichmentAttempts++;
        if (Object.keys(enrichment.applied).length > 0) coverage.enrichmentSuccesses++;
        logger.info(
          { url, recovered: Object.keys(enrichment.applied), sources: enrichment.sources },
          "Event enriched from ticket-platform page"
        );
      }
    } catch (err) {
      logger.warn({ err, url }, "Ticket-platform enrichment failed — keeping page-only result");
    }
  }

  // Reject extractions that are still nameless after enrichment. A page that
  // returns relevant=true but no eventName (e.g. a sitemap or sparse homepage
  // that mentions "live auction" somewhere) would otherwise be stored as a
  // useless null-name row. Log the skip so admins can see which URLs failed.
  if (!extracted.eventName) {
    onProgress({
      type: "skipped",
      pageUrl: url,
      reason: "no_event_name",
      errorMessage: `Skipped: relevant=true but no event name extracted (page may be too sparse or non-event)`,
      durationMs: Date.now() - pageStartTime,
    });
    return null;
  }

  // Fix 2: guarantee orgWebsite is never blank — fall back to the crawled URL origin.
  if (!extracted.orgWebsite) {
    try {
      const parsed = new URL(url);
      extracted.orgWebsite = `${parsed.protocol}//${parsed.hostname}`;
    } catch {}
  }

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
    config.scoringWeights,
    config.tiers
  );

  const crawledEvent: CrawledEvent = {
    ...extracted,
    eventPageUrl: url,
    score,
    tier,
    // Recomputed from the (possibly enrichment-supplied) date using the shared
    // parser in services/dates.ts, which understands "October 3, 2026",
    // "10/3/26" and bare "October 3", and treats an unparseable date as NOT
    // past rather than hiding the event. `isPast` from the scorer is ignored
    // here so there is exactly one date implementation in play.
    isPast: isEventPast(extracted.eventDate),
    ticketPrice: extracted.ticketPrice ?? null,
    tablePrice: extracted.tablePrice ?? null,
  };

  // Fix 5: geographic filter — skip events whose org state is set and outside the
  // configured scope. Empty config = no filtering; null/blank state passes through.
  if (config.geographicStates && config.geographicStates.length > 0) {
    const allowed = config.geographicStates.map((s) => s.toUpperCase().trim());
    const eventState = crawledEvent.orgState?.toUpperCase().trim();
    if (eventState && !allowed.includes(eventState)) {
      onProgress({
        type: "skipped",
        pageUrl: url,
        reason: "out_of_geography",
        errorMessage: `Filtered: org in ${eventState}, outside scope [${allowed.join(",")}]`,
        durationMs: Date.now() - pageStartTime,
      });
      return null;
    }
  }

  onProgress({
    type: "event_found",
    pageUrl: url,
    eventName: extracted.eventName,
    score,
    eventData: crawledEvent,
    durationMs: Date.now() - pageStartTime,
  });
  return crawledEvent;
}

// ── A1: Firecrawl /crawl endpoint ─────────────────────────────────────────────
// PDF deliberately excluded here — event flyers are often published as PDFs and
// Firecrawl parses them to markdown (with OCR for scanned pages) when
// `parsers: ["pdf"]` is set on scrapeOptions below, so they flow through the
// same extraction pipeline as any other page.
const CRAWL_EXCLUDE_PATHS = [
  "/wp-json", "/wp-admin", "/cart", "/checkout", "/login",
  "/account", "/donate/process",
  "\\.(jpg|jpeg|png|gif|css|js|zip|svg|woff|ttf|xml|rss|atom)$",
];

async function crawlSiteWithFirecrawl(
  siteUrl: string,
  config: CrawlConfig,
  fc: FirecrawlApp,
  onProgress: (e: CrawlProgressEvent) => void,
  coverage: SiteCoverage,
  isStopped: () => boolean,
  /** Every page URL actually processed — needed for honest coverage numbers. */
  processedOut: Set<string>
): Promise<CrawledEvent[]> {
  const timeoutMs = config.timeoutPerPage * 1000;

  // Start async crawl job with completeness settings (A1)
  let jobId: string;
  try {
    const response = await withRetry(
      () => fc.asyncCrawlUrl(siteUrl, {
        crawlEntireDomain: true,
        allowSubdomains: true,
        sitemap: "include",
        limit: config.maxPagesPerSite,
        maxDiscoveryDepth: 5,
        excludePaths: CRAWL_EXCLUDE_PATHS,
        scrapeOptions: {
          formats: ["markdown", "links", "images", "rawHtml"] as any,
          parsers: ["pdf"] as any,
          onlyMainContent: false,
          waitFor: 3000,
        },
      }),
      { retries: config.maxRetries, label: "firecrawl asyncCrawlUrl" }
    );
    jobId = response.id;
    logger.info({ jobId, siteUrl }, "Firecrawl /crawl job started");
  } catch (err) {
    logger.warn({ err, siteUrl }, "asyncCrawlUrl failed — falling back to BFS");
    return [];
  }

  const processedUrls = new Set<string>();
  const events: CrawledEvent[] = [];

  // Poll until complete, processing pages as they arrive
  while (true) {
    if (isStopped()) {
      logger.info({ jobId, siteUrl }, "Stop signal — halting poll");
      break;
    }

    await sleep(3000);

    let status: any;
    try {
      status = await withRetry(
        () => (fc as any).checkCrawlStatus(jobId),
        { retries: config.maxRetries, label: "firecrawl checkCrawlStatus" }
      );
    } catch (err) {
      logger.warn({ err, jobId }, "checkCrawlStatus failed");
      break;
    }

    const pages: any[] = status.data ?? [];
    for (const page of pages) {
      const url: string = page.metadata?.sourceURL ?? page.metadata?.url ?? "";
      if (!url || processedUrls.has(url)) continue;
      if (isStaticAsset(url, true)) continue;
      processedUrls.add(url);
      processedOut.add(url);
      coverage.pagesCrawled++;

      const pageStartTime = Date.now();
      const text: string = page.markdown ?? "";
      const rawHtml: string = page.rawHtml ?? page.html ?? "";
      const imageUrls: string[] = page.images ?? [];
      const filteredImages = config.imageReadingEnabled && imageUrls.length > 0
        ? filterDirectImageUrls(imageUrls, url)
        : undefined;

      const event = await processPage(url, text, rawHtml, filteredImages, config, coverage, onProgress, pageStartTime);
      if (event) events.push(event);

      // 3A: emit page_crawled after processing so durationMs/textLength are accurate
      onProgress({ type: "page_crawled", pageUrl: url, textLength: text.length, durationMs: Date.now() - pageStartTime });
    }

    // Follow Firecrawl's pagination cursor. Responses over 10 MB are split into
    // pages returned via `status.next`; not following the cursor silently loses
    // the remainder of any large-site crawl.
    let nextCursor: string | null = (status as any).next ?? null;
    while (nextCursor) {
      let morePagesData: any;
      try {
        const r = await got<any>(nextCursor, {
          headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY ?? ""}` },
          responseType: "json",
        });
        morePagesData = r.body;
      } catch (err) {
        logger.warn({ err, jobId, nextCursor }, "Firecrawl cursor-pagination fetch failed");
        break;
      }
      for (const page of (morePagesData.data ?? []) as any[]) {
        const pageUrl: string = page.metadata?.sourceURL ?? page.metadata?.url ?? "";
        if (!pageUrl || processedUrls.has(pageUrl)) continue;
        if (isStaticAsset(pageUrl, true)) continue;
        processedUrls.add(pageUrl);
        processedOut.add(pageUrl);
        coverage.pagesCrawled++;
        const pageStartTime = Date.now();
        const pageText: string = page.markdown ?? "";
        const pageHtml: string = page.rawHtml ?? page.html ?? "";
        const pageImages: string[] = page.images ?? [];
        const filteredImages = config.imageReadingEnabled && pageImages.length > 0
          ? filterDirectImageUrls(pageImages, pageUrl)
          : undefined;
        const event = await processPage(pageUrl, pageText, pageHtml, filteredImages, config, coverage, onProgress, pageStartTime);
        if (event) events.push(event);
        onProgress({ type: "page_crawled", pageUrl, textLength: pageText.length, durationMs: Date.now() - pageStartTime });
      }
      nextCursor = (morePagesData as any).next ?? null;
    }

    if (status.status === "completed" || status.status === "failed" || status.status === "cancelled") {
      logger.info({ jobId, siteUrl, status: status.status, total: status.total, completed: status.completed }, "Crawl job finished");
      break;
    }
  }

  // A2: Capture crawl errors
  try {
    const errorsResponse = await (fc as any).getCrawlErrors(jobId);
    const errors: any[] = errorsResponse?.errors ?? errorsResponse ?? [];
    for (const e of errors) {
      const errUrl = e.url ?? e.sourceURL ?? "";
      const errMsg = e.error ?? e.message ?? "Unknown error";
      coverage.crawlErrors.push({ url: errUrl, error: errMsg });
    }
    if (coverage.crawlErrors.length > 0) {
      logger.info({ jobId, errorCount: coverage.crawlErrors.length }, "Crawl errors captured");
    }
  } catch (err) {
    logger.warn({ err, jobId }, "getCrawlErrors failed");
  }

  return events;
}

// ── Fallback: BFS with got+cheerio / Firecrawl /scrape per page ───────────────
async function fetchPageFirecrawl(
  url: string,
  domain: string,
  fc: FirecrawlApp,
  timeoutMs: number
): Promise<{ text: string; html: string; links: string[] } | null> {
  try {
    const scrapePromise = fc.scrape(url, {
      formats: ["markdown", "rawHtml", "links"] as any,
      parsers: ["pdf"] as any,
      onlyMainContent: false,
    } as any);

    let timeoutHandle!: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`Firecrawl timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    const result = await Promise.race([scrapePromise, timeoutPromise]);
    clearTimeout(timeoutHandle);

    const text = result.markdown ?? "";
    const html = (result as any).rawHtml ?? result.html ?? "";
    const rawLinks: string[] = result.links ?? [];
    const links = rawLinks
      .map((href) => normalizeUrl(url, href))
      .filter((u): u is string => !!u && getDomain(u) === domain && !isStaticAsset(u, true));

    return { text, html, links };
  } catch (err) {
    logger.warn({ url, err }, "Firecrawl scrape threw or timed out");
    return null;
  }
}

async function fetchPageFallback(
  url: string,
  timeoutMs: number,
  maxRetries = 0
): Promise<{ text: string; html: string } | null> {
  try {
    const hostname = new URL(url).hostname;
    if (!(await resolveHostIsSafe(hostname))) {
      logger.warn({ url }, "fetchPageFallback: DNS check blocked non-public host");
      return null;
    }
    const response = await withRetry(
      () => got(url, {
        timeout: { request: timeoutMs },
        headers: { "User-Agent": "Mozilla/5.0 (compatible; EventFinderBot/1.0)", Accept: "text/html" },
        followRedirect: true,
        hooks: ssrfRedirectHook,
      }),
      { retries: maxRetries, domain: hostname, label: "fallback fetch" }
    );
    const html = response.body;
    const $ = cheerio.load(html);
    $("script, style, nav, header, footer, head, aside, iframe, noscript, [role='navigation'], [role='banner'], [role='complementary'], .cookie-banner, .nav, .navbar, .menu, .sidebar, .breadcrumb").remove();
    const mainEl = $("main, article, [role='main'], .main-content, #main-content, .post-content, .entry-content, .content-area, #content").first();
    const text = (mainEl.length ? mainEl : $("body")).text().replace(/\s+/g, " ").trim();
    return { text, html };
  } catch (err) {
    logger.warn({ url, err }, "Fallback fetch failed");
    return null;
  }
}

async function crawlSiteWithBFS(
  siteUrl: string,
  config: CrawlConfig,
  fc: FirecrawlApp | null,
  onProgress: (e: CrawlProgressEvent) => void,
  coverage: SiteCoverage,
  isStopped: () => boolean = () => false,
  /** Every page URL actually processed — needed for honest coverage numbers. */
  processedOut: Set<string> = new Set()
): Promise<CrawledEvent[]> {
  const domain = getDomain(siteUrl);
  const timeoutMs = config.timeoutPerPage * 1000;
  const visited = new Set<string>();
  const toVisit: string[] = [];
  const events: CrawledEvent[] = [];

  // Seed from sitemap
  const sitemapUrls = await getSitemapUrls(siteUrl, timeoutMs);
  if (sitemapUrls.length > 0) {
    const crawlable = sitemapUrls.filter((u) => !isStaticAsset(u));
    const eventUrls = crawlable.filter(isEventUrl);
    const otherUrls = crawlable.filter((u) => !isEventUrl(u));
    // 2E: cap very large sitemaps so one site can't dominate the run. Keep
    // event-path URLs first (and more of them) since they are higher-yield.
    if (sitemapUrls.length > 200) {
      toVisit.push(...eventUrls.slice(0, 100), ...otherUrls.slice(0, 50));
    } else {
      toVisit.push(...eventUrls, ...otherUrls);
    }
  } else {
    toVisit.push(siteUrl);
  }

  // 2B: fetch pages in small concurrent batches instead of one at a time.
  const PAGE_CONCURRENCY = 3;
  // 2E: early-termination bookkeeping. Tier names are admin-configurable, so
  // resolve the top tier from config rather than hard-coding "A".
  const topTierName = getTopTierName(config.tiers);
  let consecutiveNoKeywords = 0;
  let topTierCount = 0;

  while (toVisit.length > 0 && visited.size < config.maxPagesPerSite) {
    if (isStopped()) {
      logger.info({ siteUrl }, "Stop signal — halting BFS");
      break;
    }

    // Pull up to PAGE_CONCURRENCY not-yet-visited, same-domain URLs
    const batch: string[] = [];
    while (batch.length < PAGE_CONCURRENCY && toVisit.length > 0) {
      const next = toVisit.shift()!;
      if (visited.has(next) || getDomain(next) !== domain || isStaticAsset(next)) continue;
      visited.add(next);
      batch.push(next);
    }
    if (batch.length === 0) break;

    const batchResults = await Promise.all(
      batch.map(async (url) => {
        // Politeness: space out requests to the same domain even when pages
        // are fetched in parallel batches.
        await politeDelay(domain, config.perDomainDelayMs);

        const pageStartTime = Date.now();
        coverage.pagesCrawled++;
        processedOut.add(url);

        // A5: prefer Firecrawl /scrape, fall back to got+cheerio
        let result: { text: string; html: string; links?: string[] } | null = null;
        if (fc) {
          result = await fetchPageFirecrawl(url, domain, fc, timeoutMs);
        }
        if (!result) {
          result = await fetchPageFallback(url, timeoutMs, config.maxRetries);
          if (result) coverage.fallbackPages++;
        }

        if (!result) {
          onProgress({
            type: "error", pageUrl: url, errorMessage: "Failed to fetch page",
            errorType: "fetch_failed", durationMs: Date.now() - pageStartTime,
          });
          return { event: null as CrawledEvent | null, newLinks: [] as string[] };
        }

        const { text, html } = result;

        // Discover links for BFS (only when not seeded from a sitemap)
        let newLinks: string[] = [];
        if (sitemapUrls.length === 0) {
          const rawLinks = result.links ?? extractLinksFromHtml(html, url, domain);
          newLinks = rawLinks.filter((l) => !isStaticAsset(l));
        }

        const imageUrls = config.imageReadingEnabled && html
          ? extractImageUrls(html, url)
          : undefined;

        const event = await processPage(
          url, text, html, imageUrls, config, coverage, onProgress, pageStartTime
        );

        // 3A: page_crawled after processing carries accurate timing + text length
        onProgress({
          type: "page_crawled", pageUrl: url,
          textLength: text.length, durationMs: Date.now() - pageStartTime,
        });

        return { event, newLinks };
      })
    );

    // Collect events + update early-termination counters in batch order
    for (const r of batchResults) {
      if (r.event) {
        events.push(r.event);
        consecutiveNoKeywords = 0;
        if (r.event.tier === topTierName) topTierCount++;
      } else {
        consecutiveNoKeywords++;
      }
    }

    // 1B: enqueue discovered links — event-path URLs to the FRONT, others to the BACK
    for (const r of batchResults) {
      const eventLinks = r.newLinks.filter((l) => isEventUrl(l) && !visited.has(l));
      const otherLinks = r.newLinks.filter((l) => !isEventUrl(l) && !visited.has(l));
      if (eventLinks.length > 0) toVisit.unshift(...eventLinks);
      if (otherLinks.length > 0) toVisit.push(...otherLinks);
    }

    // 2E EARLY EXIT 1: the opening pages all failed the keyword/relevance gate.
    //
    // Guarded by an event-path check: a nonprofit homepage almost always opens
    // with mission / about / donate pages that carry no fundraising keywords,
    // and bailing after five of those abandoned the site before /events or
    // /gala was ever fetched. Never give up while a known event-path URL is
    // still queued — those are the pages worth having.
    const eventPathQueued = toVisit.some((u) => isEventUrl(u) && !visited.has(u));
    if (consecutiveNoKeywords >= 3 && visited.size <= 5 && !eventPathQueued) {
      onProgress({
        type: "skipped", pageUrl: siteUrl, reason: "early_exit_no_keywords",
        errorMessage: `Early exit: ${consecutiveNoKeywords} opening pages had no keyword matches and no event-path URLs queued`,
      });
      break;
    }

    // 2E EARLY EXIT 2: already collected enough top-tier events for this site
    if (topTierCount >= 3) {
      onProgress({
        type: "skipped", pageUrl: siteUrl, reason: "early_exit_enough_top_tier",
        errorMessage: `Early exit: found ${topTierCount} ${topTierName} events`,
      });
      break;
    }
  }

  return events;
}

async function getSitemapUrls(baseUrl: string, timeoutMs: number): Promise<string[]> {
  try {
    const sitemapUrl = new URL("/sitemap.xml", baseUrl).href;
    const hostname = new URL(sitemapUrl).hostname;
    if (!(await resolveHostIsSafe(hostname))) return [];
    const response = await got(sitemapUrl, {
      timeout: { request: timeoutMs },
      hooks: ssrfRedirectHook,
    });
    const $ = cheerio.load(response.body, { xmlMode: true });
    const urls: string[] = [];
    $("url loc").each((_, el) => {
      const loc = $(el).text().trim();
      if (loc) urls.push(loc);
    });
    return urls;
  } catch {
    return [];
  }
}

function extractLinksFromHtml(html: string, baseUrl: string, domain: string): string[] {
  const $ = cheerio.load(html);
  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const normalized = normalizeUrl(baseUrl, href);
    if (normalized && getDomain(normalized) === domain) links.push(normalized);
  });
  return [...new Set(links)];
}

// ── Main exported function ─────────────────────────────────────────────────────
export async function crawlSite(
  siteUrl: string,
  config: CrawlConfig,
  onProgress: (event: CrawlProgressEvent) => void,
  isStopped?: () => boolean
): Promise<{ events: CrawledEvent[]; coverage: SiteCoverage }> {
  const domain = getDomain(siteUrl);

  const coverage: SiteCoverage = {
    siteUrl,
    pagesDiscovered: 0,
    pagesCrawled: 0,
    pagesMissed: 0,
    isComplete: true,
    missedUrls: [],
    crawlErrors: [],
    pagesKeywordMatched: 0,
    pagesSentToAi: 0,
    fallbackPages: 0,
    tokenUsage: zeroUsage(),
    imageAttempts: 0,
    imageSuccesses: 0,
    enrichmentAttempts: 0,
    enrichmentSuccesses: 0,
  };

  if (!domain) {
    onProgress({ type: "error", url: siteUrl, errorMessage: "Invalid URL — no domain" });
    return { events: [], coverage };
  }

  if (!isSafeUrl(siteUrl)) {
    onProgress({ type: "error", url: siteUrl, errorMessage: "URL rejected — non-public destination" });
    return { events: [], coverage };
  }

  const allBlacklisted = [...config.blacklistedDomains, ...DEFAULT_VENDOR_DOMAINS];
  if (allBlacklisted.some((d) => domain.includes(d))) {
    onProgress({ type: "error", url: siteUrl, errorMessage: "Domain is blacklisted (vendor/aggregator)" });
    return { events: [], coverage };
  }

  const stopped = isStopped ?? (() => false);
  const fc = getFirecrawlClient();
  const timeoutMs = config.timeoutPerPage * 1000;

  let events: CrawledEvent[];
  // Every page actually processed on this site — the input to coverage
  // reconciliation. Previously only pages that YIELDED AN EVENT were recorded,
  // so every ordinary page counted as "missed" and virtually every site
  // reported isComplete: false with a wildly inflated pagesMissed.
  const crawledUrls = new Set<string>();

  if (fc) {
    // A1: Primary path — Firecrawl /crawl endpoint
    events = await crawlSiteWithFirecrawl(siteUrl, config, fc, onProgress, coverage, stopped, crawledUrls);

    // Fall back to BFS only when the /crawl pass processed NO PAGES AT ALL
    // (job failed, blocked, or returned nothing). The old condition was
    // `events.length === 0`, but most sites legitimately have zero qualifying
    // events — so a successful crawl of a perfectly good site triggered a full
    // second BFS pass, roughly doubling Firecrawl spend and runtime per run.
    if (crawledUrls.size === 0 && !stopped()) {
      logger.info({ siteUrl }, "Firecrawl /crawl returned no pages — falling back to BFS");
      events = await crawlSiteWithBFS(siteUrl, config, fc, onProgress, coverage, stopped, crawledUrls);
    }
  } else {
    // A5: No Firecrawl API key — use BFS fallback
    events = await crawlSiteWithBFS(siteUrl, config, null, onProgress, coverage, stopped, crawledUrls);
  }

  // A3: Coverage reconciliation — compare crawled vs sitemap-discovered
  if (!stopped()) {
    try {
      const reconciled = await reconcileCoverage(siteUrl, crawledUrls, timeoutMs);
      coverage.pagesDiscovered = Math.max(reconciled.pagesDiscovered, coverage.pagesCrawled);
      coverage.missedUrls = reconciled.missedUrls.slice(0, 100); // cap stored list
      coverage.pagesMissed = reconciled.pagesMissed;
      coverage.isComplete = reconciled.isComplete;
    } catch (err) {
      logger.warn({ err, siteUrl }, "Coverage reconciliation failed — skipping");
    }
  }

  return { events: deduplicateEvents(events), coverage };
}
