/**
 * SSRF guard utilities — applied to every outbound URL before the server
 * issues an HTTP request on behalf of user-supplied input.
 *
 * Three layers of protection:
 *   1. Hostname string check  — fast synchronous reject for obvious private hosts
 *   2. DNS resolution check   — resolves A/AAAA and rejects private/loopback IPs
 *   3. Redirect hook          — validates every redirect hop before following it
 */

import { promises as dns } from "dns";

// ── Hostname / IP classification ───────────────────────────────────────────────

/**
 * Returns true when `hostname` (or raw IP string) is a private, loopback,
 * link-local, or otherwise non-public address.  Handles both IPv4 and IPv6.
 */
export function isPrivateHostname(hostname: string): boolean {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, ""); // strip IPv6 brackets

  // ── Friendly hostname aliases ──────────────────────────────────────────────
  if (h === "localhost") return true;

  // ── IPv6 literals — only when the string contains ":" (not a domain name) ─
  if (h.includes(":")) {
    if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;  // loopback
    if (h === "::" || h === "0:0:0:0:0:0:0:0") return true;   // unspecified
    if (h.startsWith("::ffff:")) {
      // IPv4-mapped IPv6 — extract and check the embedded IPv4
      return isPrivateHostname(h.slice(7));
    }
    // ULA (fc00::/7): covers fc00::/8 and fd00::/8
    if (/^f[cd]/i.test(h)) return true;
    // Link-local (fe80::/10)
    if (/^fe[89ab]/i.test(h)) return true;
    // Multicast (ff00::/8)
    if (/^ff/i.test(h)) return true;
    // Anything else that is an IPv6 literal and not clearly global unicast (2000::/3)
    const first16 = parseInt(h.split(":")[0] ?? "0", 16);
    const isGlobalUnicast = first16 >= 0x2000 && first16 <= 0x3fff;
    if (!isGlobalUnicast) return true;
  }

  // ── IPv4 dotted-decimal ────────────────────────────────────────────────────
  const parts = h.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    if (a === 0) return true;                              // 0.0.0.0/8 — "this" network
    if (a === 10) return true;                             // 10.0.0.0/8 — RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true;    // 100.64.0.0/10 — CGNAT
    if (a === 127) return true;                            // 127.0.0.0/8 — loopback
    if (a === 169 && b === 254) return true;               // 169.254.0.0/16 — link-local / AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12 — RFC1918
    if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 — IETF protocol
    if (a === 192 && b === 168) return true;               // 192.168.0.0/16 — RFC1918
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmark
    if (a === 198 && b === 51 && parts[2] === 100) return true; // 198.51.100.0/24 — TEST-NET-2
    if (a === 203 && b === 0 && parts[2] === 113) return true;  // 203.0.113.0/24 — TEST-NET-3
    if (a === 240) return true;                            // 240.0.0.0/4 — reserved
    if (a === 255) return true;                            // 255.255.255.255 — broadcast
  }

  return false;
}

/**
 * Synchronous URL safety check (scheme + hostname string pattern only).
 * Used at ingress (route handlers) to validate user-supplied URLs before
 * storing them.  Does not perform DNS resolution.
 */
export function isSafeUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (isPrivateHostname(parsed.hostname)) return false;
  return true;
}

/**
 * Async DNS resolution check.  Resolves all A/AAAA records for `hostname`
 * and returns false if any resolved address is private/loopback.  Also
 * performs the synchronous hostname-string check first.
 * Rejects (returns false) on DNS failure so that unresolvable hosts are blocked.
 */
export async function resolveHostIsSafe(hostname: string): Promise<boolean> {
  if (isPrivateHostname(hostname)) return false;
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records || records.length === 0) return false;
    return records.every(({ address }) => !isPrivateHostname(address));
  } catch {
    // DNS resolution failure — block the request
    return false;
  }
}

// ── got redirect hook ──────────────────────────────────────────────────────────

/**
 * A `got` `beforeRedirect` hook that aborts the request if the redirect
 * destination is a private/non-public host — validated via both hostname
 * pattern check AND DNS resolution of the redirect target.
 *
 * got supports async `beforeRedirect` hooks, so we can await DNS here.
 *
 * Usage:
 *   got(url, { hooks: ssrfRedirectHook })
 */
export const ssrfRedirectHook = {
  beforeRedirect: [
    async (options: { url?: URL }): Promise<void> => {
      const redirectUrl = options.url?.href ?? "";
      if (!redirectUrl) return;
      let parsed: URL;
      try {
        parsed = new URL(redirectUrl);
      } catch {
        throw new Error(`SSRF guard: malformed redirect URL blocked (${redirectUrl})`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`SSRF guard: non-http redirect blocked (${redirectUrl})`);
      }
      // Synchronous hostname pattern check first (fast path)
      if (isPrivateHostname(parsed.hostname)) {
        throw new Error(`SSRF guard: redirect to non-public host blocked (${redirectUrl})`);
      }
      // DNS resolution check — catches hostnames that look public but resolve to private IPs
      const safe = await resolveHostIsSafe(parsed.hostname);
      if (!safe) {
        throw new Error(`SSRF guard: redirect hostname resolves to non-public address, blocked (${redirectUrl})`);
      }
    },
  ],
};
