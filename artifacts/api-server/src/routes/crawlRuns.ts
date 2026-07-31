import { Router } from "express";
import { db } from "@workspace/db";
import {
  crawlRunsTable,
  eventsTable,
  urlListsTable,
  urlListItemsTable,
  adminSettingsTable,
  domainBlacklistTable,
  runSiteCoverageTable,
  organizationsTable,
} from "@workspace/db";
import { eq, sql, and, ne } from "drizzle-orm";
import { GetCrawlRunParams, GetCrawlRunsQueryParams } from "@workspace/api-zod";
import { crawlSite } from "../services/crawler";
import type { CrawlProgressEvent, CrawledEvent } from "../services/crawler";
import { preflightForRun } from "../services/preflight";
import { classifyEvents } from "../services/dedupe";
import type { ClassifiedEvent } from "../services/dedupe";
import { normalizeDomain } from "../services/orgImport";
import { scoreEventWithBreakdown, DEFAULT_TIERS } from "../services/scorer";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, zeroUsage, addUsage } from "../services/extractor";
import type { TokenUsage } from "../services/extractor";
import { logger } from "../lib/logger";
import { requireAdmin } from "../middleware/auth";
import { isSafeUrl } from "../utils/ssrf";

const router = Router();

// SSE progress map: runId -> set of response writers
const progressListeners = new Map<number, Set<(event: CrawlProgressEvent) => void>>();

// In-memory log buffer: runId -> log entries
type LogEntry = {
  ts: string;
  type: string;
  url?: string;
  msg: string;
  score?: number;
  durationMs?: number;
  errorType?: string;
  reason?: string;
  textLength?: number;
  eventData?: CrawledEvent;
};
const logBuffers = new Map<number, LogEntry[]>();

// Stop signal: runIds that have been asked to stop
const stoppedRuns = new Set<number>();

// Pause signal: runIds that have been asked to pause (resumable later)
const pausedRuns = new Set<number>();

export function emitProgress(runId: number, event: CrawlProgressEvent): void {
  const listeners = progressListeners.get(runId);
  if (listeners) {
    for (const fn of listeners) fn(event);
  }
}

function toLogEntry(event: CrawlProgressEvent): LogEntry {
  const ts = new Date().toISOString();
  switch (event.type) {
    case "url_start":
      return { ts, type: event.type, url: event.url, msg: event.url ? `Starting crawl of ${event.url}` : "Crawl run started" };
    case "page_crawled":
      return {
        ts, type: event.type, url: event.pageUrl,
        msg: `Crawled page: ${event.pageUrl ?? ""}${event.durationMs != null ? ` (${event.durationMs}ms)` : ""}`,
        durationMs: event.durationMs, textLength: event.textLength,
      };
    case "event_found":
      return {
        ts, type: event.type, url: event.pageUrl,
        msg: `Found event: "${event.eventName ?? "Unknown"}"`,
        score: event.score, durationMs: event.durationMs, eventData: event.eventData,
      };
    case "skipped":
      return {
        ts, type: event.type, url: event.pageUrl,
        msg: `Skipped ${event.pageUrl ?? ""} (${event.reason ?? "unknown"})`,
        reason: event.reason, durationMs: event.durationMs,
      };
    case "error":
      return {
        ts, type: event.type, url: event.url ?? event.pageUrl,
        msg: `Error on ${event.url ?? event.pageUrl ?? "unknown"}: ${event.errorMessage ?? ""}`,
        errorType: event.errorType, durationMs: event.durationMs,
      };
    case "url_done":
      return { ts, type: event.type, url: event.url, msg: `Finished: ${event.url}` };
    case "complete":
      return { ts, type: event.type, msg: "Crawl run complete" };
    default:
      return { ts, type: event.type, msg: JSON.stringify(event) };
  }
}

const FLUSH_INTERVAL_MS = 5_000;

// Insert events in chunks instead of one giant statement
const INSERT_BATCH_SIZE = 50;

function toInsertRow(runId: number, classified: ClassifiedEvent, organizationId: number | null = null) {
  const { event, dedupeKey, contentHash, verdict } = classified;
  return {
    runId,
    organizationId,
    score: event.score,
    tier: event.tier,
    status: (verdict === "UPDATED" ? "UPDATED" : "NEW") as "NEW" | "UPDATED",
    eventName: event.eventName,
    eventDate: event.eventDate,
    eventVenue: event.eventVenue,
    eventAddress: event.eventAddress,
    eventDescription: event.eventDescription,
    auctionType: event.auctionType,
    hasSilentAuction: event.hasSilentAuction,
    hasLiveAuction: event.hasLiveAuction,
    hasOnlineAuction: event.hasOnlineAuction,
    hasRaffle: event.hasRaffle,
    hasDonationRequest: event.hasDonationRequest,
    ticketPrice: event.ticketPrice?.toString(),
    tablePrice: event.tablePrice?.toString(),
    formality: event.formality,
    rsvpLink: event.rsvpLink,
    contactTitle: event.contactTitle,
    contactFirstName: event.contactFirstName,
    contactLastName: event.contactLastName,
    contactName: event.contactName,
    contactEmail: event.contactEmail,
    contactPhone: event.contactPhone,
    eventPageUrl: event.eventPageUrl,
    audienceNote: event.audienceNote,
    sponsorshipMentioned: event.sponsorshipMentioned,
    orgName: event.orgName,
    orgAddress: event.orgAddress,
    orgCity: event.orgCity,
    orgState: event.orgState,
    orgZip: event.orgZip,
    orgPhone: event.orgPhone,
    orgEmail: event.orgEmail,
    orgWebsite: event.orgWebsite,
    isPast: event.isPast,
    errorMessage: event.errorMessage,
    dedupeKey,
    contentHash,
  };
}

