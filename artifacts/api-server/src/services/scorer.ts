import { parseEventDate } from "./dates";

export interface ScoringWeights {
  hasAuction: number;
  auctionTypeBonus: number;
  highTicketPrice: number;
  midTicketPrice: number;
  lowTicketPrice: number;
  formalityBonus: number;
  timingPrime: number;
  timingGood: number;
  timingPenalty: number;
  beneficiaryBonus: number;
}

export interface ScoringTier {
  id: string;
  name: string;
  description: string;
  minScore: number;
}

export interface EventData {
  hasSilentAuction?: boolean | null;
  hasLiveAuction?: boolean | null;
  auctionType?: string | null;
  ticketPrice?: number | null;
  tablePrice?: number | null;
  formality?: string | null;
  eventDate?: string | null;
  orgName?: string | null;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
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
};

const BENEFICIARY_KEYWORDS = [
  "hospital", "foundation", "museum", "symphony", "opera", "ballet", "university", "college"
];

export const DEFAULT_TIERS: ScoringTier[] = [
  { id: "tier-a", name: "Tier A", description: "High-priority events with strong auction and donor signals", minScore: 70 },
  { id: "tier-b", name: "Tier B", description: "Moderate-priority events worth tracking", minScore: 45 },
  { id: "tier-c", name: "Tier C", description: "Low-priority or uncertain events", minScore: 0 },
];

/**
 * Coerce a persisted `tiers` value into the canonical ScoringTier[] shape.
 * Older records stored tiers as a plain object `{ tierA: 70, tierB: 45 }`.
 * Any code path that spreads/iterates tiers throws on a non-array; this
 * normalizes on read so legacy production data never causes a blank page.
 */
export function normalizeTiers(raw: unknown): ScoringTier[] {
  if (Array.isArray(raw)) return raw as ScoringTier[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const a = typeof obj.tierA === "number" ? obj.tierA : DEFAULT_TIERS[0].minScore;
    const b = typeof obj.tierB === "number" ? obj.tierB : DEFAULT_TIERS[1].minScore;
    return [
      { ...DEFAULT_TIERS[0], minScore: a },
      { ...DEFAULT_TIERS[1], minScore: b },
      { ...DEFAULT_TIERS[2] },
    ];
  }
  return DEFAULT_TIERS;
}

export function scoreEvent(
  event: EventData,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  tiers: ScoringTier[] = DEFAULT_TIERS
): { score: number; tier: string; isPast: boolean } {
  let score = 0;

  // Auction presence
  if (event.hasSilentAuction || event.hasLiveAuction) {
    score += weights.hasAuction;
  }

  // Auction type bonus
  const aType = (event.auctionType || "").toLowerCase();
  if (aType === "silent" || aType === "live") {
    score += weights.auctionTypeBonus;
  }

  // Ticket / table price
  const ticket = event.ticketPrice ?? 0;
  const table = event.tablePrice ?? 0;
  if (ticket >= 500 || table >= 5000) {
    score += weights.highTicketPrice;
  } else if (ticket >= 250 || table >= 2500) {
    score += weights.midTicketPrice;
  } else if (ticket >= 100) {
    score += weights.lowTicketPrice;
  }

  // Formality
  const formality = (event.formality || "").toLowerCase();
  if (formality === "black-tie" || formality === "gala") {
    score += weights.formalityBonus;
  }

  // Timing
  const timingScore = computeTimingScore(event.eventDate, weights);
  score += timingScore;

  // Beneficiary
  const orgLower = (event.orgName || "").toLowerCase();
  if (BENEFICIARY_KEYWORDS.some((k) => orgLower.includes(k))) {
    score += weights.beneficiaryBonus;
  }

  // Cap 0-100
  score = Math.min(100, Math.max(0, score));

  const isPast = isEventPast(event.eventDate);

  return { score, tier: getTier(score, tiers), isPast };
}

// Date reasoning lives in services/dates.ts so the scorer, the crawler and the
// events API can never disagree about whether an event has already happened.
// The old local implementation used `new Date(str)`, which silently failed on
// the formats nonprofit sites actually publish ("October 3", "10/3/26").
function isEventPast(eventDate: string | null | undefined): boolean {
  return parseEventDate(eventDate).isPast;
}

function computeTimingScore(eventDate: string | null | undefined, weights: ScoringWeights): number {
  const { weeksAway } = parseEventDate(eventDate);
  if (weeksAway === null) return 0;

  if (weeksAway < 0) return weights.timingPenalty;   // already happened
  if (weeksAway < 2) return weights.timingPenalty;   // too soon to engage
  if (weeksAway >= 6 && weeksAway <= 12) return weights.timingPrime;
  if ((weeksAway >= 2 && weeksAway < 6) || (weeksAway > 12 && weeksAway <= 17)) {
    return weights.timingGood;
  }
  return 0;
}

export function getTier(score: number, tiers: ScoringTier[] = DEFAULT_TIERS): string {
  if (tiers.length === 0) return DEFAULT_TIERS[DEFAULT_TIERS.length - 1].name;
  const sorted = [...tiers].sort((a, b) => b.minScore - a.minScore);
  for (const tier of sorted) {
    if (score >= tier.minScore) return tier.name;
  }
  return sorted[sorted.length - 1].name;
}

// 2E: the name of the highest-priority tier (the one with the greatest minScore).
// Used by early-termination heuristics — the tier names are admin-configurable,
// so this is NOT hard-coded to "A"/"Tier A".
export function getTopTierName(tiers: ScoringTier[] = DEFAULT_TIERS): string {
  const source = tiers.length === 0 ? DEFAULT_TIERS : tiers;
  return [...source].sort((a, b) => b.minScore - a.minScore)[0].name;
}

