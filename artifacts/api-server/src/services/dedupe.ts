import { createHash } from "node:crypto";
import { db, eventsTable } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import type { CrawledEvent } from "./crawler";

/**
 * Cross-run event deduplication.
 *
 * Identity (dedupeKey): sha256 of normalized event name + event date + source
 * domain. When the name is missing, falls back to the normalized page URL so
 * every event still gets a stable key.
 *
 * Change detection (contentHash): sha256 of the significant extracted fields.
 * Same dedupeKey + same contentHash  → duplicate (skip).
 * Same dedupeKey + different hash    → the event changed (insert as UPDATED).
 * Unknown dedupeKey                  → new find (insert as NEW).
 */

function normalize(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeUrlForKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    // Drop tracking params that change without the content changing
    for (const p of [...u.searchParams.keys()]) {
      if (p.startsWith("utm_") || p === "fbclid" || p === "gclid") u.searchParams.delete(p);
    }
    return (u.origin + u.pathname).replace(/\/+$/, "").toLowerCase() + (u.search || "");
  } catch {
    return url.toLowerCase();
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function computeDedupeKey(event: Pick<CrawledEvent, "eventName" | "eventDate" | "eventPageUrl">): string {
  const name = normalize(event.eventName);
  const date = normalize(event.eventDate);
  if (name) {
    return sha256(`${name}|${date}|${domainOf(event.eventPageUrl)}`);
  }
  return sha256(`url|${normalizeUrlForKey(event.eventPageUrl)}`);
}

export function computeContentHash(event: CrawledEvent): string {
  // Fields whose change should mark an existing event as UPDATED.
  const significant = [
    event.eventName, event.eventDate, event.eventVenue, event.eventAddress,
    event.auctionType, event.hasSilentAuction, event.hasLiveAuction,
    event.hasOnlineAuction, event.hasRaffle, event.hasDonationRequest,
    event.ticketPrice, event.tablePrice, event.formality, event.rsvpLink,
    event.contactFirstName, event.contactLastName,
    event.contactEmail, event.contactPhone, event.orgName,
  ];
  return sha256(JSON.stringify(significant.map((v) => (v === undefined ? null : v))));
}

export type DedupeVerdict = "NEW" | "UPDATED" | "DUPLICATE";

export interface ClassifiedEvent {
  event: CrawledEvent;
  dedupeKey: string;
  contentHash: string;
  verdict: DedupeVerdict;
}

/**
 * Classifies a batch of freshly crawled events against everything already in
 * the database (one query for the whole batch).
 */
export async function classifyEvents(events: CrawledEvent[]): Promise<ClassifiedEvent[]> {
  if (events.length === 0) return [];

  const keyed = events.map((event) => ({
    event,
    dedupeKey: computeDedupeKey(event),
    contentHash: computeContentHash(event),
  }));

  const keys = [...new Set(keyed.map((k) => k.dedupeKey))];

  // Latest stored contentHash per dedupeKey across all previous runs.
  const existing = await db
    .select({
      dedupeKey: eventsTable.dedupeKey,
      contentHash: sql<string | null>`(array_agg(${eventsTable.contentHash} order by ${eventsTable.createdAt} desc))[1]`,
    })
    .from(eventsTable)
    .where(inArray(eventsTable.dedupeKey, keys))
    .groupBy(eventsTable.dedupeKey);

  const existingByKey = new Map(existing.map((row) => [row.dedupeKey, row.contentHash]));

  return keyed.map(({ event, dedupeKey, contentHash }) => {
    let verdict: DedupeVerdict;
    if (!existingByKey.has(dedupeKey)) {
      verdict = "NEW";
    } else if (existingByKey.get(dedupeKey) === contentHash) {
      verdict = "DUPLICATE";
    } else {
      verdict = "UPDATED";
    }
    return { event, dedupeKey, contentHash, verdict };
  });
}
