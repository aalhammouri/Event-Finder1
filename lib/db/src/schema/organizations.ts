import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Organizations — the "morning start" source data.
 *
 * In the manual workflow this is the GREEN half of the working spreadsheet: a
 * GuideStar / Candid export of nonprofits (EIN, registered address, NTEE code,
 * principal officer, primary contact) that the team then researched by hand.
 * The ORANGE half — the GCP-* columns — is what gets imported into ACT CRM.
 *
 * The crawler can scrape an event page, but it cannot invent an EIN, an IRS
 * subsection, an NTEE code or a registered mailing address. Holding that data
 * here lets the CRM export join scraped event detail to authoritative org
 * detail, which is what the manual process was doing by eye.
 */
export const organizationsTable = pgTable("organizations", {
  id: serial("id").primaryKey(),

  // ── Identity ──────────────────────────────────────────────────────────────
  orgName: text("org_name").notNull(),
  /** GuideStar legal name — exported to the CRM "Company" column. */
  legalName: text("legal_name"),
  ein: text("ein"),

  // ── Registered address (CRM Mailing Address 2 / City / State / Zip) ───────
  addressLine1: text("address_line_1"),
  addressLine2: text("address_line_2"),
  city: text("city"),
  state: text("state"),
  county: text("county"),
  zip: text("zip"),
  orgPhone: text("org_phone"),

  // ── Web presence. `domain` is the normalized host used to match a crawled
  //    event page back to this organization (no scheme, no leading www). ─────
  webAddress: text("web_address"),
  domain: text("domain"),

  // ── Classification / triage ───────────────────────────────────────────────
  irsSubsection: text("irs_subsection"),
  nteeCode: text("ntee_code"),
  subjectArea1: text("subject_area_1"),
  subjectArea2: text("subject_area_2"),
  subjectArea3: text("subject_area_3"),
  guidestarUrl: text("guidestar_url"),
  rulingYear: text("ruling_year"),
  formYear: text("form_year"),
  formType: text("form_type"),
  /** Review state carried over from the sheet: "Done", "Not Suitable", … */
  reviewStatus: text("review_status"),
  dateReviewed: text("date_reviewed"),

  // ── People (CRM First Name / Last name / Title 1 / Contact / E-mail) ──────
  principalOfficer: text("principal_officer"),
  orgLeader: text("org_leader"),
  primaryContactName: text("primary_contact_name"),
  primaryContactTitle: text("primary_contact_title"),
  primaryContactEmail: text("primary_contact_email"),

  /** Optional financial signal from the "Rated 1.1 mil Rev" sheet. */
  totalRevenue: integer("total_revenue"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("organizations_domain_idx").on(table.domain),
  index("organizations_ein_idx").on(table.ein),
]);

export const insertOrganizationSchema = createInsertSchema(organizationsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizationsTable.$inferSelect;
