import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

/**
 * Versioned startup migrations.
 *
 * How it works:
 *  - On first boot, `ALTER TABLE … ADD COLUMN IF NOT EXISTS` creates the
 *    `migration_version` integer column (default 0).
 *  - Each numbered migration block only runs when the current version is
 *    below its target, then atomically bumps the version.
 *  - Subsequent boots skip migrations whose version has already been applied.
 *  - The column is not (yet) in the Drizzle schema; all access is via raw SQL.
 */
export async function runStartupMigrations(): Promise<void> {
  // Ensure the version-tracking column exists — idempotent, safe on every boot.
  try {
    await db.execute(sql`
      ALTER TABLE admin_settings
        ADD COLUMN IF NOT EXISTS migration_version integer NOT NULL DEFAULT 0
    `);
  } catch (err) {
    logger.warn({ err }, "Startup migration: could not ensure migration_version column");
    return;
  }

  // ── Migration v1: reset legacy filter defaults ───────────────────────────────
  // Before the Claude migration these columns held non-empty defaults
  // ("TX"-only geographic filter, keyword blocklist) that silently discarded
  // valid events.  The schema defaults are now [], but existing rows carry the
  // old values.  This resets them once; subsequent boots are no-ops because
  // the WHERE clause no longer matches.
  try {
    const result = await db.execute(sql`
      UPDATE admin_settings
      SET
        avoid_keywords    = ARRAY[]::text[],
        geographic_states = ARRAY[]::text[],
        migration_version = 1
      WHERE migration_version < 1
    `);
    const rows = Number((result as any).rowCount ?? (result as any).count ?? 0);
    if (rows > 0) {
      logger.info(
        { rows, version: 1 },
        "Startup migration v1 applied: filter arrays reset to empty"
      );
    }
  } catch (err) {
    logger.warn({ err }, "Startup migration v1 failed: filter reset skipped");
  }

  // ── Migration v2: add token_usage column to crawl_runs ────────────────────
  try {
    await db.execute(sql`
      ALTER TABLE crawl_runs
        ADD COLUMN IF NOT EXISTS token_usage jsonb DEFAULT NULL
    `);
    logger.info({ version: 2 }, "Startup migration v2 applied: token_usage column ensured on crawl_runs");
  } catch (err) {
    logger.warn({ err }, "Startup migration v2 failed: token_usage column skipped");
  }
}
