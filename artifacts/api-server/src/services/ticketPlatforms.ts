/**
 * Registry of third-party ticketing / auction / donation platforms.
 *
 * WHY THIS EXISTS: for most nonprofits in this dataset the org's own page says
 * little more than "2026 Gala — buy tickets", and the actual date, venue,
 * ticket price and sponsorship ladder live on an external platform (qGiv,
 * OneCause, GiveButter, DonorPerfect, …). The BFS crawler only follows
 * same-domain links, and several of these hosts are also in the vendor
 * blacklist, so that detail was unreachable — which is why extracted events
 * came back with a name and nothing else.
 *
 * These hosts play two DIFFERENT roles and must not be conflated:
 *
 *   - As a SEED domain they are still rejected. We never want to crawl
 *     OneCause's marketing site and harvest other charities' events.
 *   - As a ONE-HOP ENRICHMENT target, linked from a real nonprofit page we
 *     are already crawling, they are exactly what we want to read.
 *
 * `isTicketPlatformUrl` is the enrichment test. The seed-level blacklist in
 * crawler.ts (DEFAULT_VENDOR_DOMAINS) is unchanged and still applies first.
 */

const TICKET_PLATFORM_HOSTS = [
  // Auction / event fundraising platforms
  "qgiv.com",
  "onecause.com",
  "onecau.se",
  "bidpal.net",
  "givesmart.com",
  "readysetauction.com",
  "silentauctionpro.com",
  "ejoinme.org",
  "auctria.com",
  "32auctions.com",
  "handbid.com",
  "galabid.com",
  "biddingforgood.com",
  "charityauctionstoday.com",
  "betterunite.com",
  "greatergiving.com",
  "accelevents.com",
  "paybee.io",
  // Donation / ticketing platforms
  "givebutter.com",
  "donorperfect.com",
  "donorperfect.net",
  "donorperfect.io",
  "blackbaudhosting.com",
  "blackbaud.com",
  "classy.org",
  "mightycause.com",
  "networkforgood.com",
  "anedot.com",
  "zeffy.com",
  "tickettailor.com",
  "eventbrite.com",
  "runsignup.com",
  "dvforms.net",
  "vbotickets.com",
  "membershiptoolkit.com",
];

/** Matches a host exactly or as a subdomain (never a substring of another TLD). */
function hostMatches(hostname: string, base: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  return h === base || h.endsWith(`.${base}`);
}

/**
 * True when the URL points at a known ticketing/auction platform — i.e. a page
 * worth fetching ONE hop off a nonprofit site to recover pricing and dates.
 */
export function isTicketPlatformUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:") return false;
    return TICKET_PLATFORM_HOSTS.some((base) => hostMatches(hostname, base));
  } catch {
    return false;
  }
}

/** Platform name for logging/debugging, or null when not a platform URL. */
export function ticketPlatformName(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    return TICKET_PLATFORM_HOSTS.find((base) => hostMatches(hostname, base)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Link text / URL fragments that suggest a link leads to ticketing or
 * sponsorship detail. Used to rank candidates when a page links out to several
 * platform URLs, so we spend the enrichment budget on the richest one.
 */
const HIGH_VALUE_HINTS = [
  "ticket", "register", "registration", "sponsor", "sponsorship",
  "table", "buy", "purchase", "rsvp", "attend", "seat", "bid",
];

export function scoreTicketLink(url: string, linkText = ""): number {
  const haystack = `${url} ${linkText}`.toLowerCase();
  let score = 0;
  for (const hint of HIGH_VALUE_HINTS) {
    if (haystack.includes(hint)) score += 1;
  }
  // Sponsorship pages carry the table/underwriting ladder — the highest-value
  // signal for qualifying an event, so weight them above plain ticket links.
  if (haystack.includes("sponsor")) score += 2;
  return score;
}