/**
 * Look up the GuideStar organization whose website matches a crawled site URL.
 * Results are memoised per run-batch since a whole site resolves to one org.
 */
const orgIdCache = new Map<string, number | null>();
async function resolveOrganizationId(siteUrl: string): Promise<number | null> {
  const host = normalizeDomain(siteUrl);
  if (!host) return null;
  if (orgIdCache.has(host)) return orgIdCache.get(host)!;

  let orgId: number | null = null;
  try {
    const [hit] = await db
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.domain, host))
      .limit(1);
    orgId = hit?.id ?? null;
  } catch (err) {
    logger.warn({ err, host }, "Organization lookup failed — event will export without org data");
  }

  // Bound the cache so a 5,000-site run cannot grow it without limit.
  if (orgIdCache.size > 10_000) orgIdCache.clear();
  orgIdCache.set(host, orgId);
  return orgId;
}

/**
 * Marks runs left in "running"/"pending" by a previous process (crash/restart)
 * as "paused" so they can be resumed instead of appearing stuck forever.
 * Called once on server boot.
 */
export async function recoverInterruptedRuns(): Promise<void> {
  const recovered = await db
    .update(crawlRunsTable)
    .set({ status: "paused" })
    .where(sql`${crawlRunsTable.status} in ('running', 'pending')`)
    .returning({ id: crawlRunsTable.id });
  if (recovered.length > 0) {
    logger.warn({ runIds: recovered.map((r) => r.id) }, "Marked interrupted runs as paused (resumable)");
  }
}

