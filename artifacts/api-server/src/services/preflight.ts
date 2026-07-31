import { db } from "@workspace/db";
import { adminSettingsTable } from "@workspace/db";
import { getAnthropicClient } from "./extractor";

export interface PreflightResult {
  /** Non-null = fatal — run cannot produce correct results */
  fatal?: string;
  /** Warnings — run will work but may behave unexpectedly */
  warnings: string[];
}

/**
 * Shared preflight for any crawl-run entry point.
 *
 * FATAL → caller must refuse to start the run (HTTP 400 / scheduler skip).
 * WARN  → prepend as log entries so operators see them at the top of the
 *         Activity Log before any page is crawled.
 */
export async function preflightForRun(urls: string[]): Promise<PreflightResult> {
  const warnings: string[] = [];

  // ── FATAL checks ─────────────────────────────────────────────────────────────

  // AI not configured → every page falls back to regex and produces near-zero events
  if (!getAnthropicClient()) {
    return {
      fatal: "AI not configured — set ANTHROPIC_API_KEY before starting a crawl run",
      warnings,
    };
  }

  // Empty URL list → nothing to crawl
  if (urls.length === 0) {
    return {
      fatal: "URL list is empty — add at least one URL before starting a crawl run",
      warnings,
    };
  }

  // Load settings (nullable — defaults apply when absent)
  let settings: typeof adminSettingsTable.$inferSelect | undefined;
  try {
    const rows = await db.select().from(adminSettingsTable).limit(1);
    settings = rows[0];
  } catch {
    // DB not ready — skip settings checks, they'll surface at runtime
  }

  // Tiers not usable → scorer.sort() throws and fails the entire run
  if (settings) {
    const tiers = settings.tiers;
    if (!Array.isArray(tiers) || tiers.length === 0) {
      return {
        fatal: "admin_settings.tiers is not a usable array — reset scoring tiers in Settings before starting a run",
        warnings,
      };
    }
  }

  // ── WARN checks ──────────────────────────────────────────────────────────────

  if (!process.env.FIRECRAWL_API_KEY) {
    warnings.push(
      "WARN: FIRECRAWL_API_KEY not set — crawl will use fallback got+cheerio (slower, lower coverage quality)"
    );
  }

  if (settings) {
    const avoidKeywords = (settings.avoidKeywords as string[] | null) ?? [];
    if (avoidKeywords.length > 0) {
      warnings.push(
        `WARN: avoid_keywords has ${avoidKeywords.length} term(s): ` +
          `${avoidKeywords.slice(0, 8).join(", ")}${avoidKeywords.length > 8 ? "…" : ""} — ` +
          `these suppress pages that weakly match those terms`
      );
    }

    const geoStates = (settings.geographicStates as string[] | null) ?? [];
    if (geoStates.length > 0) {
      warnings.push(
        `WARN: geographic_states filter active (${geoStates.join(", ")}) — ` +
          `events outside these states will be skipped after AI extraction`
      );
    }

    const minScore = settings.minEventScore ?? 1;
    if (minScore > 0) {
      warnings.push(
        `WARN: minEventScore is ${minScore} — events scoring below this are extracted but not stored`
      );
    }

    if (settings.imageReadingEnabled ?? true) {
      warnings.push(
        "WARN: imageReadingEnabled is true — image vision calls add cost and latency per page"
      );
    }
  }

  return { warnings };
}
