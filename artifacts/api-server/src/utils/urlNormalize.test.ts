import test from "node:test";
import assert from "node:assert/strict";

import { normalizeUrl, normalizeUrlList, invalidUrlMessage } from "./urlNormalize";

function expectUrl(input: string, expected: string): void {
  const result = normalizeUrl(input);
  assert.equal(result.ok, true, `expected "${input}" to normalize, got: ${JSON.stringify(result)}`);
  assert.equal(result.ok && result.url, expected);
}

function expectRejected(input: string): string {
  const result = normalizeUrl(input);
  assert.equal(result.ok, false, `expected "${input}" to be rejected`);
  return result.ok ? "" : result.reason;
}

test("adds a default https scheme to scheme-less hosts", () => {
  expectUrl("www.haps.org", "https://www.haps.org");
  expectUrl("avda-tx.org", "https://avda-tx.org");
  expectUrl("bgcgh.org", "https://bgcgh.org");
  expectUrl("example.org/events/gala", "https://example.org/events/gala");
});

test("lowercases scheme and host but preserves path and query case", () => {
  expectUrl("http://WWW.OAKFORESTPTA.COM", "http://www.oakforestpta.com");
  expectUrl("HTTPS://Example.ORG/Events?Tab=Gala", "https://example.org/Events?Tab=Gala");
});

test("strips a bare trailing slash on root URLs only", () => {
  expectUrl("https://example.org/", "https://example.org");
  expectUrl("example.org/", "https://example.org");
  expectUrl("https://example.org/events/", "https://example.org/events/");
});

test("drops fragments and trailing hostname dots", () => {
  expectUrl("https://example.org/events#schedule", "https://example.org/events");
  expectUrl("https://example.org.", "https://example.org");
});

test("handles paste noise: whitespace, wrapping brackets/quotes, trailing punctuation", () => {
  expectUrl("   www.haps.org  ", "https://www.haps.org");
  expectUrl("<https://example.org>", "https://example.org");
  expectUrl('"example.org",', "https://example.org");
  expectUrl("'example.org';", "https://example.org");
  expectUrl("\u201cexample.org\u201d", "https://example.org");
  expectUrl("example.org\u200b", "https://example.org");
});

test("keeps explicit ports and does not mistake them for a scheme", () => {
  expectUrl("example.org:8080/events", "https://example.org:8080/events");
});

test("rejects non-http schemes", () => {
  assert.match(expectRejected("ftp://files.example.org"), /ftp/);
  assert.match(expectRejected("javascript:alert(1)"), /javascript/);
  assert.match(expectRejected("mailto:info@example.org"), /mailto/);
  assert.match(expectRejected("data:text/html,<h1>hi</h1>"), /data/);
});

test("rejects entries with no usable hostname", () => {
  expectRejected("");
  expectRejected("   ");
  expectRejected("not a url at all");
  assert.match(expectRejected("localhost"), /usable hostname/);
  assert.match(expectRejected("intranet"), /usable hostname/);
});

test("normalizes IP literals and localhost forms (safety filtering happens later)", () => {
  expectUrl("127.0.0.1", "https://127.0.0.1");
  expectUrl("http://169.254.169.254/latest/meta-data", "http://169.254.169.254/latest/meta-data");
  expectRejected("http://localhost:3000");
});

test("normalizeUrlList blocks private, loopback, and metadata addresses", () => {
  const result = normalizeUrlList([
    "http://localhost:3000",
    "127.0.0.1",
    "http://169.254.169.254/latest/meta-data",
    "10.0.0.5/admin",
    "http://[::1]/",
  ]);
  assert.deepEqual(result.urls, []);
  assert.equal(result.problems.length, 5);
});

test("normalizeUrlList collapses duplicates that only differ by shape", () => {
  const result = normalizeUrlList([
    "www.haps.org",
    "https://www.haps.org",
    "HTTPS://WWW.HAPS.ORG/",
    " www.haps.org, ",
    "haps.org",
  ]);
  // "haps.org" is a different host from "www.haps.org" and is kept.
  assert.deepEqual(result.urls, ["https://www.haps.org", "https://haps.org"]);
  assert.deepEqual(result.problems, []);
});

test("normalizeUrlList drops blank lines silently and preserves first-occurrence order", () => {
  const result = normalizeUrlList(["", "  ", "b.org", "", "a.org", "b.org"]);
  assert.deepEqual(result.urls, ["https://b.org", "https://a.org"]);
  assert.deepEqual(result.invalid, []);
});

test("normalizeUrlList reports each bad entry with its original text", () => {
  const result = normalizeUrlList(["www.haps.org", "ftp://x.example.org", "not a url"]);
  assert.deepEqual(result.urls, ["https://www.haps.org"]);
  assert.deepEqual(result.invalid, ["ftp://x.example.org", "not a url"]);
  assert.deepEqual(
    result.problems.map((p) => p.input),
    ["ftp://x.example.org", "not a url"],
  );
});

test("invalidUrlMessage names the offending lines and keeps the legacy prefix", () => {
  const message = invalidUrlMessage([
    { input: "ftp://x.example.org", reason: '"ftp:" links are not supported — use http or https' },
    { input: "localhost", reason: '"localhost" is not a usable hostname' },
  ]);
  assert.match(message, /^One or more URLs are not valid public HTTP\/HTTPS addresses/);
  assert.match(message, /ftp:\/\/x\.example\.org/);
  assert.match(message, /localhost/);
});

test("invalidUrlMessage truncates very long problem lists", () => {
  const problems = Array.from({ length: 14 }, (_, i) => ({ input: `bad-${i}`, reason: "nope" }));
  const message = invalidUrlMessage(problems);
  assert.match(message, /and 4 more$/);
});