export async function startCrawlRun(
  runId: number,
  urls: string[],
  triggeredBy: "manual" | "scheduled",
  opts: { resume?: boolean; preflightWarnings?: string[] } = {}
): Promise<void> {
  stoppedRuns.delete(runId);
  pausedRuns.delete(runId);

  // Guard: refuse to start if AI is not configured — a run without AI silently
  // falls back to regex-only extraction and produces near-zero useful events.
  if (!getAnthropicClient()) {
    await db
      .update(crawlRunsTable)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(crawlRunsTable.id, runId));
    logger.error({ runId }, "Run aborted: ANTHROPIC_API_KEY is not set");
    return;
  }

  let pagesCrawled = 0;
  let eventsMatched = 0;
  let errorCount = 0;
  // Cross-run dedupe counters
  let newCount = 0;
  let updatedCount = 0;
  let duplicateCount = 0;
  const completedUrls: string[] = [];
  // Coverage aggregate counters
  let pagesDiscovered = 0;
  let pagesMissed = 0;
  let pagesKeywordMatched = 0;
  let pagesSentToAi = 0;
  let fallbackPages = 0;
  let sitesComplete = 0;
  let sitesIncomplete = 0;
  let skippedByGeography = 0;
  // AI token usage accumulated across all sites
  let tokenUsage: TokenUsage = zeroUsage();
  // Subsystem health counters (for WARN after run)
  let totalImageAttempts = 0;
  let totalImageSuccesses = 0;
  let totalEnrichmentAttempts = 0;
  let totalEnrichmentSuccesses = 0;

  if (opts.resume) {
    // Carry prior progress forward so counters and the activity log continue
    // where the paused run left off.
    const [prior] = await db.select().from(crawlRunsTable).where(eq(crawlRunsTable.id, runId));
    if (prior) {
      pagesCrawled = prior.pagesCrawled;
      eventsMatched = prior.eventsMatched;
      errorCount = prior.errorCount;
      newCount = prior.newCount;
      updatedCount = prior.updatedCount;
      duplicateCount = prior.duplicateCount;
      completedUrls.push(...((prior.completedUrls as string[]) ?? []));
      pagesDiscovered = prior.pagesDiscovered;
      pagesMissed = prior.pagesMissed;
      pagesKeywordMatched = prior.pagesKeywordMatched;
      pagesSentToAi = prior.pagesSentToAi;
      fallbackPages = prior.fallbackPages;
      sitesComplete = prior.sitesComplete;
      sitesIncomplete = prior.sitesIncomplete;
      skippedByGeography = prior.skippedByGeography ?? 0;
      tokenUsage = (prior.tokenUsage as TokenUsage | null) ?? zeroUsage();
      logBuffers.set(runId, [...((prior.debugLog as LogEntry[]) ?? [])]);
    } else {
      logBuffers.set(runId, []);
    }
  } else {
    logBuffers.set(runId, []);
  }

  // Inject preflight warnings as the first log entries so they appear
  // at the top of the Activity Log before any page is crawled.
  if (!opts.resume && opts.preflightWarnings?.length) {
    for (const warn of opts.preflightWarnings) {
      logBuffers.get(runId)?.push({ ts: new Date().toISOString(), type: "warn", msg: warn });
    }
  }

  const doneOffset = completedUrls.length;
  const total = doneOffset + urls.length;
  let done = doneOffset;

  const appendLog = (entry: LogEntry) => {
    logBuffers.get(runId)?.push(entry);
  };

  const flushToDb = () =>
    db
      .update(crawlRunsTable)
      .set({
        pagesCrawled, eventsMatched, errorCount,
        newCount, updatedCount, duplicateCount,
        completedUrls, debugLog: logBuffers.get(runId) ?? [],
        pagesDiscovered, pagesMissed, pagesKeywordMatched, pagesSentToAi,
        fallbackPages, sitesComplete, sitesIncomplete, skippedByGeography,
        tokenUsage,
      })
      .where(eq(crawlRunsTable.id, runId));

  const flushTimer = setInterval(() => {
    flushToDb().catch((err) => logger.warn({ err, runId }, "Periodic log flush failed"));
  }, FLUSH_INTERVAL_MS);

  const finalize = async (status: "completed" | "stopped" | "paused" | "failed") => {
    clearInterval(flushTimer);
    const finalLog = logBuffers.get(runId) ?? [];
    await db
      .update(crawlRunsTable)
      .set({
        status,
        completedAt: status === "paused" ? null : new Date(),
        pagesCrawled, eventsMatched, errorCount,
        newCount, updatedCount, duplicateCount,
        completedUrls, debugLog: finalLog,
        pagesDiscovered, pagesMissed, pagesKeywordMatched, pagesSentToAi,
        fallbackPages, sitesComplete, sitesIncomplete, skippedByGeography,
        tokenUsage,
      })
      .where(eq(crawlRunsTable.id, runId));
    progressListeners.delete(runId);
    logBuffers.delete(runId);
    stoppedRuns.delete(runId);
    pausedRuns.delete(runId);
    logger.info(
      { runId, triggeredBy, status, pagesCrawled, eventsMatched, newCount, updatedCount, duplicateCount, errorCount },
      "Crawl run finished"
    );
  };

  try {
    // On a fresh start, persist the exact seed set so resume can compute the
    // remaining URLs even for subset runs (e.g. retry-urls). On resume, keep
    // the original seed set intact.
    await db
      .update(crawlRunsTable)
      .set({ status: "running", ...(opts.resume ? {} : { seedUrls: urls }) })
      .where(eq(crawlRunsTable.id, runId));

    const startEntry = toLogEntry({ type: "url_start", progress: { done, total } });
    appendLog(startEntry);
    emitProgress(runId, { type: "url_start", progress: { done, total } });

    const [settings] = await db.select().from(adminSettingsTable).limit(1);
    const blacklist = await db.select({ domain: domainBlacklistTable.domain }).from(domainBlacklistTable);

    const config = {
      maxPagesPerSite: settings?.maxPagesPerSite ?? 30,
      timeoutPerPage: settings?.timeoutPerPage ?? 30,
      imageReadingEnabled: settings?.imageReadingEnabled ?? true,
      searchKeywords: (settings?.searchKeywords as string[]) ?? ["silent auction", "gala", "fundraiser"],
      avoidKeywords: (settings?.avoidKeywords as string[]) ?? [],
      overrideKeywords: (settings?.overrideKeywords as string[]) ?? ["silent auction"],
      blacklistedDomains: blacklist.map((b) => b.domain),
      scoringWeights: (settings?.scoringWeights as any) ?? {},
      // Guard the shape, not just null: `tiers` previously held an object and a
      // schema/DB drift regressed it once already. A non-array here makes every
      // [...tiers].sort() in the scorer throw and fails the entire run.
      tiers: Array.isArray(settings?.tiers) && settings.tiers.length > 0
        ? (settings.tiers as any)
        : DEFAULT_TIERS,
      geographicStates: Array.isArray(settings?.geographicStates)
        ? (settings.geographicStates as string[])
        : [],
      perDomainDelayMs: settings?.perDomainDelayMs ?? 1000,
      maxRetries: settings?.maxRetries ?? 3,
    };
    const maxConcurrentSites = Math.max(1, settings?.maxConcurrentSites ?? 5);
    const minEventScore = settings?.minEventScore ?? 1;

    // ── Worker pool over seed URLs ────────────────────────────────────────────
    // Each worker pulls the next un-crawled site off the shared cursor. A
    // failure on one site only affects that site; pause/stop signals are
    // checked before each new site is started (in-flight sites finish and
    // their results are saved).
    let cursor = 0;

    const processSite = async (url: string) => {
      const startEvt: CrawlProgressEvent = { type: "url_start", url, progress: { done, total } };
      appendLog(toLogEntry(startEvt));
      emitProgress(runId, startEvt);

      try {
        const { events, coverage } = await crawlSite(url, config, (ev) => {
          if (ev.type === "page_crawled") pagesCrawled++;
          if (ev.type === "error") errorCount++;
          if (ev.type === "skipped" && ev.reason === "out_of_geography") skippedByGeography++;
          appendLog(toLogEntry(ev));
          emitProgress(runId, ev);
        }, () => stoppedRuns.has(runId));

        // Aggregate coverage counters
        pagesDiscovered += coverage.pagesDiscovered;
        pagesMissed += coverage.pagesMissed;
        pagesKeywordMatched += coverage.pagesKeywordMatched;
        pagesSentToAi += coverage.pagesSentToAi;
        fallbackPages += coverage.fallbackPages;
        if (coverage.isComplete) sitesComplete++;
        else sitesIncomplete++;
        tokenUsage = addUsage(tokenUsage, coverage.tokenUsage);
        // Subsystem health counters
        totalImageAttempts += coverage.imageAttempts;
        totalImageSuccesses += coverage.imageSuccesses;
        totalEnrichmentAttempts += coverage.enrichmentAttempts;
        totalEnrichmentSuccesses += coverage.enrichmentSuccesses;

        // Persist per-site coverage record
        await db.insert(runSiteCoverageTable).values({
          runId,
          siteUrl: url,
          pagesDiscovered: coverage.pagesDiscovered,
          pagesCrawled: coverage.pagesCrawled,
          pagesMissed: coverage.pagesMissed,
          isComplete: coverage.isComplete,
          missedUrls: coverage.missedUrls,
          crawlErrors: coverage.crawlErrors,
        });

        // Cross-run dedupe: skip exact duplicates, flag changed events as
        // UPDATED, insert genuinely new finds as NEW.
        const classified = await classifyEvents(events);
        const toInsert = classified.filter(
          (c) => c.verdict !== "DUPLICATE" && (c.event.score ?? 0) >= minEventScore
        );

        for (const c of classified) {
          if (c.verdict === "DUPLICATE") {
            duplicateCount++;
            appendLog({
              ts: new Date().toISOString(), type: "dedupe", url: c.event.eventPageUrl,
              msg: `Skipped duplicate: "${c.event.eventName ?? c.event.eventPageUrl}" (already in database)`,
            });
          } else if (c.verdict === "UPDATED") {
            updatedCount++;
            appendLog({
              ts: new Date().toISOString(), type: "dedupe", url: c.event.eventPageUrl,
              msg: `Updated event: "${c.event.eventName ?? c.event.eventPageUrl}" (details changed since last crawl)`,
            });
          } else {
            newCount++;
            appendLog({
              ts: new Date().toISOString(), type: "dedupe", url: c.event.eventPageUrl,
              msg: `NEW find: "${c.event.eventName ?? c.event.eventPageUrl}"`, score: c.event.score,
            });
          }
        }

        // Resolve the GuideStar organization for this site once, by domain, so
        // the CRM export can join scraped event detail to authoritative org
        // detail (EIN, legal name, registered mailing address).
        const orgId = await resolveOrganizationId(url);

        // Batch insert in chunks
        for (let i = 0; i < toInsert.length; i += INSERT_BATCH_SIZE) {
          const chunk = toInsert.slice(i, i + INSERT_BATCH_SIZE);
          await db.insert(eventsTable).values(chunk.map((c) => toInsertRow(runId, c, orgId)));
          eventsMatched += chunk.length;
        }
      } catch (err) {
        errorCount++;
        logger.error({ err, url, runId }, "Crawl site error");
        const errEvt: CrawlProgressEvent = { type: "error", url, errorMessage: String(err) };
        appendLog(toLogEntry(errEvt));
        emitProgress(runId, errEvt);
      }

      completedUrls.push(url);
      done++;
      const doneEvt: CrawlProgressEvent = { type: "url_done", url, progress: { done, total } };
      appendLog(toLogEntry(doneEvt));
      emitProgress(runId, doneEvt);

      // Flush counters + log buffer to DB after each site so a crash or
      // restart can resume from the last completed site.
      await flushToDb().catch((err) => logger.warn({ err, runId }, "Post-site flush failed"));
    };

    const worker = async () => {
      while (true) {
        if (stoppedRuns.has(runId) || pausedRuns.has(runId)) return;
        const index = cursor++;
        if (index >= urls.length) return;
        await processSite(urls[index]);
      }
    };

    await Promise.all(Array.from({ length: Math.min(maxConcurrentSites, Math.max(1, urls.length)) }, worker));

    // Emit subsystem WARNs if a subsystem was enabled but every fetch failed
    if (config.imageReadingEnabled && totalImageAttempts > 0 && totalImageSuccesses === 0) {
      const warnMsg = `WARN: imageReadingEnabled=true but 0 of ${totalImageAttempts} image fetch(es) succeeded — SSRF guard may be blocking or image URLs are inaccessible`;
      appendLog({ ts: new Date().toISOString(), type: "warn", msg: warnMsg });
      logger.warn({ runId, totalImageAttempts }, "Image reading enabled but all image fetches failed");
    }
    if (totalEnrichmentAttempts > 0 && totalEnrichmentSuccesses === 0) {
      const warnMsg = `WARN: ${totalEnrichmentAttempts} ticket-platform enrichment link(s) found but 0 enrichment(s) returned any fields — platform pages may be blocking the crawler`;
      appendLog({ ts: new Date().toISOString(), type: "warn", msg: warnMsg });
      logger.warn({ runId, totalEnrichmentAttempts }, "Enrichment links found but all enrichment attempts failed");
    }

    if (stoppedRuns.has(runId)) {
      appendLog({ ts: new Date().toISOString(), type: "error", msg: "Run stopped by user" });
      emitProgress(runId, { type: "complete", progress: { done, total } });
      await finalize("stopped");
      return;
    }

    if (pausedRuns.has(runId)) {
      appendLog({ ts: new Date().toISOString(), type: "url_done", msg: `Run paused by user (${done}/${total} sites done — resumable)` });
      emitProgress(runId, { type: "complete", progress: { done, total } });
      await finalize("paused");
      return;
    }

    const completeEvt: CrawlProgressEvent = { type: "complete", progress: { done, total } };
    appendLog(toLogEntry(completeEvt));
    emitProgress(runId, completeEvt);
    await finalize("completed");
  } catch (err) {
    logger.error({ err, runId }, "Crawl run failed");
    appendLog({ ts: new Date().toISOString(), type: "error", msg: `Run failed: ${String(err)}` });
    await finalize("failed");
  }
}

