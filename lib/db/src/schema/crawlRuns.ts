import { pgTable, serial, text, integer, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { urlListsTable } from "./urlLists";

export const crawlRunsTable = pgTable("crawl_runs", {
  id: serial("id").primaryKey(),
  urlListId: integer("url_list_id").notNull().references(() => urlListsTable.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["pending", "running", "paused", "completed", "failed", "stopped"] }).notNull().default("pending"),
  triggeredBy: text("triggered_by", { enum: ["manual", "scheduled"] }).notNull().default("manual"),
  totalUrls: integer("total_urls").notNull().default(0),
  pagesCrawled: integer("pages_crawled").notNull().default(0),
  eventsMatched: integer("events_matched").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  // Cross-run dedupe counters
  newCount: integer("new_count").notNull().default(0),
  updatedCount: integer("updated_count").notNull().default(0),
  duplicateCount: integer("duplicate_count").notNull().default(0),
  // How many events were discarded because the org's state is not in geographicStates.
  skippedByGeography: integer("skipped_by_geography").notNull().default(0),
  // Seed URLs already fully processed in this run — lets a paused/interrupted
  // run resume from where it left off instead of re-crawling everything.
  completedUrls: jsonb("completed_urls").$type<string[]>().notNull().default([]),
  // The exact seed URL set this run was started with. Needed for resume:
  // retry-runs use a subset of the URL list, so resuming must not fall back
  // to the full list.
  seedUrls: jsonb("seed_urls").$type<string[]>().notNull().default([]),
  archived: boolean("archived").notNull().default(false),
  // Coverage metrics (Part D)
  pagesDiscovered: integer("pages_discovered").notNull().default(0),
  pagesMissed: integer("pages_missed").notNull().default(0),
  pagesKeywordMatched: integer("pages_keyword_matched").notNull().default(0),
  pagesSentToAi: integer("pages_sent_to_ai").notNull().default(0),
  fallbackPages: integer("fallback_pages").notNull().default(0),
  sitesComplete: integer("sites_complete").notNull().default(0),
  sitesIncomplete: integer("sites_incomplete").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  debugLog: jsonb("debug_log").$type<Array<{ ts: string; type: string; url?: string; msg: string; score?: number }>>().notNull().default([]),
  // AI token usage accumulated across all pages in this run
  tokenUsage: jsonb("token_usage").$type<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  } | null>().default(null),
});

export const insertCrawlRunSchema = createInsertSchema(crawlRunsTable).omit({ id: true, createdAt: true });
export type InsertCrawlRun = z.infer<typeof insertCrawlRunSchema>;
export type CrawlRun = typeof crawlRunsTable.$inferSelect;
