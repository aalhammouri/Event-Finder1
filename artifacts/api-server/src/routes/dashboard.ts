import { Router } from "express";
import { db } from "@workspace/db";
import {
  urlListsTable,
  crawlRunsTable,
  eventsTable,
} from "@workspace/db";
import { eq, sql, ne } from "drizzle-orm";
import { serializeEvent } from "./crawlRuns";

const router = Router();

// GET /dashboard/summary
router.get("/dashboard/summary", async (req, res) => {
  const [listCount] = await db.select({ count: sql<number>`count(*)` }).from(urlListsTable);
  const [runCount] = await db.select({ count: sql<number>`count(*)` }).from(crawlRunsTable);
  const [eventCount] = await db.select({ count: sql<number>`count(*)` }).from(eventsTable);

  const tierCounts = await db
    .select({ tier: eventsTable.tier, count: sql<number>`count(*)` })
    .from(eventsTable)
    .groupBy(eventsTable.tier);

  const statusCounts = await db
    .select({ status: eventsTable.status, count: sql<number>`count(*)` })
    .from(eventsTable)
    .groupBy(eventsTable.status);

  const [lastRun] = await db
    .select({ createdAt: crawlRunsTable.createdAt })
    .from(crawlRunsTable)
    .orderBy(sql`${crawlRunsTable.createdAt} desc`)
    .limit(1);

  // Normalise "Tier A" (current scorer output) and "A" (legacy rows) to the
  // same key. Reading tierMap["A"] directly returned 0 for every modern event.
  const tierRank = (t: string | null | undefined): string =>
    (t ?? "").replace(/^tier\s+/i, "").trim().toUpperCase();
  const tierMap: Record<string, number> = {};
  for (const { tier, count } of tierCounts) {
    const key = tierRank(tier);
    tierMap[key] = (tierMap[key] ?? 0) + Number(count);
  }

  const statusMap: Record<string, number> = {};
  for (const { status, count } of statusCounts) {
    statusMap[status] = Number(count);
  }

  res.json({
    totalLists: Number(listCount?.count ?? 0),
    totalRuns: Number(runCount?.count ?? 0),
    totalEvents: Number(eventCount?.count ?? 0),
    tierACount: tierMap["A"] ?? 0,
    tierBCount: tierMap["B"] ?? 0,
    tierCCount: tierMap["C"] ?? 0,
    newEvents: statusMap["NEW"] ?? 0,
    updatedEvents: statusMap["UPDATED"] ?? 0,
    lastRunAt: lastRun?.createdAt?.toISOString() ?? null,
  });
});

// GET /dashboard/top-events
router.get("/dashboard/top-events", async (req, res) => {
  const events = await db
    .select()
    .from(eventsTable)
    .where(ne(eventsTable.isPast, true))
    .orderBy(sql`${eventsTable.score} desc`)
    .limit(10);

  res.json(events.map(serializeEvent));
});

// GET /dashboard/tier-breakdown
router.get("/dashboard/tier-breakdown", async (req, res) => {
  const rows = await db
    .select({ tier: eventsTable.tier, count: sql<number>`count(*)` })
    .from(eventsTable)
    .groupBy(eventsTable.tier);

  res.json(rows.map((r) => ({ tier: r.tier, count: Number(r.count) })));
});

export default router;
