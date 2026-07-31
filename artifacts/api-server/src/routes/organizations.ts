import { Router } from "express";
import { db } from "@workspace/db";
import {
  organizationsTable,
  urlListsTable,
  urlListItemsTable,
  eventsTable,
} from "@workspace/db";
import { eq, sql, and, isNotNull, inArray } from "drizzle-orm";
import { z } from "zod";
import { importOrganizationsCsv, normalizeDomain } from "../services/orgImport";
import { requireAdmin } from "../middleware/auth";
import { isSafeUrl } from "../utils/ssrf";
import { logger } from "../lib/logger";

const router = Router();

function serializeOrg(o: typeof organizationsTable.$inferSelect) {
  return {
    id: o.id,
    orgName: o.orgName,
    legalName: o.legalName,
    ein: o.ein,
    addressLine1: o.addressLine1,
    addressLine2: o.addressLine2,
    city: o.city,
    state: o.state,
    county: o.county,
    zip: o.zip,
    orgPhone: o.orgPhone,
    webAddress: o.webAddress,
    domain: o.domain,
    irsSubsection: o.irsSubsection,
    nteeCode: o.nteeCode,
    subjectArea1: o.subjectArea1,
    guidestarUrl: o.guidestarUrl,
    reviewStatus: o.reviewStatus,
    principalOfficer: o.principalOfficer,
    primaryContactName: o.primaryContactName,
    primaryContactTitle: o.primaryContactTitle,
    primaryContactEmail: o.primaryContactEmail,
    totalRevenue: o.totalRevenue,
    createdAt: o.createdAt.toISOString(),
  };
}

// GET /organizations — paginated, filterable list
router.get("/organizations", async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const ntee = typeof req.query.nteeCode === "string" ? req.query.nteeCode.trim() : "";
  const status = typeof req.query.reviewStatus === "string" ? req.query.reviewStatus.trim() : "";

  const conditions = [];
  if (search) {
    conditions.push(sql`(${organizationsTable.orgName} ilike ${"%" + search + "%"}
      or ${organizationsTable.ein} ilike ${"%" + search + "%"}
      or ${organizationsTable.domain} ilike ${"%" + search + "%"})`);
  }
  if (ntee) conditions.push(sql`${organizationsTable.nteeCode} ilike ${ntee + "%"}`);
  if (status) conditions.push(eq(organizationsTable.reviewStatus, status));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(organizationsTable)
    .where(where);

  const rows = await db
    .select()
    .from(organizationsTable)
    .where(where)
    .orderBy(organizationsTable.orgName)
    .limit(limit)
    .offset((page - 1) * limit);

  res.json({
    organizations: rows.map(serializeOrg),
    total: Number(countRow?.count ?? 0),
    page,
    limit,
  });
});

// POST /organizations/import — ingest a GuideStar CSV export
//
// Accepts either a raw text/csv body or JSON { csv: "..." }. Large exports are
// expected, so the body limit is raised on this route only.
router.post(
  "/organizations/import",
  requireAdmin,
  async (req, res) => {
    let csvText = "";
    if (typeof req.body === "string") {
      csvText = req.body;
    } else if (req.body && typeof (req.body as any).csv === "string") {
      csvText = (req.body as any).csv;
    }

    if (!csvText.trim()) {
      res.status(400).json({
        error: "Send the export as a text/csv body, or JSON { \"csv\": \"...\" }",
      });
      return;
    }

    try {
      const result = await importOrganizationsCsv(csvText);
      req.log.info(
        { inserted: result.inserted, updated: result.updated, actingAdmin: req.user?.id },
        "Organization CSV imported"
      );
      res.json(result);
    } catch (err) {
      req.log.error({ err }, "Organization import failed");
      res.status(500).json({ error: "Import failed", detail: String(err) });
    }
  }
);