function serializeRun(run: typeof crawlRunsTable.$inferSelect, listName: string, topScore?: number | null) {
  return {
    id: run.id,
    urlListId: run.urlListId,
    urlListName: listName,
    status: run.status,
    triggeredBy: run.triggeredBy,
    totalUrls: run.totalUrls,
    pagesCrawled: run.pagesCrawled,
    eventsMatched: run.eventsMatched,
    errorCount: run.errorCount,
    newCount: run.newCount,
    updatedCount: run.updatedCount,
    duplicateCount: run.duplicateCount,
    archived: run.archived,
    topScore: topScore ?? null,
    // Coverage metrics
    pagesDiscovered: run.pagesDiscovered,
    pagesMissed: run.pagesMissed,
    pagesKeywordMatched: run.pagesKeywordMatched,
    pagesSentToAi: run.pagesSentToAi,
    fallbackPages: run.fallbackPages,
    sitesComplete: run.sitesComplete,
    sitesIncomplete: run.sitesIncomplete,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    // AI token usage
    tokenUsage: run.tokenUsage as {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    } | null,
  };
}

// GET /crawl-runs
router.get("/crawl-runs", async (req, res) => {
  const parsed = GetCrawlRunsQueryParams.safeParse(req.query);
  const urlListId = parsed.success ? parsed.data.urlListId : undefined;
  const includeArchived = req.query.includeArchived === "true" || req.query.includeArchived === "1";

  const conditions = [];
  if (urlListId) conditions.push(eq(crawlRunsTable.urlListId, Number(urlListId)));
  if (!includeArchived) conditions.push(eq(crawlRunsTable.archived, false));

  const baseQuery = db
    .select({
      run: crawlRunsTable,
      listName: urlListsTable.name,
      topScore: sql<number | null>`max(${eventsTable.score})`,
    })
    .from(crawlRunsTable)
    .innerJoin(urlListsTable, eq(crawlRunsTable.urlListId, urlListsTable.id))
    .leftJoin(eventsTable, eq(eventsTable.runId, crawlRunsTable.id))
    .groupBy(crawlRunsTable.id, urlListsTable.name)
    .$dynamic();

  const rows = conditions.length > 0
    ? await baseQuery.where(conditions.length === 1 ? conditions[0] : and(...conditions)).orderBy(sql`${crawlRunsTable.createdAt} desc`)
    : await baseQuery.orderBy(sql`${crawlRunsTable.createdAt} desc`);

  res.json(rows.map(({ run, listName, topScore }) => serializeRun(run, listName, topScore)));
});

