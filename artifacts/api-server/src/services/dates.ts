/**
 * Single source of truth for event-date reasoning.
 *
 * WHY THIS EXISTS: the extraction prompts used to ask the LLM to decide whether
 * an event had already happened ("FUTURE EVENTS ONLY ... return relevant=false").
 * The model was never told today's date, so it answered from its training
 * cutoff and discarded real upcoming events before they ever reached the
 * database. Date reasoning is arithmetic, not judgement — it belongs in code.
 *
 * The LLM's only job now is to copy the date string as written on the page.
 * Everything below turns that string into a real calendar date.
 */

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2,
  april: 3, apr: 3, may: 4, june: 5, jun: 5, july: 6, jul: 6,
  august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9,
  november: 10, nov: 10, december: 11, dec: 11,
};

export interface ParsedEventDate {
  /** Normalized YYYY-MM-DD, or null when the string carried no usable date. */
  iso: string | null;
  /** True only when we parsed a date AND it is strictly before today. */
  isPast: boolean;
  /** Weeks from now until the event; null when unparseable. Negative = past. */
  weeksAway: number | null;
  /** True when the year had to be inferred rather than read from the text. */
  yearInferred: boolean;
}

const UNPARSEABLE: ParsedEventDate = { iso: null, isPast: false, weeksAway: null, yearInferred: false };

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function toIso(year: number, monthIndex: number, day: number): string | null {
  if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null;
  const d = new Date(year, monthIndex, day);
  // Reject impossible dates that JS would silently roll over (e.g. Feb 31)
  if (d.getFullYear() !== year || d.getMonth() !== monthIndex || d.getDate() !== day) return null;
  const mm = String(monthIndex + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Parses the loose date strings that appear on event pages.
 * Handles: "2026-10-03", "October 3, 2026", "Sat, October 3rd 2026",
 * "10/3/2026", "10/3/26", and bare "October 3" (year inferred forward).
 *
 * Ranges like "September 4-5, 2026" resolve to the FIRST day.
 */
export function parseEventDate(raw: string | null | undefined, now: Date = new Date()): ParsedEventDate {
  if (!raw) return UNPARSEABLE;
  const text = String(raw).trim();
  if (!text) return UNPARSEABLE;

  const lower = text.toLowerCase();
  let iso: string | null = null;
  let yearInferred = false;

  // 1. ISO-ish: 2026-10-03 (also matches the front of a full ISO timestamp)
  const isoMatch = lower.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    iso = toIso(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
  }

  // 2. Month-name forms: "October 3, 2026" / "3 October 2026" / "Oct 3"
  if (!iso) {
    const monthNames = Object.keys(MONTHS).join("|");
    // Month first: October 3[rd][, ] 2026
    const mFirst = lower.match(
      new RegExp(`\\b(${monthNames})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*[-–—]\\s*\\d{1,2}(?:st|nd|rd|th)?)?(?:\\s*,)?\\s*(\\d{4})?`)
    );
    // Day first: 3 October 2026
    const dFirst = !mFirst
      ? lower.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})\\b\\.?(?:\\s*,)?\\s*(\\d{4})?`))
      : null;

    if (mFirst) {
      const monthIndex = MONTHS[mFirst[1]];
      const day = Number(mFirst[2]);
      let year = mFirst[3] ? Number(mFirst[3]) : NaN;
      if (Number.isNaN(year)) { year = inferYear(monthIndex, day, now); yearInferred = true; }
      iso = toIso(year, monthIndex, day);
    } else if (dFirst) {
      const day = Number(dFirst[1]);
      const monthIndex = MONTHS[dFirst[2]];
      let year = dFirst[3] ? Number(dFirst[3]) : NaN;
      if (Number.isNaN(year)) { year = inferYear(monthIndex, day, now); yearInferred = true; }
      iso = toIso(year, monthIndex, day);
    }
  }

  // 3. Numeric slash/dot forms: 10/3/2026, 10-3-26 (US month-first convention)
  if (!iso) {
    const numeric = lower.match(/\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/);
    if (numeric) {
      const monthIndex = Number(numeric[1]) - 1;
      const day = Number(numeric[2]);
      let year: number;
      if (numeric[3]) {
        const y = Number(numeric[3]);
        year = y < 100 ? 2000 + y : y;
      } else {
        year = inferYear(monthIndex, day, now);
        yearInferred = true;
      }
      iso = toIso(year, monthIndex, day);
    }
  }

  if (!iso) return UNPARSEABLE;

  const eventDay = startOfDay(new Date(`${iso}T00:00:00`));
  const today = startOfDay(now);
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;

  return {
    iso,
    // An event happening TODAY is not past — compare whole days.
    isPast: eventDay.getTime() < today.getTime(),
    weeksAway: (eventDay.getTime() - today.getTime()) / msPerWeek,
    yearInferred,
  };
}

/**
 * For a date with no year written on the page, choose the next occurrence:
 * this year if it hasn't happened yet, otherwise next year. Nonprofit sites
 * routinely publish "October 3" for an event that is months away.
 */
function inferYear(monthIndex: number, day: number, now: Date): number {
  const thisYear = now.getFullYear();
  const candidate = new Date(thisYear, monthIndex, day);
  return startOfDay(candidate).getTime() < startOfDay(now).getTime() ? thisYear + 1 : thisYear;
}

/** Convenience wrapper used by the scorer and the crawler. */
export function isEventPast(raw: string | null | undefined, now: Date = new Date()): boolean {
  return parseEventDate(raw, now).isPast;
}

/** Weeks until the event; null when the date could not be parsed. */
export function weeksUntilEvent(raw: string | null | undefined, now: Date = new Date()): number | null {
  return parseEventDate(raw, now).weeksAway;
}

/** Human-readable current date, injected into LLM prompts as grounding. */
export function todayForPrompt(now: Date = new Date()): string {
  return now.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}
