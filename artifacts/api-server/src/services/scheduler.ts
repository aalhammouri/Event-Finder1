import cron from "node-cron";
import { db } from "@workspace/db";
import {
  urlListsTable,
  urlListItemsTable,
  crawlRunsTable,
  eventsTable,
  emailRecipientsTable,
  adminSettingsTable,
} from "@workspace/db";
import { eq, sql, and, gte } from "drizzle-orm";
import { logger } from "../lib/logger";
import { startCrawlRun } from "../routes/crawlRuns";
import { sendWeeklyDigest } from "./emailService";
import { preflightForRun } from "./preflight";

let activeTask: ReturnType<typeof cron.schedule> | null = null;

const DAY_TO_CRON: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
};

function buildCronExpression(
  frequency: string,
  scheduleTime: string,
  scheduleDays: string[],
  scheduleMonthDay: number | null | undefined
): string {
  const [hourStr = "6", minuteStr = "0"] = scheduleTime.split(":");
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);

  switch (frequency) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "monthly": {
      const monthDay = scheduleMonthDay ?? 1;
      return `${minute} ${hour} ${monthDay} * *`;
    }
    case "weekly":
    default: {
      const days = (scheduleDays.length > 0 ? scheduleDays : ["Monday"])
        .map((d) => DAY_TO_CRON[d.toLowerCase()] ?? 1)
        .join(",");
      return `${minute} ${hour} * * ${days}`;
    }
  }
}

export function initScheduler(): void {
  reloadScheduler().catch((err) => logger.error({ err }, "initScheduler failed"));
}

export async function reloadScheduler(): Promise<void> {
  if (activeTask) {
    activeTask.stop();
    activeTask = null;
  }

  const [settings] = await db.select().from(adminSettingsTable).limit(1);

  if (!settings?.scheduleEnabled) {
    logger.info("Scheduler: disabled, no cron task registered");
    return;
  }

  const freq = (settings.scheduleFrequency as string) ?? "weekly";
  const expr = buildCronExpression(
    freq,
    settings.scheduleTime ?? "06:00",
    (settings.scheduleDays as string[]) ?? ["Monday"],
    settings.scheduleMonthDay as number | null | undefined
  );
  const tz = settings.scheduleTimezone ?? "America/Chicago";

  activeTask = cron.schedule(
    expr,
    async () => {
      logger.info({ expr, tz }, "Starting scheduled crawl");
      await runScheduledJob();
    },
    { timezone: tz }
  );

  // Log the resolved schedule with next fire time for operator visibility
  let nextFire: string | undefined;
  try {
    const nextDate = (activeTask as any).nextDate?.();
    if (nextDate) {
      nextFire = typeof nextDate.toISO === "function"
        ? nextDate.toISO()
        : nextDate instanceof Date
        ? nextDate.toISOString()
        : String(nextDate);
    }
  } catch { /* nextDate not available in this version — omit */ }

  logger.info({ expr, tz, nextFire: nextFire ?? "(unknown)" }, "Scheduler initialized");
}

async function runScheduledJob(): Promise<void> {
  const [settings] = await db.select().from(adminSettingsTable).limit(1);

  if (!settings?.scheduleEnabled) {
    logger.info("Scheduler: schedule is disabled, skipping");
    return;
  }

  let lists: { id: number; name: string }[];
  if (settings.scheduleUrlListId) {
    const [target] = await db
      .select({ id: urlListsTable.id, name: urlListsTable.name })
      .from(urlListsTable)
      .where(eq(urlListsTable.id, settings.scheduleUrlListId))
      .limit(1);
    lists = target ? [target] : [];
    if (!target) {
      logger.warn({ listId: settings.scheduleUrlListId }, "Scheduled list not found, skipping run");
      return;
    }
  } else {
    lists = await db.select({ id: urlListsTable.id, name: urlListsTable.name }).from(urlListsTable);
  }

  for (const list of lists) {
    const items = await db
      .select({ url: urlListItemsTable.url })
      .from(urlListItemsTable)
      .where(eq(urlListItemsTable.urlListId, list.id));

    if (items.length === 0) continue;

    const urls = items.map((i) => i.url);

    // Run preflight — FATAL conditions skip the run; WARNs appear in the log
    const preflight = await preflightForRun(urls);
    if (preflight.fatal) {
      logger.warn({ listId: list.id, reason: preflight.fatal }, "Scheduled run skipped — preflight FATAL");
      continue;
    }

    const [run] = await db
      .insert(crawlRunsTable)
      .values({
        urlListId: list.id,
        status: "pending",
        triggeredBy: "scheduled",
        totalUrls: urls.length,
      })
      .returning();

    try {
      await startCrawlRun(run.id, urls, "scheduled", { preflightWarnings: preflight.warnings });
      logger.info({ runId: run.id, listId: list.id }, "Scheduled crawl run completed");
      await sendDigestForRun(run.id, list.name);
    } catch (err) {
      logger.error({ err, runId: run.id }, "Scheduled crawl run failed");
    }
  }
}

async function sendDigestForRun(runId: number, listName: string): Promise<void> {
  const [settings] = await db.select().from(adminSettingsTable).limit(1);
  const minScore = settings?.minScoreForEmail ?? 45;

  const activeRecipients = await db
    .select({ email: emailRecipientsTable.email })
    .from(emailRecipientsTable)
    .where(eq(emailRecipientsTable.active, true));

  if (activeRecipients.length === 0) return;

  const newEvents = await db
    .select()
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.runId, runId),
        eq(eventsTable.status, "NEW"),
        gte(eventsTable.score, minScore)
      )
    )
    .orderBy(sql`${eventsTable.score} desc`);

  const updatedEvents = await db
    .select()
    .from(eventsTable)
    .where(
      and(
        eq(eventsTable.runId, runId),
        eq(eventsTable.status, "UPDATED"),
        gte(eventsTable.score, minScore)
      )
    )
    .orderBy(sql`${eventsTable.score} desc`);

  if (newEvents.length === 0 && updatedEvents.length === 0) return;

  await sendWeeklyDigest(
    activeRecipients.map((r) => r.email),
    {
      runDate: new Date().toLocaleDateString(),
      listName,
      newEvents: newEvents.map((e) => ({
        eventName: e.eventName,
        eventDate: e.eventDate,
        eventVenue: e.eventVenue,
        score: e.score,
        tier: e.tier,
        eventPageUrl: e.eventPageUrl,
        orgName: e.orgName,
      })),
      updatedEvents: updatedEvents.map((e) => ({
        eventName: e.eventName,
        eventDate: e.eventDate,
        eventVenue: e.eventVenue,
        score: e.score,
        tier: e.tier,
        eventPageUrl: e.eventPageUrl,
        orgName: e.orgName,
      })),
    }
  );
}