// GET /crawl-runs/:id
router.get("/crawl-runs/:id", async (req, res) => {
  const parsed = GetCrawlRunParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .select({ run: crawlRunsTable, listName: urlListsTable.name })
    .from(crawlRunsTable)
    .innerJoin(urlListsTable, eq(crawlRunsTable.urlListId, urlListsTable.id))
    .where(eq(crawlRunsTable.id, parsed.data.id));

  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const topEvents = await db
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.runId, parsed.data.id))
    .orderBy(sql`${eventsTable.score} desc`)
    .limit(3);

  res.json({
    ...serializeRun(row.run, row.listName),
    topEvents: topEvents.map(serializeEvent),
  });
});

// PATCH /crawl-runs/:id — archive/unarchive
router.patch("/crawl-runs/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const { archived } = req.body as { archived?: boolean };
  if (typeof archived !== "boolean") {
    res.status(400).json({ error: "archived (boolean) required" });
    return;
  }

  const [row] = await db
    .update(crawlRunsTable)
    .set({ archived })
    .where(eq(crawlRunsTable.id, id))
    .returning();

  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const [listRow] = await db
    .select({ name: urlListsTable.name })
    .from(urlListsTable)
    .where(eq(urlListsTable.id, row.urlListId));

  res.json(serializeRun(row, listRow?.name ?? ""));
});

// DELETE /crawl-runs/:id
router.delete("/crawl-runs/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  await db.delete(crawlRunsTable).where(eq(crawlRunsTable.id, id));
  res.status(204).send();
});

// POST /crawl-runs/:id/stop
router.post("/crawl-runs/:id/stop", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .select({ status: crawlRunsTable.status })
    .from(crawlRunsTable)
    .where(eq(crawlRunsTable.id, id));

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (row.status !== "running" && row.status !== "pending") {
    res.status(400).json({ error: "Run is not active" });
    return;
  }

  stoppedRuns.add(id);

  // Also immediately mark as stopped in DB so stuck runs (where the server
  // restarted and the crawl loop is gone) are immediately reflected as stopped.
  await db
    .update(crawlRunsTable)
    .set({ status: "stopped", completedAt: new Date() })
    .where(eq(crawlRunsTable.id, id));

  // If the crawl loop is alive in this process it will notice the stop signal
  // and clean up (finalize) itself — deleting the buffer here would wipe the
  // persisted log. Only clean up when the loop is gone (previous process).
  if (!logBuffers.has(id)) {
    progressListeners.delete(id);
    stoppedRuns.delete(id);
  }

  res.json({ message: "Stop signal sent" });
});

// POST /crawl-runs/:id/pause — cooperative pause; in-flight sites finish, then
// the run halts with its queue position saved so it can be resumed later.
router.post("/crawl-runs/:id/pause", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .select({ status: crawlRunsTable.status })
    .from(crawlRunsTable)
    .where(eq(crawlRunsTable.id, id));

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  if (row.status !== "running" && row.status !== "pending") {
    res.status(400).json({ error: "Run is not active" });
    return;
  }

  pausedRuns.add(id);
  // Reflect immediately in DB so a restarted server (where the crawl loop is
  // gone) still shows the run as paused/resumable.
  await db.update(crawlRunsTable).set({ status: "paused" }).where(eq(crawlRunsTable.id, id));

  res.json({ message: "Pause signal sent — in-flight sites will finish first" });
});