// POST /organizations/create-url-list — turn imported orgs into a crawlable list
//
// This is the join between the "morning start" export and the crawler: it takes
// the organizations matching a filter and builds a URL list from their website
// addresses, which is exactly the step that used to be done by hand.
router.post("/organizations/create-url-list", requireAdmin, async (req, res) => {
  const Body = z.object({
    name: z.string().min(1),
    nteeCodes: z.array(z.string()).optional(),
    reviewStatus: z.string().optional(),
    excludeReviewStatus: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(20000).optional(),
  });

  const parsed = Body.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  const { name, nteeCodes, reviewStatus, excludeReviewStatus, limit } = parsed.data;

  const conditions = [isNotNull(organizationsTable.webAddress)];
  if (reviewStatus) conditions.push(eq(organizationsTable.reviewStatus, reviewStatus));
  if (excludeReviewStatus?.length) {
    conditions.push(sql`(${organizationsTable.reviewStatus} is null or ${organizationsTable.reviewStatus} not in ${excludeReviewStatus})`);
  }
  if (nteeCodes?.length) {
    // NTEE values are stored as "X20 (Christian)" — match on the code prefix.
    const ors = nteeCodes.map((c) => sql`${organizationsTable.nteeCode} ilike ${c + "%"}`);
    conditions.push(sql`(${sql.join(ors, sql` or `)})`);
  }

  const rows = await db
    .select({ webAddress: organizationsTable.webAddress })
    .from(organizationsTable)
    .where(and(...conditions))
    .limit(limit ?? 5000);

  // Normalize to a crawlable origin, drop anything unsafe or unparseable.
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const r of rows) {
    const host = normalizeDomain(r.webAddress);
    if (!host || seen.has(host)) continue;
    const url = `https://${host}`;
    if (!isSafeUrl(url)) continue;
    seen.add(host);
    urls.push(url);
  }

  if (urls.length === 0) {
    res.status(400).json({ error: "No usable website addresses matched that filter" });
    return;
  }

  const [list] = await db.insert(urlListsTable).values({ name }).returning();
  const BATCH = 500;
  for (let i = 0; i < urls.length; i += BATCH) {
    await db.insert(urlListItemsTable).values(
      urls.slice(i, i + BATCH).map((url) => ({ urlListId: list.id, url }))
    );
  }

  logger.info({ listId: list.id, urlCount: urls.length }, "URL list created from organizations");
  res.status(201).json({ id: list.id, name: list.name, urlCount: urls.length });
});

// POST /organizations/relink-events — backfill event→organization links
//
// Matches on the event page's hostname. Safe to re-run; only fills events that
// are not already linked.
router.post("/organizations/relink-events", requireAdmin, async (req, res) => {
  const orgs = await db
    .select({ id: organizationsTable.id, domain: organizationsTable.domain })
    .from(organizationsTable)
    .where(isNotNull(organizationsTable.domain));

  const byDomain = new Map<string, number>();
  for (const o of orgs) if (o.domain) byDomain.set(o.domain, o.id);

  const events = await db
    .select({ id: eventsTable.id, url: eventsTable.eventPageUrl })
    .from(eventsTable)
    .where(sql`${eventsTable.organizationId} is null and ${eventsTable.eventPageUrl} is not null`);

  // Group event ids by the organization they resolve to, then update in bulk.
  const updates = new Map<number, number[]>();
  for (const e of events) {
    const host = normalizeDomain(e.url);
    if (!host) continue;
    const orgId = byDomain.get(host);
    if (!orgId) continue;
    if (!updates.has(orgId)) updates.set(orgId, []);
    updates.get(orgId)!.push(e.id);
  }

  let linked = 0;
  for (const [orgId, ids] of updates) {
    const BATCH = 500;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      await db.update(eventsTable).set({ organizationId: orgId }).where(inArray(eventsTable.id, chunk));
      linked += chunk.length;
    }
  }

  res.json({ organizationsWithDomain: byDomain.size, eventsExamined: events.length, eventsLinked: linked });
});

export default router;
