import * as cheerio from "cheerio";
import got from "got";
import { logger } from "../lib/logger";
import { isPrivateHostname, resolveHostIsSafe, ssrfRedirectHook } from "../utils/ssrf";

// ── URL helpers ────────────────────────────────────────────────────────────────

const STATIC_ASSET_EXTENSIONS = [
  ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
  ".mp4", ".mp3", ".mov", ".zip", ".tar", ".gz",
  ".css", ".js", ".woff", ".woff2", ".ttf", ".ico",
];

function isStaticAsset(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return STATIC_ASSET_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

function normalizeForComparison(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    // Lowercase hostname, strip trailing slash from path
    u.hostname = u.hostname.toLowerCase();
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.href;
  } catch {
    return url.toLowerCase();
  }
}

// ── Sitemap parsing ────────────────────────────────────────────────────────────

async function fetchSitemapUrls(
  sitemapUrl: string,
  timeoutMs: number,
  visited = new Set<string>(),
  depth = 0
): Promise<Set<string>> {
  const result = new Set<string>();
  if (depth > 3 || visited.has(sitemapUrl)) return result;
  // Reject sitemaps pointing to private/internal hosts
  try {
    const parsed = new URL(sitemapUrl);
    if (isPrivateHostname(parsed.hostname)) return result;
  } catch {
    return result;
  }
  visited.add(sitemapUrl);

  try {
    const hostname = new URL(sitemapUrl).hostname;
    if (!(await resolveHostIsSafe(hostname))) return result;
    const response = await got(sitemapUrl, {
      timeout: { request: Math.min(timeoutMs, 10_000) },
      headers: { "User-Agent": "Mozilla/5.0 (compatible; EventFinderCoverageBot/1.0)" },
      followRedirect: true,
      hooks: ssrfRedirectHook,
    });

    const $ = cheerio.load(response.body, { xmlMode: true });

    // sitemapindex — recurse into each child sitemap, filtering private hosts
    const childSitemaps: string[] = [];
    $("sitemap loc").each((_, el) => {
      const loc = $(el).text().trim();
      if (!loc) return;
      try {
        const parsed = new URL(loc);
        if (!isPrivateHostname(parsed.hostname)) childSitemaps.push(loc);
      } catch {}
    });

    if (childSitemaps.length > 0) {
      const childResults = await Promise.all(
        childSitemaps.map((u) => fetchSitemapUrls(u, timeoutMs, visited, depth + 1))
      );
      for (const set of childResults) {
        for (const url of set) result.add(url);
      }
      return result;
    }

    // urlset — collect all <loc> entries
    $("url loc").each((_, el) => {
      const loc = $(el).text().trim();
      if (loc && !isStaticAsset(loc)) result.add(normalizeForComparison(loc));
    });
  } catch (err) {
    logger.debug({ err, sitemapUrl }, "Sitemap fetch failed");
  }

  return result;
}

// ── Robots.txt parsing ─────────────────────────────────────────────────────────

async function getSitemapUrlsFromRobots(
  siteUrl: string,
  timeoutMs: number
): Promise<string[]> {
  const sitemapUrls: string[] = [];
  try {
    const robotsUrl = new URL("/robots.txt", siteUrl).href;
    const hostname = new URL(robotsUrl).hostname;
    if (!(await resolveHostIsSafe(hostname))) return sitemapUrls;
    const response = await got(robotsUrl, {
      timeout: { request: Math.min(timeoutMs, 8_000) },
      hooks: ssrfRedirectHook,
    });
    for (const line of response.body.split("\n")) {
      const m = line.match(/^sitemap:\s*(.+)/i);
      if (m) {
        const url = m[1].trim();
        if (!url) continue;
        // Reject sitemap entries pointing to private/internal hosts
        try {
          const parsed = new URL(url);
          if (!isPrivateHostname(parsed.hostname)) sitemapUrls.push(url);
        } catch {}
      }
    }
  } catch {
    // robots.txt is optional
  }
  return sitemapUrls;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface CoverageReconciliation {
  pagesDiscovered: number;
  discoveredUrls: Set<string>;
  missedUrls: string[];
  pagesMissed: number;
  isComplete: boolean;
}

/**
 * Compare what Firecrawl actually crawled against URLs discovered from
 * robots.txt + sitemaps. Returns the set of missed pages.
 */
export async function reconcileCoverage(
  siteUrl: string,
  crawledUrls: Set<string>,
  timeoutMs: number
): Promise<CoverageReconciliation> {
  const discovered = new Set<string>();

  // Seed with what we crawled
  for (const url of crawledUrls) {
    discovered.add(normalizeForComparison(url));
  }

  // Collect sitemap URLs from robots.txt first
  const sitemapSources = await getSitemapUrlsFromRobots(siteUrl, timeoutMs);

  // Always probe the most common sitemap locations as fallback
  const fallbackPaths = ["/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml", "/sitemap.php", "/wp-sitemap.xml"];
  for (const path of fallbackPaths) {
    try {
      const url = new URL(path, siteUrl).href;
      if (!sitemapSources.includes(url)) sitemapSources.push(url);
    } catch {}
  }

  // Deduplicate
  const uniqueSitemaps = [...new Set(sitemapSources)];

  // Fetch all sitemaps concurrently (bounded depth)
  const visited = new Set<string>();
  const results = await Promise.all(
    uniqueSitemaps.map((u) => fetchSitemapUrls(u, timeoutMs, visited))
  );
  for (const set of results) {
    for (const url of set) discovered.add(url);
  }

  // Build normalized crawled set for comparison
  const crawledNorm = new Set<string>();
  for (const url of crawledUrls) crawledNorm.add(normalizeForComparison(url));

  // Compute missed: in discovered but not crawled, skipping static assets
  const missedUrls = [...discovered].filter(
    (url) => !crawledNorm.has(url) && !isStaticAsset(url)
  );

  return {
    pagesDiscovered: discovered.size,
    discoveredUrls: discovered,
    missedUrls,
    pagesMissed: missedUrls.length,
    isComplete: missedUrls.length === 0,
  };
}
