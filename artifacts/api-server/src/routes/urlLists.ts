import { Router } from "express";
import { db } from "@workspace/db";
import {
  urlListsTable,
  urlListItemsTable,
  crawlRunsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  CreateUrlListBody,
  UpdateUrlListBody,
  GetUrlListParams,
  UpdateUrlListParams,
  DeleteUrlListParams,
  RunUrlListParams,
} from "@workspace/api-zod";
import { startCrawlRun } from "./crawlRuns";
import { requireAdmin } from "../middleware/auth";
import { isSafeUrl } from "../utils/ssrf";
import { preflightForRun } from "../services/preflight";

const router = Router();

// GET /url-lists
router.get("/url-lists", async (req, res) => {
  const lists = await db
    .select({
      id: urlListsTable.id,
      name: urlListsTable.name,
      createdAt: urlListsTable.createdAt,
      updatedAt: urlListsTable.updatedAt,
    })
    .from(urlListsTable)
    .orderBy(urlListsTable.updatedAt);

  const withCounts = await Promise.all(
    lists.map(async (list) => {
      const [countResult] = await db
        .select({ count: sql<number>`count(*)` })
        .from(urlListItemsTable)
        .where(eq(urlListItemsTable.urlListId, list.id));

      const [lastRun] = await db
        .select({ createdAt: crawlRunsTable.createdAt })
        .from(crawlRunsTable)
        .where(eq(crawlRunsTable.urlListId, list.id))
        .orderBy(sql`${crawlRunsTable.createdAt} desc`)
        .limit(1);

      return {
        ...list,
        urlCount: Number(countResult?.count ?? 0),
        lastRunAt: lastRun?.createdAt?.toISOString() ?? null,
        createdAt: list.createdAt.toISOString(),
        updatedAt: list.updatedAt.toISOString(),
      };
    })
  );

  res.json(withCounts);
});

// POST /url-lists
router.post("/url-lists", requireAdmin, async (req, res) => {
  const parsed = CreateUrlListBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { name, urls } = parsed.data;

  const invalidUrls = (urls ?? []).filter((u) => !isSafeUrl(u));
  if (invalidUrls.length > 0) {
    res.status(400).json({ error: "One or more URLs are not valid public HTTP/HTTPS addresses", invalidUrls });
    return;
  }

  const [list] = await db.insert(urlListsTable).values({ name }).returning();

  if (urls && urls.length > 0) {
    await db.insert(urlListItemsTable).values(
      urls.map((url) => ({ urlListId: list.id, url }))
    );
  }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(urlListItemsTable)
    .where(eq(urlListItemsTable.urlListId, list.id));

  res.status(201).json({
    id: list.id,
    name: list.name,
    urlCount: Number(countResult?.count ?? 0),
    lastRunAt: null,
    createdAt: list.createdAt.toISOString(),
    updatedAt: list.updatedAt.toISOString(),
  });
});

// GET /url-lists/:id
router.get("/url-lists/:id", async (req, res) => {
  const parsed = GetUrlListParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [list] = await db.select().from(urlListsTable).where(eq(urlListsTable.id, parsed.data.id));
  if (!list) { res.status(404).json({ error: "Not found" }); return; }

  const items = await db
    .select({ url: urlListItemsTable.url })
    .from(urlListItemsTable)
    .where(eq(urlListItemsTable.urlListId, list.id));

  const [lastRun] = await db
    .select({ createdAt: crawlRunsTable.createdAt })
    .from(crawlRunsTable)
    .where(eq(crawlRunsTable.urlListId, list.id))
    .orderBy(sql`${crawlRunsTable.createdAt} desc`)
    .limit(1);

  res.json({
    id: list.id,
    name: list.name,
    urls: items.map((i) => i.url),
    lastRunAt: lastRun?.createdAt?.toISOString() ?? null,
    createdAt: list.createdAt.toISOString(),
    updatedAt: list.updatedAt.toISOString(),
  });
});

