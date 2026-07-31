import { db, organizationsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * Importer for the GuideStar / Candid organization export — the "morning
 * start" data that begins the manual workflow.
 *
 * Columns are matched BY HEADER NAME, not position, because the export's
 * column order varies between pulls and the working sheet interleaves the
 * GuideStar columns with the hand-prepared CRM columns.
 */

// ── Minimal RFC-4180 CSV parser (handles quoted fields, embedded commas and
//    newlines, and doubled quotes). Avoids adding a dependency. ─────────────
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  // Strip a UTF-8 BOM, which Excel writes and which would corrupt the first header.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Normalize a header for tolerant matching: lowercase, alphanumerics only. */
function normHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Maps our organization fields to the header spellings seen in GuideStar
 * exports and in the team's working sheet. First match wins.
 */
const FIELD_ALIASES: Record<string, string[]> = {
  orgName:             ["org name", "organization name", "organisation name"],
  legalName:           ["company2", "company 2", "legal name", "company"],
  ein:                 ["ein", "employer identification number"],
  addressLine1:        ["address line 1", "address1", "street address"],
  addressLine2:        ["address line 2", "address2"],
  city:                ["city"],
  state:               ["state"],
  county:              ["county"],
  zip:                 ["zip", "zip code", "postal code"],
  orgPhone:            ["org phone number", "phone", "organization phone", "phone - business"],
  webAddress:          ["web address", "website", "web site", "web address (hyperlink)"],
  irsSubsection:       ["irs subsection"],
  nteeCode:            ["ntee code"],
  subjectArea1:        ["subject area 1"],
  subjectArea2:        ["subject area 2"],
  subjectArea3:        ["subject area 3"],
  guidestarUrl:        ["guidestar", "guidestar (hyperlink)", "link to gs profile page"],
  rulingYear:          ["ruling year"],
  formYear:            ["form year"],
  formType:            ["form type"],
  reviewStatus:        ["status"],
  dateReviewed:        ["date reviewed"],
  principalOfficer:    ["principal officer"],
  orgLeader:           ["org leader"],
  primaryContactName:  ["primary contact name"],
  primaryContactTitle: ["primary contact title"],
  primaryContactEmail: ["primary contact email"],
  totalRevenue:        ["total revenue"],
};

/** Reduce a website/URL to a bare host for matching against crawled pages. */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = String(raw).trim();
  if (!value || value === "#REF!") return null;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export interface ImportResult {
  inserted: number;
  updated: number;
  skipped: number;
  /** Headers we could not map — surfaced so a changed export is obvious. */
  unmappedHeaders: string[];
  errors: string[];
}

/**
 * Import organizations from raw CSV text. Rows are upserted on EIN when
 * present, otherwise on (orgName + domain), so re-importing a refreshed export
 * updates existing organizations rather than duplicating them.
 */
export async function importOrganizationsCsv(csvText: string): Promise<ImportResult> {
  const result: ImportResult = { inserted: 0, updated: 0, skipped: 0, unmappedHeaders: [], errors: [] };

  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    result.errors.push("CSV contained no data rows");
    return result;
  }

  const headers = rows[0].map((h) => h.trim());
  const normalized = headers.map(normHeader);

  // Resolve each field to a column index.
  const colOf: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const idx = normalized.indexOf(normHeader(alias));
      if (idx !== -1) { colOf[field] = idx; break; }
    }
  }

  if (colOf.orgName === undefined) {
    result.errors.push(
      `Could not find an "Org Name" column. Headers seen: ${headers.slice(0, 20).join(", ")}`
    );
    return result;
  }

  const mappedIdx = new Set(Object.values(colOf));
  result.unmappedHeaders = headers.filter((_, i) => !mappedIdx.has(i) && headers[i].trim() !== "");

  const cell = (row: string[], field: string): string | null => {
    const idx = colOf[field];
    if (idx === undefined) return null;
    const v = (row[idx] ?? "").trim();
    if (!v || v === "#REF!" || v === "#N/A") return null;
    return v;
  };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const orgName = cell(row, "orgName");
    if (!orgName) { result.skipped++; continue; }

    const webAddress = cell(row, "webAddress");
    const revenueRaw = cell(row, "totalRevenue");
    const revenue = revenueRaw ? Number(revenueRaw.replace(/[^0-9.-]/g, "")) : null;

    const values = {
      orgName,
      legalName: cell(row, "legalName") ?? orgName,
      ein: cell(row, "ein"),
      addressLine1: cell(row, "addressLine1"),
      addressLine2: cell(row, "addressLine2"),
      city: cell(row, "city"),
      state: cell(row, "state"),
      county: cell(row, "county"),
      zip: cell(row, "zip"),
      orgPhone: cell(row, "orgPhone"),
      webAddress,
      domain: normalizeDomain(webAddress),
      irsSubsection: cell(row, "irsSubsection"),
      nteeCode: cell(row, "nteeCode"),
      subjectArea1: cell(row, "subjectArea1"),
      subjectArea2: cell(row, "subjectArea2"),
      subjectArea3: cell(row, "subjectArea3"),
      guidestarUrl: cell(row, "guidestarUrl"),
      rulingYear: cell(row, "rulingYear"),
      formYear: cell(row, "formYear"),
      formType: cell(row, "formType"),
      reviewStatus: cell(row, "reviewStatus"),
      dateReviewed: cell(row, "dateReviewed"),
      principalOfficer: cell(row, "principalOfficer"),
      orgLeader: cell(row, "orgLeader"),
      primaryContactName: cell(row, "primaryContactName"),
      primaryContactTitle: cell(row, "primaryContactTitle"),
      primaryContactEmail: cell(row, "primaryContactEmail"),
      totalRevenue: revenue !== null && Number.isFinite(revenue) ? Math.round(revenue) : null,
    };

    try {
      // Prefer EIN as the identity key; fall back to name for rows without one.
      let existingId: number | null = null;
      if (values.ein) {
        const [hit] = await db
          .select({ id: organizationsTable.id })
          .from(organizationsTable)
          .where(eq(organizationsTable.ein, values.ein))
          .limit(1);
        existingId = hit?.id ?? null;
      }
      if (existingId === null) {
        const [hit] = await db
          .select({ id: organizationsTable.id })
          .from(organizationsTable)
          .where(sql`lower(${organizationsTable.orgName}) = lower(${values.orgName})`)
          .limit(1);
        existingId = hit?.id ?? null;
      }

      if (existingId !== null) {
        await db.update(organizationsTable).set(values).where(eq(organizationsTable.id, existingId));
        result.updated++;
      } else {
        await db.insert(organizationsTable).values(values);
        result.inserted++;
      }
    } catch (err) {
      result.errors.push(`Row ${r + 1} (${orgName}): ${String(err)}`);
      if (result.errors.length > 50) {
        result.errors.push("… further row errors suppressed");
        break;
      }
    }
  }

  logger.info(
    { inserted: result.inserted, updated: result.updated, skipped: result.skipped },
    "Organization import complete"
  );
  return result;
}
