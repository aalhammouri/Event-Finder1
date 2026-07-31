import { pgTable, serial, text, integer, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { crawlRunsTable } from "./crawlRuns";

export const runSiteCoverageTable = pgTable("run_site_coverage", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull().references(() => crawlRunsTable.id, { onDelete: "cascade" }),
  siteUrl: text("site_url").notNull(),
  pagesDiscovered: integer("pages_discovered").notNull().default(0),
  pagesCrawled: integer("pages_crawled").notNull().default(0),
  pagesMissed: integer("pages_missed").notNull().default(0),
  isComplete: boolean("is_complete").notNull().default(true),
  missedUrls: jsonb("missed_urls").$type<string[]>().notNull().default([]),
  crawlErrors: jsonb("crawl_errors").$type<Array<{ url: string; error: string }>>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RunSiteCoverage = typeof runSiteCoverageTable.$inferSelect;
