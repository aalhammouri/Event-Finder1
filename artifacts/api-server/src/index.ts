import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

async function runBootPreflight(): Promise<void> {
  const lines: string[] = ["=== Event Finder preflight ==="];
  const fatals: string[] = [];
  const warns: string[] = [];

  // (a) Environment variables
  for (const key of ["ANTHROPIC_API_KEY", "DATABASE_URL", "JWT_SECRET"]) {
    if (!process.env[key]) {
      fatals.push(`  FATAL: ${key} is not set`);
    } else {
      lines.push(`  OK: ${key} is set`);
    }
  }
  if (!process.env.FIRECRAWL_API_KEY) {
    warns.push("  WARN: FIRECRAWL_API_KEY not set — crawl will use fallback got+cheerio");
  } else {
    lines.push("  OK: FIRECRAWL_API_KEY is set");
  }

  // Short-circuit: if required env vars are absent we can't safely reach the DB
  if (fatals.length > 0) {
    for (const f of fatals) lines.push(f);
    for (const w of warns) lines.push(w);
    logger.error(lines.join("\n"));
    process.exit(1);
  }

  // (b) DB schema
  try {
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");

    const orgCheck = await db.execute(
      sql`SELECT EXISTS (
        SELECT 1 FROM information_schema.tables WHERE table_name = 'organizations'
      ) AS exists`
    );
    if (!(orgCheck.rows?.[0] as any)?.exists) {
      warns.push("  WARN: organizations table missing — events will export without linked org data");
    } else {
      lines.push("  OK: organizations table exists");
    }

    const colCheck = await db.execute(
      sql`SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'events' AND column_name = 'organization_id'
      ) AS exists`
    );
    if (!(colCheck.rows?.[0] as any)?.exists) {
      warns.push("  WARN: events.organization_id column missing — CRM export lacks org linkage");
    } else {
      lines.push("  OK: events.organization_id column exists");
    }
  } catch (err) {
    warns.push(`  WARN: DB schema checks skipped — ${String(err)}`);
  }

  // (c) admin_settings
  try {
    const { db } = await import("@workspace/db");
    const { adminSettingsTable } = await import("@workspace/db");
    const [settings] = await db.select().from(adminSettingsTable).limit(1);

    if (!settings) {
      lines.push("  OK: admin_settings — no row yet (defaults apply on first run)");
    } else {
      const avoidKeywords = (settings.avoidKeywords as string[] | null) ?? [];
      if (avoidKeywords.length > 0) {
        warns.push(
          `  WARN: avoid_keywords set (${avoidKeywords.length} terms: ` +
            `${avoidKeywords.slice(0, 5).join(", ")}${avoidKeywords.length > 5 ? "…" : ""}) — ` +
            `suppresses pages weakly matching those terms`
        );
      }

      const geoStates = (settings.geographicStates as string[] | null) ?? [];
      if (geoStates.length > 0) {
        warns.push(
          `  WARN: geographic_states filter active (${geoStates.join(", ")}) — events outside these states skipped`
        );
      }

      const tiers = settings.tiers;
      if (!Array.isArray(tiers) || tiers.length === 0) {
        fatals.push(
          "  FATAL: admin_settings.tiers is not a usable array — reset scoring tiers in Settings before starting any run"
        );
      } else {
        lines.push(`  OK: tiers configured (${tiers.length} tier(s))`);
      }
    }
  } catch (err) {
    warns.push(`  WARN: admin_settings checks skipped — ${String(err)}`);
  }

  // (d) Legacy tier values in events table
  try {
    const { db } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    const result = await db.execute(
      sql`SELECT COUNT(*)::int AS count FROM events WHERE tier IN ('A', 'B', 'C')`
    );
    const count = Number((result.rows?.[0] as any)?.count ?? 0);
    if (count > 0) {
      warns.push(
        `  WARN: ${count} event(s) have legacy tier values ('A','B','C'). ` +
          `Migrate: UPDATE events SET tier = 'Tier ' || tier WHERE tier IN ('A','B','C');`
      );
    }
  } catch {
    // events table may not exist yet — silently skip
  }

  // (e) Deployment target
  const deployTarget =
    process.env.REPL_DEPLOYMENT_TARGET ?? process.env.REPLIT_DEPLOYMENT_TYPE ?? "";
  if (deployTarget && deployTarget !== "autoscale") {
    warns.push(
      `  WARN: deployment target is "${deployTarget}" — recommend "autoscale" for production crawl workloads`
    );
  }

  // Assemble final report
  for (const w of warns) lines.push(w);
  for (const f of fatals) lines.push(f);

  if (fatals.length > 0) {
    logger.error(lines.join("\n"));
    process.exit(1);
  } else {
    logger.info(lines.join("\n"));
  }
}

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Run boot preflight, then proceed with startup tasks in sequence
  runBootPreflight()
    .then(() =>
      import("./services/migrations").then(({ runStartupMigrations }) =>
        runStartupMigrations()
      ).catch((err) => {
        logger.error({ err }, "Failed to run startup migrations");
      })
    )
    .then(() =>
      import("./routes/crawlRuns").then(({ recoverInterruptedRuns }) =>
        recoverInterruptedRuns()
      ).catch((err) => {
        logger.error({ err }, "Failed to recover interrupted runs");
      })
    )
    .then(() =>
      import("./services/scheduler").then(({ initScheduler }) => {
        initScheduler();
      }).catch((err) => {
        logger.error({ err }, "Failed to initialize scheduler");
      })
    )
    .catch((err) => {
      logger.error({ err }, "Boot sequence failed");
    });
});
