/**
 * Light client-side mirror of the server's URL normalization.
 *
 * The server is the source of truth (it also runs the SSRF checks and returns
 * the canonical form), but cleaning up here means the obvious paste noise never
 * reaches the API and the textarea round-trips predictably.
 */

const LEADING_JUNK = /^[\s<"'\u201c\u2018]+/;
const TRAILING_JUNK = /[\s,;>"'\u201d\u2019]+$/;
const AUTHORITY_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\//;
const OPAQUE_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.\-]*:(?!\d)/;

/** Trims whitespace, wrapping punctuation, and defaults a missing scheme to https. */
export function cleanUrlEntry(raw: string): string {
  const cleaned = raw
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim()
    .replace(LEADING_JUNK, "")
    .replace(TRAILING_JUNK, "");

  if (!cleaned) return "";
  // Leave anything with an explicit scheme alone — the server decides whether
  // it is usable and reports the specific line if it is not.
  if (AUTHORITY_SCHEME.test(cleaned) || OPAQUE_SCHEME.test(cleaned)) return cleaned;
  return `https://${cleaned}`;
}

/** Splits textarea contents into cleaned, non-empty URL entries. */
export function parseUrlTextarea(text: string): string[] {
  return text
    .split("\n")
    .map(cleanUrlEntry)
    .filter((u) => u.length > 0);
}
