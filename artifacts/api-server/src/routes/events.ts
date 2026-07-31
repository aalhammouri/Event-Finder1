import { Router } from "express";
import { db } from "@workspace/db";
import { eventsTable, crawlRunsTable, urlListsTable, adminSettingsTable, organizationsTable } from "@workspace/db";
import { eq, and, gte, lte, ilike, or, sql, ne } from "drizzle-orm";
import { GetEventsQueryParams, GetEventParams, ExportEventsQueryParams } from "@workspace/api-zod";
import { serializeEvent } from "./crawlRuns";
import { parseEventDate } from "../services/dates";

const router = Router();

// GET /events
router.get("/events", async (req, res) => {
  const parsed = GetEventsQueryParams.safeParse(req.query);
  const params = (parsed.success ? parsed.data : {}) as NonNullable<typeof parsed["data"]>;

  const {
    runId,
    tier,
    auctionType,
    status,
    minScore,
    maxScore,
    search,
    sortBy = "score",
    sortDir = "desc",
    page = 1,
    limit = 50,
  } = params;

  // Read hidePast/pastOnly directly from the raw query string.
  // zod.coerce.boolean() coerces "false" → true, so we bypass it here.
  // Default: hide past events unless the client sends hidePast=false.
  // pastOnly=true restricts to past events only (used by the Past Events page).
  const showPast = req.query.hidePast === "false";
  const pastOnly = req.query.pastOnly === "true";

  const conditions = [];
  if (runId) conditions.push(eq(eventsTable.runId, Number(runId)));
  if (tier) conditions.push(eq(eventsTable.tier, tier));
  if (status) conditions.push(eq(eventsTable.status, status));
  if (pastOnly) {
    conditions.push(eq(eventsTable.isPast, true));
  } else if (!showPast) {
    conditions.push(ne(eventsTable.isPast, true));
  }
  if (auctionType) conditions.push(eq(eventsTable.auctionType, auctionType));
  if (minScore !== undefined) conditions.push(gte(eventsTable.score, Number(minScore)));
  if (maxScore !== undefined) conditions.push(lte(eventsTable.score, Number(maxScore)));

  if (search) {
    const s = `%${search}%`;
    conditions.push(
      or(
        ilike(eventsTable.eventName, s),
        ilike(eventsTable.orgName, s),
        ilike(eventsTable.eventVenue, s),
        ilike(eventsTable.eventAddress, s),
        ilike(eventsTable.contactName, s),
        ilike(eventsTable.contactEmail, s),
        ilike(eventsTable.audienceNote, s)
      )
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const validSortCols: Record<string, any> = {
    score: eventsTable.score,
    eventDate: eventsTable.eventDate,
    tier: eventsTable.tier,
    ticketPrice: eventsTable.ticketPrice,
    tablePrice: eventsTable.tablePrice,
    eventName: eventsTable.eventName,
    orgName: eventsTable.orgName,
    createdAt: eventsTable.createdAt,
  };
  const sortCol = validSortCols[sortBy as string] ?? eventsTable.score;
  const orderExpr = sortDir === "asc" ? sql`${sortCol} asc` : sql`${sortCol} desc`;

  const offset = (Number(page) - 1) * Number(limit);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(eventsTable)
    .where(where);

  const rows = await db
    .select({ event: eventsTable, listName: urlListsTable.name })
    .from(eventsTable)
    .leftJoin(crawlRunsTable, eq(eventsTable.runId, crawlRunsTable.id))
    .leftJoin(urlListsTable, eq(crawlRunsTable.urlListId, urlListsTable.id))
    .where(where)
    .orderBy(orderExpr)
    .limit(Number(limit))
    .offset(offset);

  res.json({
    events: rows.map(({ event, listName }) => ({ ...serializeEvent(event), runName: listName ?? null })),
    total: Number(countRow?.count ?? 0),
    page: Number(page),
    limit: Number(limit),
  });
});

// GET /events/export (must be before /:id)
router.get("/events/export", async (req, res) => {
  const parsed = ExportEventsQueryParams.safeParse(req.query);
  const params = parsed.success ? parsed.data : {};

  const conditions = [];
  if ((params as any).runId) conditions.push(eq(eventsTable.runId, Number((params as any).runId)));
  if ((params as any).tier) conditions.push(eq(eventsTable.tier, (params as any).tier));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db.select().from(eventsTable).where(where).orderBy(sql`${eventsTable.score} desc`);

  const headers = [
    "Score", "Tier", "Status", "Event Name", "Event Date", "Event Venue", "Event Address",
    "Auction Type", "Has Silent Auction", "Has Live Auction", "Has Online Auction",
    "Has Raffle", "Has Donation Request",
    "Ticket Price", "Table Price", "Formality", "RSVP Link",
    "Contact Title", "Contact First Name", "Contact Last Name",
    "Contact Name", "Contact Email", "Contact Phone",
    "Event Page URL", "Audience Note", "Sponsorship Mentioned",
    "Org Name", "Org Address", "Org City", "Org State", "Org Zip",
    "Org Phone", "Org Email", "Org Website", "Error",
  ];

  const csvRows = [
    headers.join(","),
    ...rows.map((e) => [
      e.score, csvEscape(e.tier), e.status,
      csvEscape(e.eventName), csvEscape(e.eventDate), csvEscape(e.eventVenue), csvEscape(e.eventAddress),
      csvEscape(e.auctionType), e.hasSilentAuction, e.hasLiveAuction,
      e.hasOnlineAuction, e.hasRaffle, e.hasDonationRequest,
      e.ticketPrice, e.tablePrice, csvEscape(e.formality),
      csvEscape(e.rsvpLink),
      csvEscape(e.contactTitle), csvEscape(e.contactFirstName), csvEscape(e.contactLastName),
      csvEscape(e.contactName), csvEscape(e.contactEmail), csvEscape(e.contactPhone),
      csvEscape(e.eventPageUrl), csvEscape(e.audienceNote), e.sponsorshipMentioned,
      csvEscape(e.orgName), csvEscape(e.orgAddress), csvEscape(e.orgCity),
      csvEscape(e.orgState), csvEscape(e.orgZip),
      csvEscape(e.orgPhone), csvEscape(e.orgEmail), csvEscape(e.orgWebsite), csvEscape(e.errorMessage),
    ].join(",")),
  ];

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=events.csv");
  res.send(csvRows.join("\n"));
});

// GET /events/export/crm — ACT CRM import format
//
// Reproduces the "Ready for Import" sheet from the manual workflow EXACTLY:
// 30 columns, A..AD, including the deliberately blank spacer column F that sits
// between "GCP - Raffle" and "GCP - Event Web Page". Column order and header
// spelling must not drift — the ACT import mapping is positional.
//
// Values come from two sources, mirroring the green/orange split of the sheet:
//   - GREEN  organizations table (GuideStar export): registered mailing
//            address, org phone, legal name, principal officer. A crawl cannot
//            produce these reliably.
//   - ORANGE events table (scraped): event name, date, auction flags, event
//            page, and any contact details found on the page.
// Scraped values win when present; org data fills the gaps.
router.get("/events/export/crm", async (req, res) => {
  const conditions = [];
  if (req.query.runId) conditions.push(eq(eventsTable.runId, Number(req.query.runId)));
  if (req.query.tier) conditions.push(eq(eventsTable.tier, req.query.tier as string));
  // Past events are excluded by default — an ACT import of finished events is
  // noise. Pass includePast=true to override.
  if (req.query.includePast !== "true") conditions.push(ne(eventsTable.isPast, true));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({ event: eventsTable, org: organizationsTable })
    .from(eventsTable)
    .leftJoin(organizationsTable, eq(eventsTable.organizationId, organizationsTable.id))
    .where(where)
    .orderBy(sql`${eventsTable.score} desc`);

  const [settings] = await db.select().from(adminSettingsTable).limit(1);
  const primaryGroup1 = (settings?.primaryGroup1Label as string) ?? "2026 Events";
  const defaultState = (settings?.defaultMailingState as string) ?? "TX";

  // M/D/YYYY, no leading zeros — the convention in the existing sheet.
  const formatDate = (dateStr: string | null | undefined): string => {
    const { iso } = parseEventDate(dateStr);
    if (!iso) return dateStr ?? "";
    const [y, m, d] = iso.split("-").map(Number);
    return `${m}/${d}/${y}`;
  };

  // Prefer a scraped value, fall back to the organization record.
  const pick = (...vals: Array<string | null | undefined>): string =>
    vals.find((v) => v !== null && v !== undefined && String(v).trim() !== "") ?? "";

  // Exact 30-column layout of the "Ready for Import" sheet (A..AD).
  // Index 5 (column F) is intentionally an empty header + empty value.
  const headers = [
    "GCP - Donation Needed By",          // A
    "GCP - Online Auction",              // B
    "GCP - Live Auction",                // C
    "GCP - Silent Auction",              // D
    "GCP - Raffle",                      // E
    "",                                  // F — blank spacer, present in the template
    "GCP - Event Web Page",              // G
    "Organization ID",                   // H
    "GCP - Event Date Sort",             // I
    "GCP - Beneficiary of Fundraiser",   // J
    "GCP - Event",                       // K
    "First Name",                        // L
    "Last name",                         // M
    "Salutation",                        // N
    "Title 1",                           // O
    "Mailing Address 1",                 // P
    "Mailing Address 2",                 // Q
    "Mailing City",                      // R
    "Mailing State",                     // S
    "Mailing Zip",                       // T
    "Phone - Business",                  // U
    "E-mail",                            // V
    "GCP - Event Status",                // W
    "Primary Group 1",                   // X
    "Primary Group 2",                   // Y
    "Web Site",                          // Z
    "GC - Estate Planning Expiration Date", // AA
    "GCP - Items Donated",               // AB
    "Contact",                           // AC
    "Company",                           // AD
  ];

  const csvRows = [
    headers.map(csvEscape).join(","),
    ...rows.map(({ event: e, org }) => {
      // Split a person's name when the page only yielded a combined one.
      const nameParts = (e.contactName ?? org?.primaryContactName ?? "").trim().split(/\s+/);
      const firstName = pick(e.contactFirstName, nameParts.length > 1 ? nameParts[0] : "");
      const lastName = pick(e.contactLastName, nameParts.length > 1 ? nameParts.slice(1).join(" ") : "");
      const contactFull = pick(
        [e.contactFirstName, e.contactLastName].filter(Boolean).join(" "),
        e.contactName,
        org?.primaryContactName
      );

      return [
        boolToCrm(e.hasDonationRequest),                          // A
        boolToCrm(e.hasOnlineAuction),                            // B
        boolToCrm(e.hasLiveAuction),                              // C
        boolToCrm(e.hasSilentAuction),                            // D
        boolToCrm(e.hasRaffle),                                   // E
        "",                                                       // F blank spacer
        csvEscape(e.eventPageUrl),                                // G
        "",                                                       // H Organization ID — assigned inside ACT
        csvEscape(formatDate(e.eventDate)),                       // I
        csvEscape(pick(e.orgName, org?.orgName)),                 // J Beneficiary
        csvEscape(e.eventName),                                   // K
        csvEscape(firstName),                                     // L
        csvEscape(lastName),                                      // M
        "",                                                       // N Salutation
        csvEscape(pick(e.contactTitle, org?.primaryContactTitle)),// O
        csvEscape(pick(org?.orgName, e.orgName)),                 // P Mailing Address 1 = ORG NAME
        csvEscape(pick(e.orgAddress, org?.addressLine1)),         // Q Mailing Address 2 = street
        csvEscape(pick(e.orgCity, org?.city)),                    // R
        csvEscape(pick(e.orgState, org?.state, defaultState)),    // S
        csvEscape(pick(e.orgZip, org?.zip)),                      // T
        csvEscape(pick(e.orgPhone, org?.orgPhone)),               // U
        csvEscape(pick(e.contactEmail, e.orgEmail, org?.primaryContactEmail)), // V
        "Pending",                                                // W
        csvEscape(primaryGroup1),                                 // X
        "Charity",                                                // Y
        csvEscape(pick(e.orgWebsite, org?.webAddress)),           // Z
        "",                                                       // AA
        "",                                                       // AB
        csvEscape(contactFull),                                   // AC
        csvEscape(pick(org?.legalName, e.orgName)),               // AD Company = GuideStar legal name
      ].join(",");
    }),
  ];

  const runLabel = req.query.runId ? `run-${req.query.runId}` : "all";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="ACT_CRM_Export_${runLabel}_${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  res.send(csvRows.join("\n"));
});

// GET /events/:id
router.get("/events/:id", async (req, res) => {
  const parsed = GetEventParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

  const [event] = await db.select().from(eventsTable).where(eq(eventsTable.id, parsed.data.id));
  if (!event) { res.status(404).json({ error: "Not found" }); return; }

  res.json(serializeEvent(event));
});

function csvEscape(val: string | null | undefined): string {
  if (val == null) return "";
  const str = String(val);
  // Neutralize spreadsheet formula injection: cells starting with =, +, -, or @
  // are interpreted as formulas by Excel and similar tools. Prepending a single
  // quote signals a text literal, suppressing formula evaluation.
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

// Tristate boolean formatter for ACT CRM — "Unkown" is intentional (matches ACT template)
function boolToCrm(v: boolean | null | undefined): string {
  if (v === true) return "Yes";
  if (v === false) return "No";
  return "Unkown";
}

export default router;