// POST /crawl-runs/:id/resume — continue a paused run from where it left off
router.post("/crawl-runs/:id/resume", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [run] = await db.select().from(crawlRunsTable).where(eq(crawlRunsTable.id, id));
  if (!run) { res.status(404).json({ error: "Not found" }); return; }
  if (run.status !== "paused") {
    res.status(400).json({ error: "Only paused runs can be resumed" });
    return;
  }

  // The crawl loop is still winding down in this process (in-flight sites
  // finishing after a pause). Starting a second loop for the same run would
  // double-crawl URLs and corrupt counters — ask the caller to retry shortly.
  if (logBuffers.has(id)) {
    res.status(409).json({ error: "Run is still finishing in-flight sites — try again in a moment" });
    return;
  }

  // Resume from the run's own seed set (retry-runs use a subset of the list).
  // Fall back to the full URL list only for legacy rows without seedUrls.
  let seedUrls = (run.seedUrls as string[]) ?? [];
  if (seedUrls.length === 0) {
    const urlItems = await db
      .select({ url: urlListItemsTable.url })
      .from(urlListItemsTable)
      .where(eq(urlListItemsTable.urlListId, run.urlListId));
    seedUrls = urlItems.map((r) => r.url);
  }

  const alreadyDone = new Set((run.completedUrls as string[]) ?? []);
  const remaining = seedUrls.filter((u) => !alreadyDone.has(u));

  const resumePreflight = await preflightForRun(remaining.length > 0 ? remaining : seedUrls);
  if (resumePreflight.fatal) {
    res.status(400).json({ error: resumePreflight.fatal });
    return;
  }

  await db.update(crawlRunsTable).set({ status: "running" }).where(eq(crawlRunsTable.id, id));

  // Fire and forget
  startCrawlRun(id, remaining, run.triggeredBy, { resume: true }).catch((err) =>
    req.log.error({ err, runId: id }, "Resumed run failed")
  );

  const [listRow] = await db
    .select({ name: urlListsTable.name })
    .from(urlListsTable)
    .where(eq(urlListsTable.id, run.urlListId));

  res.status(202).json(serializeRun({ ...run, status: "running" }, listRow?.name ?? ""));
});

// POST /crawl-runs/:id/rerun
router.post("/crawl-runs/:id/rerun", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [existingRun] = await db
    .select()
    .from(crawlRunsTable)
    .where(eq(crawlRunsTable.id, id));

  if (!existingRun) { res.status(404).json({ error: "Not found" }); return; }

  const urlListId = existingRun.urlListId;

  const urlItems = await db
    .select({ url: sql<string>`url` })
    .from(sql`url_list_items`)
    .where(sql`url_list_id = ${urlListId}`);

  const urls = urlItems.map((r) => r.url);

  const preflight = await preflightForRun(urls);
  if (preflight.fatal) {
    res.status(400).json({ error: preflight.fatal });
    return;
  }

  const [newRun] = await db
    .insert(crawlRunsTable)
    .values({
      urlListId,
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
    .where(eq(urlListsTable.id, urlListId));

  startCrawlRun(newRun.id, urls, "manual", { preflightWarnings: preflight.warnings }).catch((err) =>
    logger.error({ err, runId: newRun.id }, "Re-run failed")
  );

  res.status(202).json(serializeRun(newRun, listRow?.name ?? ""));
});

// 3C: POST /crawl-runs/:id/analyze-errors — LLM diagnostics over the error log
router.post("/crawl-runs/:id/analyze-errors", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db
    .select({
      debugLog: crawlRunsTable.debugLog,
      totalUrls: crawlRunsTable.totalUrls,
      pagesCrawled: crawlRunsTable.pagesCrawled,
      eventsMatched: crawlRunsTable.eventsMatched,
      errorCount: crawlRunsTable.errorCount,
    })
    .from(crawlRunsTable)
    .where(eq(crawlRunsTable.id, id));

  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  const client = getAnthropicClient();
  if (!client) {
    res.status(503).json({ error: "AI not configured" });
    return;
  }

  const log = (row.debugLog ?? []) as LogEntry[];
  const errors = log.filter((e) => e.type === "error" || e.type === "skipped");

  // Group errors by type/reason
  const errorsByType = new Map<string, { count: number; sampleUrls: string[] }>();
  for (const e of errors) {
    const type = e.errorType || e.reason || "unknown";
    if (!errorsByType.has(type)) errorsByType.set(type, { count: 0, sampleUrls: [] });
    const group = errorsByType.get(type)!;
    group.count++;
    if (group.sampleUrls.length < 5 && e.url) group.sampleUrls.push(e.url);
  }

  // Group errors by domain
  const domainErrors = new Map<string, number>();
  for (const e of errors) {
    if (!e.url) continue;
    try {
      const domain = new URL(e.url).hostname;
      domainErrors.set(domain, (domainErrors.get(domain) ?? 0) + 1);
    } catch {}
  }

  const [settings] = await db.select().from(adminSettingsTable).limit(1);

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

  try {
    const response = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 2000,
      system: [{ type: "text", text: "You are a web scraping diagnostics expert. Analyze error logs and provide actionable suggestions. Return only valid JSON.", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: analysisPrompt }],
    });

    if (response.stop_reason === "refusal") {
      res.status(502).json({ error: "AI analysis refused" });
      return;
    }
    const raw = response.content.find((b) => b.type === "text")?.text;
    const analysis = JSON.parse(raw || "{}");
    res.json(analysis);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      req.log.warn({ runId: id }, "AI analysis rate limited");
      res.status(429).json({ error: "AI rate limited — try again shortly" });
    } else if (err instanceof Anthropic.AuthenticationError) {
      req.log.error({ runId: id }, "AI authentication failed — check ANTHROPIC_API_KEY");
      res.status(503).json({ error: "AI authentication failed — check ANTHROPIC_API_KEY" });
    } else {
      req.log.error({ err, runId: id }, "Error analysis failed");
      res.status(502).json({ error: "AI analysis failed" });
    }
  }
});

