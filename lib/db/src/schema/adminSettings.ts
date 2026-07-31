import { pgTable, serial, text, integer, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const adminSettingsTable = pgTable("admin_settings", {
  id: serial("id").primaryKey(),
  searchKeywords: text("search_keywords").array().notNull().default([
    "silent auction", "live auction", "online auction", "raffle", "golf",
    "benefit auction", "auction items", "fundraiser", "fundraising event",
    "benefit dinner", "charity", "gala", "black-tie", "gala dinner",
    "church fundraiser"
  ]),
  // Avoid keywords are now a TIE-BREAKER for weak pages, never a veto over a
  // page carrying hard fundraising evidence (see services/gate.ts). The old
  // defaults deleted real targets outright — "wine" killed Catholic Charities'
  // Wine & Dine auction gala, "bingo" killed Avondale House's Bingo Bash, and
  // "arts" killed every page of any organisation with "Arts" in its name.
  // Defaults are now empty; add terms here only to break ties on marginal pages.
  avoidKeywords: text("avoid_keywords").array().notNull().default([]),
  overrideKeywords: text("override_keywords").array().notNull().default(["silent auction"]),
  maxPagesPerSite: integer("max_pages_per_site").notNull().default(30),
  timeoutPerPage: integer("timeout_per_page").notNull().default(30),
  // Scale/politeness controls: how many sites are crawled in parallel, the
  // minimum gap between requests to the same domain, and how many times a
  // failed fetch is retried (exponential backoff) before giving up.
  maxConcurrentSites: integer("max_concurrent_sites").notNull().default(5),
  perDomainDelayMs: integer("per_domain_delay_ms").notNull().default(1000),
  maxRetries: integer("max_retries").notNull().default(3),
  imageReadingEnabled: boolean("image_reading_enabled").notNull().default(true),
  scoringWeights: jsonb("scoring_weights").notNull().default({
    hasAuction: 30,
    auctionTypeBonus: 10,
    highTicketPrice: 30,
    midTicketPrice: 20,
    lowTicketPrice: 8,
    formalityBonus: 15,
    timingPrime: 25,
    timingGood: 10,
    timingPenalty: -20,
    beneficiaryBonus: 10,
  }),
  tiers: jsonb("tiers").notNull().default([
    { id: "tier-a", name: "Tier A", description: "High-priority events with strong auction and donor signals", minScore: 70 },
    { id: "tier-b", name: "Tier B", description: "Moderate-priority events worth tracking", minScore: 45 },
    { id: "tier-c", name: "Tier C", description: "Low-priority or uncertain events", minScore: 0 },
  ]),
  minScoreForEmail: integer("min_score_for_email").notNull().default(45),
  // Minimum score an event must reach to be stored or shown at all. Default 1
  // means accept anything the scorer touches (score 0 events are borderline and
  // may be excluded by setting this higher).
  minEventScore: integer("min_event_score").notNull().default(1),
  scheduleEnabled: boolean("schedule_enabled").notNull().default(false),
  scheduleDays: text("schedule_days").array().notNull().default(["Monday"]),
  scheduleTime: text("schedule_time").notNull().default("06:00"),
  scheduleTimezone: text("schedule_timezone").notNull().default("America/Chicago"),
  scheduleFrequency: text("schedule_frequency").notNull().default("weekly"),
  scheduleMonthDay: integer("schedule_month_day"),
  scheduleUrlListId: integer("schedule_url_list_id"),
  primaryGroup1Label: text("primary_group_1_label").notNull().default("2026 Events"),
  primaryGroup3Label: text("primary_group_3_label").notNull().default(""),
  defaultMailingState: text("default_mailing_state").notNull().default("TX"),
  // Empty = no geographic filtering (owner decision). A non-empty list makes
  // the crawler DISCARD events whose org state falls outside it, so a default
  // of ["TX"] silently dropped every out-of-state find. Leave empty to keep
  // everything; the Admin UI explains this.
  geographicStates: text("geographic_states").array().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const emailRecipientsTable = pgTable("email_recipients", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const domainBlacklistTable = pgTable("domain_blacklist", {
  id: serial("id").primaryKey(),
  domain: text("domain").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AdminSettings = typeof adminSettingsTable.$inferSelect;
export type EmailRecipient = typeof emailRecipientsTable.$inferSelect;
export type BlacklistedDomain = typeof domainBlacklistTable.$inferSelect;
