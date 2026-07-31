/**
 * URL normalization for user-pasted input.
 *
 * Users paste org website lists straight out of spreadsheets and emails, so
 * entries arrive as `www.haps.org`, `<https://x.org>`, `"y.org",` or
 * `http://WWW.OAKFORESTPTA.COM/`.  Every URL ingress point runs each raw line
 * through `normalizeUrl` first, so only genuinely unusable entries are
 * rejected — and the caller learns exactly which lines failed.
 *
 * Normalization is deliberately conservative: it fixes shape (scheme, host
 * case, wrapping junk) and never rewrites the meaningful part of a URL
 * (path and query case are preserved).
 */

import { isSafeUrl } from "./ssrf";

export type NormalizeResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/** Paired wrappers stripped from around a pasted entry. */
const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ["<", ">"],
  ['"', '"'],
  ["'", "'"],
  ["\u201c", "\u201d"], // “ ”
  ["\u2018", "\u2019"], // ‘ ’
];

/** Characters stripped from the end of a pasted entry (list punctuation). */
const TRAILING_JUNK = /[\s,;>"'\u201d\u2019]+$/;
/** Characters stripped from the start of a pasted entry. */
const LEADING_JUNK = /^[\s<"'\u201c\u2018]+/;

/** Scheme followed by an authority, e.g. `https://`, `FTP://`. */
const AUTHORITY_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\//;
/**
 * Opaque scheme, e.g. `mailto:a@b.com`, `javascript:alert(1)`.
 * The `(?!\d)` guard keeps `example.com:8080/path` from looking like a scheme.
 */
const OPAQUE_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.\-]*):(?!\d)/;

/**
 * Removes control characters, zero-width characters, surrounding whitespace,
 * wrapping brackets/quotes, and trailing list punctuation.
 */
function stripPasteNoise(raw: string): string {
  let s = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim();

  // Repeatedly peel matched wrappers and edge punctuation until stable.
  for (let i = 0; i < 5; i++) {
    const before = s;

    for (const [open, close] of WRAPPERS) {
      if (s.length > open.length + close.length && s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, s.length - close.length);
        break;
      }
    }
    s = s.replace(LEADING_JUNK, "").replace(TRAILING_JUNK, "");

    if (s === before) break;
  }

  return s;
}

/**
 * Turns one raw pasted line into a canonical `http(s)` URL, or explains why
 * it cannot be used.
 *
 * Applied transformations: trim whitespace and wrapping punctuation, default a
 * missing scheme to `https`, lowercase the scheme and hostname, drop a trailing
 * dot on the hostname, drop the fragment, and strip a bare trailing slash on
 * root URLs.  Path and query are otherwise left untouched.
 */
export function normalizeUrl(raw: unknown): NormalizeResult {
  if (typeof raw !== "string") return { ok: false, reason: "not a text value" };

  const cleaned = stripPasteNoise(raw);
  if (!cleaned) return { ok: false, reason: "empty entry" };

  let candidate: string;
  const withAuthority = AUTHORITY_SCHEME.exec(cleaned);
  if (withAuthority) {
    const scheme = withAuthority[1].toLowerCase();
    if (scheme !== "http" && scheme !== "https") {
      return { ok: false, reason: `"${scheme}:" links are not supported — use http or https` };
    }
    candidate = scheme + "://" + cleaned.slice(withAuthority[0].length);
  } else {
    const opaque = OPAQUE_SCHEME.exec(cleaned);
    if (opaque) {
      const scheme = opaque[1].toLowerCase();
      if (scheme !== "http" && scheme !== "https") {
        return { ok: false, reason: `"${scheme}:" links are not supported — use http or https` };
      }
      // Recover a malformed but unambiguous "https:example.org".
      candidate = scheme + "://" + cleaned.slice(opaque[0].length).replace(/^\/+/, "");
    } else {
      candidate = "https://" + cleaned;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: "not a valid web address" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "only http and https addresses are supported" };
  }

  // `URL` already lowercases the scheme and hostname; drop a trailing FQDN dot.
  const host = parsed.hostname.replace(/\.+$/, "");
  if (!host) return { ok: false, reason: "no usable hostname" };
  const isIpv6Literal = host.startsWith("[");
  if (!isIpv6Literal && !host.includes(".")) {
    return { ok: false, reason: `"${host}" is not a usable hostname` };
  }
  parsed.hostname = host;

  parsed.hash = "";

  let out = parsed.toString();
  // Bare root URLs are stored without the implicit trailing slash so that
  // "example.org" and "example.org/" are the same entry.
  if (parsed.pathname === "/" && !parsed.search) {
    out = out.replace(/\/$/, "");
  }

  return { ok: true, url: out };
}

export type UrlProblem = { input: string; reason: string };

export type NormalizedUrlList = {
  /** Canonical URLs, first-occurrence order, exact duplicates removed. */
  urls: string[];
  /** Original entries that could not be used (kept for API back-compat). */
  invalid: string[];
  /** Original entries plus the reason each one failed. */
  problems: UrlProblem[];
};

/**
 * Normalizes a submitted list of URLs.  Blank entries are dropped silently,
 * duplicates that collapse after normalization are removed (keeping the first
 * occurrence), and everything that survives is checked with the existing SSRF
 * guard.
 */
export function normalizeUrlList(rawUrls: readonly unknown[]): NormalizedUrlList {
  const urls: string[] = [];
  const seen = new Set<string>();
  const invalid: string[] = [];
  const problems: UrlProblem[] = [];

  for (const raw of rawUrls) {
    // Blank lines are paste noise, not errors.
    if (typeof raw === "string" && raw.trim() === "") continue;

    const result = normalizeUrl(raw);
    const original = typeof raw === "string" ? raw : String(raw);

    if (!result.ok) {
      invalid.push(original);
      problems.push({ input: original, reason: result.reason });
      continue;
    }

    if (!isSafeUrl(result.url)) {
      invalid.push(original);
      problems.push({ input: original, reason: "private, local, or non-public address" });
      continue;
    }

    if (seen.has(result.url)) continue;
    seen.add(result.url);
    urls.push(result.url);
  }

  return { urls, invalid, problems };
}

const MAX_LISTED_PROBLEMS = 10;

/**
 * Builds the 400 message body: keeps the historical prefix (clients match on
 * it) and appends the specific offending lines so the user can fix them.
 */
export function invalidUrlMessage(problems: readonly UrlProblem[]): string {
  const base = "One or more URLs are not valid public HTTP/HTTPS addresses";
  if (problems.length === 0) return base;

  const listed = problems
    .slice(0, MAX_LISTED_PROBLEMS)
    .map((p) => `"${p.input}" (${p.reason})`)
    .join("; ");
  const overflow = problems.length - MAX_LISTED_PROBLEMS;

  return `${base}: ${listed}${overflow > 0 ? `; and ${overflow} more` : ""}`;
}
