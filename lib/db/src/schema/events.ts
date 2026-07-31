import { pgTable, serial, integer, text, boolean, numeric, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { crawlRunsTable } from "./crawlRuns";

export const eventsTable = pgTable("events", {
  id: serial("id").primaryKey(),
  runId: integer("run_id").notNull().references(() => crawlRunsTable.id, { onDelete: "cascade" }),
  score: integer("score").notNull().default(0),
  tier: text("tier").notNull().default("Tier C"),
  status: text("status", { enum: ["NEW", "UPDATED", "UNCHANGED"] }).notNull().default("NEW"),

  // Event info
  eventName: text("event_name"),
  eventDate: text("event_date"),
  eventVenue: text("event_venue"),
  eventAddress: text("event_address"),
  eventDescription: text("event_description"),
  auctionType: text("auction_type"),
  hasSilentAuction: boolean("has_silent_auction"),
  hasLiveAuction: boolean("has_live_auction"),
  hasOnlineAuction: boolean("has_online_auction"),
  hasRaffle: boolean("has_raffle"),
  hasDonationRequest: boolean("has_donation_request"),
  ticketPrice: numeric("ticket_price", { precision: 10, scale: 2 }),
  tablePrice: numeric("table_price", { precision: 10, scale: 2 }),
  formality: text("formality"),
  rsvpLink: text("rsvp_link"),
  contactTitle: text("contact_title"),
  contactFirstName: text("contact_first_name"),
  contactLastName: text("contact_last_name"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  eventPageUrl: text("event_page_url"),
  audienceNote: text("audience_note"),
  sponsorshipMentioned: boolean("sponsorship_mentioned"),

  // Org info
  orgName: text("org_name"),
  orgAddress: text("org_address"),
  orgCity: text("org_city"),
  orgState: text("org_state"),
  orgZip: text("org_zip"),
  orgPhone: text("org_phone"),
  orgEmail: text("org_email"),
  orgWebsite: text("org_website"),

  isPast: boolean("is_past").notNull().default(false),
  errorMessage: text("error_message"),

  // Cross-run dedupe: stable identity key (name|date|domain) and a content
  // hash of the significant fields, used to classify NEW/UPDATED/DUPLICATE.
  dedupeKey: text("dedupe_key"),
  contentHash: text("content_hash"),

  // Link to the GuideStar-sourced organization record, matched on the event
  // page's domain. Supplies the CRM columns a scrape cannot produce (EIN,
  // legal name, registered mailing address, principal officer).
  organizationId: integer("organization_id"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("events_dedupe_key_idx").on(table.dedupeKey),
]);

export const insertEventSchema = createInsertSchema(eventsTable).omit({ id: true, createdAt: true });
export type InsertEvent = z.infer<typeof insertEventSchema>;
export type Event = typeof eventsTable.$inferSelect;