// 3D: POST /crawl-runs/:id/retry-urls — start a new run with only the given URLs
router.post("/crawl-runs/:id/retry-urls", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { urls } = (req.body ?? {}) as { urls?: unknown };

  if (!id || !Array.isArray(urls) || urls.length === 0) {
    res.status(400).json({ error: "Invalid id or urls array" });
    return;
  }

  const retryUrls = urls.filter((u): u is string => typeof u === "string" && u.length > 0);
  if (retryUrls.length === 0) {
    res.status(400).json({ error: "Invalid id or urls array" });
    return;
  }

  const invalidUrls = retryUrls.filter((u) => !isSafeUrl(u));
  if (invalidUrls.length > 0) {
    res.status(400).json({ error: "One or more URLs are not valid public HTTP/HTTPS addresses", invalidUrls });
    return;
  }

  const retryPreflight = await preflightForRun(retryUrls);
  if (retryPreflight.fatal) {
    res.status(400).json({ error: retryPreflight.fatal });
    return;
  }

  const [originalRun] = await db
    .select({ urlListId: crawlRunsTable.urlListId })
    .from(crawlRunsTable)
    .where(eq(crawlRunsTable.id, id));

  if (!originalRun) { res.status(404).json({ error: "Not found" }); return; }

  const [newRun] = await db
    .insert(crawlRunsTable)
    .values({
      urlListId: originalRun.urlListId,
      status: "pending",
      triggeredBy: "manual",
      totalUrls: retryUrls.length,
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

  startCrawlRun(newRun.id, retryUrls, "manual", { preflightWarnings: retryPreflight.warnings }).catch((err) =>
    logger.error({ err, runId: newRun.id }, "Retry run failed")
  );

  res.status(202).json(serializeRun(newRun, listRow?.name ?? ""));
});

// GET /crawl-runs/:id/audit — funnel + drop-off histogram + config snapshot (admin-only)
router.get("/crawl-runs/:id/audit", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [row] = await db.select().from(crawlRunsTable).where(eq(crawlRunsTable.id, id));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  // Prefer in-memory buffer if the run is still active
  const log = (logBuffers.has(id) ? logBuffers.get(id) : (row.debugLog ?? [])) as LogEntry[];

  // Funnel — counts at each stage
  const eventsExtracted = log.filter((e) => e.type === "event_found").length;
  const funnel = {
    sitesAttempted: row.totalUrls,
    pagesDiscovered: row.pagesDiscovered,
    pagesCrawled: row.pagesCrawled,
    pagesKeywordMatched: row.pagesKeywordMatched,
    pagesSentToAi: row.pagesSentToAi,
    eventsExtracted,
    eventsStored: row.eventsMatched,
  };

  // Drop-offs — group skipped log entries by reason + synthetic counters
  const reasonCounts: Record<string, number> = {};
  for (const e of log) {
    if (e.type !== "skipped") continue;
    const key = e.reason ?? "unknown";
    reasonCounts[key] = (reasonCounts[key] ?? 0) + 1;
  }
  // Approximate below-min-score count (events found but not stored or deduped)
  const belowMinScore = Math.max(
    0,
    eventsExtracted - row.newCount - row.updatedCount - row.duplicateCount
  );
  const dropOffs: Record<string, number> = {
    ...reasonCounts,
    below_min_score: belowMinScore,
    duplicate: row.duplicateCount,
    fetch_failed: row.errorCount,
  };

  // Config snapshot
  const [settings] = await db.select().from(adminSettingsTable).limit(1);
  const config = {
    aiConfigured: !!process.env.ANTHROPIC_API_KEY,
    firecrawlConfigured: !!process.env.FIRECRAWL_API_KEY,
    avoidKeywords: (settings?.avoidKeywords as string[] | null) ?? [],
    geographicStates: (settings?.geographicStates as string[] | null) ?? [],
    minEventScore: settings?.minEventScore ?? 1,
    imageReadingEnabled: settings?.imageReadingEnabled ?? true,
  };

  // Warnings collected during the run
  const warnings = log.filter((e) => e.type === "warn").map((e) => e.msg);

  res.json({ funnel, dropOffs, config, warnings });
});

// GET /crawl-runs/:id/logs
router.get("/crawl-runs/:id/logs", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  if (logBuffers.has(id)) {
    res.json(logBuffers.get(id) ?? []);
    return;
  }

  const [row] = await db
    .select({ debugLog: crawlRunsTable.debugLog })
    .from(crawlRunsTable)
    .where(eq(crawlRunsTable.id, id));

  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row.debugLog ?? []);
});

// GET /crawl-runs/:id/events
router.get("/crawl-runs/:id/events", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const includePast = req.query.includePast === "true";
  const events = await db
    .select()
    .from(eventsTable)
    .where(includePast
      ? eq(eventsTable.runId, id)
      : and(eq(eventsTable.runId, id), ne(eventsTable.isPast, true)))
    .orderBy(sql`${eventsTable.score} desc`);
  res.json(events.map(serializeEvent));
});