export interface ScoreBreakdownFactor {
  label: string;
  description: string;
  points: number;
  triggered: boolean;
}

export interface ScoreBreakdown {
  factors: ScoreBreakdownFactor[];
  total: number;
  tier: string;
  tiers: ScoringTier[];
}

export function scoreEventWithBreakdown(
  event: EventData,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  tiers: ScoringTier[] = DEFAULT_TIERS
): ScoreBreakdown {
  const factors: ScoreBreakdownFactor[] = [];
  let rawScore = 0;

  // 1. Auction presence
  const auctionPresent = !!(event.hasSilentAuction || event.hasLiveAuction);
  const auctionTypes = [event.hasSilentAuction ? "silent" : null, event.hasLiveAuction ? "live" : null].filter(Boolean).join(" + ");
  factors.push({
    label: "Auction present",
    description: auctionPresent
      ? `${auctionTypes} auction detected`
      : "No silent or live auction flagged",
    points: auctionPresent ? weights.hasAuction : 0,
    triggered: auctionPresent,
  });
  if (auctionPresent) rawScore += weights.hasAuction;

  // 2. Auction type bonus
  const aType = (event.auctionType || "").toLowerCase();
  const auctionTypeTriggered = aType === "silent" || aType === "live";
  factors.push({
    label: "Auction type bonus",
    description: auctionTypeTriggered
      ? `Type confirmed as "${event.auctionType}"`
      : event.auctionType
        ? `Type "${event.auctionType}" does not qualify`
        : "No auction type recorded",
    points: auctionTypeTriggered ? weights.auctionTypeBonus : 0,
    triggered: auctionTypeTriggered,
  });
  if (auctionTypeTriggered) rawScore += weights.auctionTypeBonus;

  // 3. Ticket / table price
  const ticket = event.ticketPrice ?? 0;
  const table = event.tablePrice ?? 0;
  let pricePoints = 0;
  let priceDesc = "";
  let priceTriggered = false;
  if (ticket >= 500 || table >= 5000) {
    pricePoints = weights.highTicketPrice;
    priceDesc = `High value — ticket $${ticket >= 500 ? ticket.toLocaleString() : "—"} / table $${table >= 5000 ? table.toLocaleString() : "—"}`;
    priceTriggered = true;
  } else if (ticket >= 250 || table >= 2500) {
    pricePoints = weights.midTicketPrice;
    priceDesc = `Mid value — ticket $${ticket >= 250 ? ticket.toLocaleString() : "—"} / table $${table >= 2500 ? table.toLocaleString() : "—"}`;
    priceTriggered = true;
  } else if (ticket >= 100) {
    pricePoints = weights.lowTicketPrice;
    priceDesc = `Low value — ticket $${ticket.toLocaleString()}`;
    priceTriggered = true;
  } else {
    priceDesc = ticket === 0 && table === 0
      ? "No price data recorded"
      : `Below threshold — ticket $${ticket} / table $${table}`;
  }
  factors.push({
    label: "Ticket / table price",
    description: priceDesc,
    points: pricePoints,
    triggered: priceTriggered,
  });
  if (priceTriggered) rawScore += pricePoints;

  // 4. Formality
  const formality = (event.formality || "").toLowerCase();
  const formalityTriggered = formality === "black-tie" || formality === "gala";
  factors.push({
    label: "Formality",
    description: formalityTriggered
      ? `"${event.formality}" qualifies`
      : event.formality
        ? `"${event.formality}" does not qualify (needs black-tie or gala)`
        : "No formality recorded",
    points: formalityTriggered ? weights.formalityBonus : 0,
    triggered: formalityTriggered,
  });
  if (formalityTriggered) rawScore += weights.formalityBonus;

  // 5. Timing
  const timingPoints = computeTimingScore(event.eventDate, weights);
  const timingTriggered = timingPoints !== 0;
  let timingDesc = "No event date recorded";
  if (event.eventDate) {
    if (timingPoints === weights.timingPrime) {
      timingDesc = "Prime window (6–12 weeks away)";
    } else if (timingPoints === weights.timingGood) {
      timingDesc = "Good window (2–6 or 12–17 weeks away)";
    } else if (timingPoints <= weights.timingPenalty) {
      const { weeksAway } = parseEventDate(event.eventDate);
      timingDesc = weeksAway === null
        ? "Event date could not be parsed"
        : weeksAway < 0
          ? "Event is in the past"
          : "Too soon (less than 2 weeks away)";
    } else {
      timingDesc = "Outside scoring window (more than 17 weeks away)";
    }
  }
  factors.push({
    label: "Timing",
    description: timingDesc,
    points: timingPoints,
    triggered: timingTriggered,
  });
  rawScore += timingPoints;

  // 6. Beneficiary org type
  const orgLower = (event.orgName || "").toLowerCase();
  const beneficiaryTriggered = BENEFICIARY_KEYWORDS.some((k) => orgLower.includes(k));
  factors.push({
    label: "Beneficiary org type",
    description: beneficiaryTriggered
      ? `"${event.orgName}" matches a qualifying keyword`
      : event.orgName
        ? `"${event.orgName}" does not match a qualifying keyword`
        : "No org name recorded",
    points: beneficiaryTriggered ? weights.beneficiaryBonus : 0,
    triggered: beneficiaryTriggered,
  });
  if (beneficiaryTriggered) rawScore += weights.beneficiaryBonus;

  const total = Math.min(100, Math.max(0, rawScore));

  return {
    factors,
    total,
    tier: getTier(total, tiers),
    tiers: tiers,
  };
}
