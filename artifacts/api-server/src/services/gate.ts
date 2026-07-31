/**
 * Keyword gate — decides whether a page is worth an AI extraction call.
 *
 * WHY THIS WAS REWRITTEN: the previous gate treated the admin "avoid" list as
 * an unconditional veto applied by plain substring match, overridden only by
 * the literal phrase "silent auction". With the shipped defaults
 * (["bingo", "walk", "wine", "arts", ...]) that silently deleted real targets:
 *
 *   - Catholic Charities "Wine & Dine"      → killed by "wine"
 *   - MCC Foundation "Wine Dinner & Auction"→ killed by "wine"
 *   - Avondale House "Bingo Bash"           → killed by "bingo"
 *   - Pearl Fincher Museum of Fine ARTS     → "arts" is in the org's own name,
 *                                             so every page on the site died
 *
 * The fix is to make exclusion CONDITIONAL rather than absolute. Avoid words
 * are a tie-breaker for weak pages, not a veto over strong ones. A page that
 * carries hard fundraising evidence (an auction, a sponsorship ladder, a
 * ticketed benefit) is always worth extracting, whatever else it mentions.
 */

/** Hard evidence that a page describes a real fundraising event. */
const STRONG_SIGNALS = [
  "silent auction", "live auction", "online auction", "virtual auction",
  "benefit auction", "auction item", "auction catalog", "paddle raise",
  "fund-a-need", "fund a need",
  "proceeds benefit", "proceeds go to", "proceeds support",
  "sponsorship opportunit", "sponsorship level", "sponsorship package",
  "presenting sponsor", "title sponsor", "underwriter",
  "tax-deductible", "tax deductible", "501(c)(3)", "501c3",
  "benefit dinner", "benefit luncheon", "benefit concert", "benefit gala",
  "charity gala", "annual gala", "gala dinner",
  "fundraising event", "fundraiser", "fundrais",
  "buy a table", "table of ", "reserve a table",
  "golf tournament", "golf classic", "golf outing", "clay shoot", "sporting clays",
];

/** Softer signals — meaningful, but not proof on their own. */
const WEAK_SIGNALS = [
  "gala", "raffle", "drawing", "50/50", "50-50",
  "charity", "charitable", "nonprofit", "non-profit",
  "save the date", "honoree", "luncheon", "banquet",
  "rsvp", "register now", "tickets available", "tickets on sale",
  "purchase tickets", "join us for", "black tie", "black-tie",
  "cocktail attire", "vip table", "bid", "in-kind", "gift certificate",
  "annual dinner", "annual luncheon", "check-in",
];

const DATE_SIGNAL_RE =
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/i;
const PRICE_SIGNAL_RE = /\$\s*\d[\d,]*/;

export interface GateResult {
  pass: boolean;
  /** Why the page passed or failed — surfaced in the run log for tuning. */
  reason:
    | "override_keyword"
    | "strong_signal"
    | "weak_signal_with_date_price"
    | "admin_keyword"
    | "no_signal"
    | "excluded_weak_page";
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * Decide whether `text` warrants AI extraction.
 *
 * Precedence, highest first:
 *   1. Admin override keyword present            → always pass
 *   2. Strong fundraising evidence present       → always pass (avoid list ignored)
 *   3. Admin search keyword, or weak signal plus
 *      a date AND a price on the page            → pass unless an avoid word hits
 *   4. Otherwise                                 → fail
 *
 * The avoid list therefore only ever suppresses pages in category 3 — pages we
 * were unsure about anyway — and can no longer delete a confirmed auction gala
 * because the venue happens to serve wine.
 */
export function evaluateKeywordGate(
  text: string,
  searchKeywords: string[],
  avoidKeywords: string[],
  overrideKeywords: string[]
): GateResult {
  const lower = (text ?? "").toLowerCase();
  if (!lower.trim()) return { pass: false, reason: "no_signal" };

  // 1. Explicit admin override always wins.
  const overrides = overrideKeywords.map((k) => k.toLowerCase()).filter(Boolean);
  if (containsAny(lower, overrides)) {
    return { pass: true, reason: "override_keyword" };
  }

  // 2. Hard fundraising evidence — the avoid list must not veto this.
  if (containsAny(lower, STRONG_SIGNALS)) {
    return { pass: true, reason: "strong_signal" };
  }

  // 3. Weaker evidence, still worth a cheap extraction call.
  const hasAdminSignal = containsAny(lower, searchKeywords.map((k) => k.toLowerCase()).filter(Boolean));
  const hasWeakSignal = containsAny(lower, WEAK_SIGNALS);
  const hasDateAndPrice = DATE_SIGNAL_RE.test(text) && PRICE_SIGNAL_RE.test(text);

  if (hasAdminSignal || (hasWeakSignal && hasDateAndPrice)) {
    const hasAvoid = containsAny(lower, avoidKeywords.map((k) => k.toLowerCase()).filter(Boolean));
    if (hasAvoid) {
      return { pass: false, reason: "excluded_weak_page" };
    }
    return { pass: true, reason: hasAdminSignal ? "admin_keyword" : "weak_signal_with_date_price" };
  }

  return { pass: false, reason: "no_signal" };
}

/** Boolean-only wrapper, preserving the previous call signature. */
export function passesKeywordGate(
  text: string,
  searchKeywords: string[],
  avoidKeywords: string[],
  overrideKeywords: string[]
): boolean {
  return evaluateKeywordGate(text, searchKeywords, avoidKeywords, overrideKeywords).pass;
}