// GET /crawl-runs/:id/coverage — per-site coverage breakdown
router.get("/crawl-runs/:id/coverage", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const rows = await db
    .select()
    .from(runSiteCoverageTable)
    .where(eq(runSiteCoverageTable.runId, id))
    .orderBy(sql`${runSiteCoverageTable.id} asc`);

  res.json(rows.map((r) => ({
    id: r.id,
    siteUrl: r.siteUrl,
    pagesDiscovered: r.pagesDiscovered,
    pagesCrawled: r.pagesCrawled,
    pagesMissed: r.pagesMissed,
    isComplete: r.isComplete,
    missedUrls: r.missedUrls ?? [],
    crawlErrors: r.crawlErrors ?? [],
    createdAt: r.createdAt.toISOString(),
  })));
});

// GET /events/:id/score-breakdown
router.get("/events/:id/score-breakdown", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, id));
  if (!event) { res.status(404).json({ error: "Not found" }); return; }

  const [settings] = await db.select().from(adminSettingsTable).limit(1);
  const weights = (settings?.scoringWeights as Record<string, number> | null | undefined) ?? {};
  const tiers = (settings?.tiers as any[]) ?? DEFAULT_TIERS;

  const breakdown = scoreEventWithBreakdown(
    {
      hasSilentAuction: event.hasSilentAuction,
      hasLiveAuction: event.hasLiveAuction,
      auctionType: event.auctionType,
      ticketPrice: event.ticketPrice ? parseFloat(String(event.ticketPrice)) : null,
      tablePrice: event.tablePrice ? parseFloat(String(event.tablePrice)) : null,
      formality: event.formality,
      eventDate: event.eventDate,
      orgName: event.orgName,
    },
    weights as any,
    tiers as any,
  );

  res.json(breakdown);
});

// GET /crawl-runs/:id/progress (SSE)
router.get("/crawl-runs/:id/progress", async (req, res) => {
  const runId = Number(req.params.id);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: CrawlProgressEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const sendReplay = (entries: LogEntry[]) => {
    if (entries.length === 0) return;
    res.write(`data: ${JSON.stringify({ type: "log_replay", entries })}\n\n`);
  };

  // Register the live listener BEFORE replaying history. The in-memory replay
  // below is synchronous (no await between registration and the buffer
  // snapshot), so no live event can be lost or duplicated; for the async DB
  // fallback path, registering first ensures events emitted during the query
  // are streamed live instead of being dropped.
  if (!progressListeners.has(runId)) {
    progressListeners.set(runId, new Set());
  }
  progressListeners.get(runId)!.add(send);

  req.on("close", () => {
    progressListeners.get(runId)?.delete(send);
  });

  const inMemory = logBuffers.get(runId);
  if (inMemory && inMemory.length > 0) {
    sendReplay([...inMemory]);
  } else {
    try {
      const [row] = await db
        .select({ debugLog: crawlRunsTable.debugLog, status: crawlRunsTable.status })
        .from(crawlRunsTable)
        .where(eq(crawlRunsTable.id, runId));
      if (row?.debugLog && Array.isArray(row.debugLog) && row.debugLog.length > 0) {
        sendReplay(row.debugLog as LogEntry[]);
        if (row.status === "completed" || row.status === "stopped" || row.status === "failed") {
          send({ type: "complete" });
          progressListeners.get(runId)?.delete(send);
          res.end();
          return;
        }
      }
    } catch (err) {
      req.log.warn({ err, runId }, "SSE log replay failed");
    }
  }
});

function serializeEvent(e: typeof eventsTable.$inferSelect) {
  return {
    id: e.id,
    runId: e.runId,
    score: e.score,
    tier: e.tier,
    status: e.status,
    eventName: e.eventName,
    eventDate: e.eventDate,
    eventVenue: e.eventVenue,
    eventAddress: e.eventAddress,
    eventDescription: e.eventDescription,
    auctionType: e.auctionType,
    hasSilentAuction: e.hasSilentAuction,
    hasLiveAuction: e.hasLiveAuction,
    hasOnlineAuction: e.hasOnlineAuction,
    hasRaffle: e.hasRaffle,
    hasDonationRequest: e.hasDonationRequest,
    ticketPrice: e.ticketPrice ? parseFloat(String(e.ticketPrice)) : null,
    tablePrice: e.tablePrice ? parseFloat(String(e.tablePrice)) : null,
    formality: e.formality,
    rsvpLink: e.rsvpLink,
    contactTitle: e.contactTitle,
    contactFirstName: e.contactFirstName,
    contactLastName: e.contactLastName,
    contactName: e.contactName,
    contactEmail: e.contactEmail,
    contactPhone: e.contactPhone,
    eventPageUrl: e.eventPageUrl,
    audienceNote: e.audienceNote,
    sponsorshipMentioned: e.sponsorshipMentioned,
    orgName: e.orgName,
    orgAddress: e.orgAddress,
    orgCity: e.orgCity,
    orgState: e.orgState,
    orgZip: e.orgZip,
    orgPhone: e.orgPhone,
    orgEmail: e.orgEmail,
    orgWebsite: e.orgWebsite,
    isPast: e.isPast,
    errorMessage: e.errorMessage,
    createdAt: e.createdAt.toISOString(),
  };
}

export { serializeEvent };
export default router;