// PATCH /url-lists/:id
router.patch("/url-lists/:id", requireAdmin, async (req, res) => {
  const idParsed = UpdateUrlListParams.safeParse({ id: Number(req.params.id) });
  if (!idParsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const bodyParsed = UpdateUrlListBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid input" }); return; }

  const { name, urls } = bodyParsed.data;

  if (urls !== undefined) {
    const invalidUrls = urls.filter((u) => !isSafeUrl(u));
    if (invalidUrls.length > 0) {
      res.status(400).json({ error: "One or more URLs are not valid public HTTP/HTTPS addresses", invalidUrls });
      return;
    }
  }
  const id = idParsed.data.id;

  if (name) {
    await db.update(urlListsTable).set({ name }).where(eq(urlListsTable.id, id));
  }

  if (urls !== undefined) {
    await db.delete(urlListItemsTable).where(eq(urlListItemsTable.urlListId, id));
    if (urls.length > 0) {
      await db.insert(urlListItemsTable).values(urls.map((url) => ({ urlListId: id, url })));
    }
  }

  const [list] = await db.select().from(urlListsTable).where(eq(urlListsTable.id, id));
  if (!list) { res.status(404).json({ error: "Not found" }); return; }

  const [countResult] = await db
    .select({ count: sql<number>`count(*)` })
    .from(urlListItemsTable)
    .where(eq(urlListItemsTable.urlListId, id));

  const [lastRun] = await db
    .select({ createdAt: crawlRunsTable.createdAt })
    .from(crawlRunsTable)
    .where(eq(crawlRunsTable.urlListId, id))
    .orderBy(sql`${crawlRunsTable.createdAt} desc`)
    .limit(1);

  res.json({
    id: list.id,
    name: list.name,
    urlCount: Number(countResult?.count ?? 0),
    lastRunAt: lastRun?.createdAt?.toISOString() ?? null,
    createdAt: list.createdAt.toISOString(),
    updatedAt: list.updatedAt.toISOString(),
  });
});

// DELETE /url-lists/:id
router.delete("/url-lists/:id", requireAdmin, async (req, res) => {
  const parsed = DeleteUrlListParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

  await db.delete(urlListsTable).where(eq(urlListsTable.id, parsed.data.id));
  res.status(204).send();
});

// POST /url-lists/:id/run
router.post("/url-lists/:id/run", requireAdmin, async (req, res) => {
  const parsed = RunUrlListParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [list] = await db.select().from(urlListsTable).where(eq(urlListsTable.id, parsed.data.id));
  if (!list) { res.status(404).json({ error: "Not found" }); return; }

  const items = await db
    .select({ url: urlListItemsTable.url })
    .from(urlListItemsTable)
    .where(eq(urlListItemsTable.urlListId, list.id));

  const urls = items.map((i) => i.url);
  const preflight = await preflightForRun(urls);
  if (preflight.fatal) {
    res.status(400).json({ error: preflight.fatal });
    return;
  }

  const [run] = await db
    .insert(crawlRunsTable)
    .values({
      urlListId: list.id,
      status: "pending",
      triggeredBy: "manual",
      totalUrls: items.length,
    })
    .returning();

  // Start crawl in background
  startCrawlRun(run.id, urls, "manual", { preflightWarnings: preflight.warnings }).catch((err) => {
    req.log.error({ err, runId: run.id }, "Background crawl failed");
  });

  res.status(202).json({
    id: run.id,
    urlListId: run.urlListId,
    urlListName: list.name,
    status: run.status,
    triggeredBy: run.triggeredBy,
    totalUrls: run.totalUrls,
    pagesCrawled: run.pagesCrawled,
    eventsMatched: run.eventsMatched,
    errorCount: run.errorCount,
    createdAt: run.createdAt.toISOString(),
    completedAt: null,
  });
});

export default router;
