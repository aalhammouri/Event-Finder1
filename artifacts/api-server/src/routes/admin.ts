import { Router } from "express";
import { db } from "@workspace/db";
import {
  adminSettingsTable,
  emailRecipientsTable,
  domainBlacklistTable,
  usersTable,
} from "@workspace/db";
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import {
  UpdateAdminSettingsBody,
  CreateEmailRecipientBody,
  UpdateEmailRecipientParams,
  UpdateEmailRecipientBody,
  DeleteEmailRecipientParams,
  AddDomainBlacklistBody,
  DeleteDomainBlacklistParams,
} from "@workspace/api-zod";
import {
  generateActivationToken,
  activationTokenExpiresAt,
  generateResetToken,
  resetTokenExpiresAt,
  getAppBaseUrl,
} from "../utils/auth";
import { sendActivationEmail, getEmailDeliveryStatus } from "../services/emailService";
import { requireAdmin } from "../middleware/auth";
import { reloadScheduler } from "../services/scheduler";
import { normalizeTiers } from "../services/scorer";
import { getAnthropicClient } from "../services/extractor";

const router = Router();

// All routes in this router require admin role
router.use(requireAdmin);

async function getOrCreateSettings() {
  const existing = await db.select().from(adminSettingsTable).limit(1);
  if (existing.length > 0) return existing[0];
  const [created] = await db.insert(adminSettingsTable).values({}).returning();
  return created;
}

function serializeSettings(s: typeof adminSettingsTable.$inferSelect) {
  return {
    searchKeywords: s.searchKeywords,
    avoidKeywords: s.avoidKeywords,
    overrideKeywords: s.overrideKeywords,
    maxPagesPerSite: s.maxPagesPerSite,
    timeoutPerPage: s.timeoutPerPage,
    imageReadingEnabled: s.imageReadingEnabled,
    scoringWeights: s.scoringWeights,
    tiers: normalizeTiers(s.tiers),
    minScoreForEmail: s.minScoreForEmail,
    minEventScore: s.minEventScore,
    scheduleEnabled: s.scheduleEnabled,
    scheduleDays: s.scheduleDays,
    scheduleTime: s.scheduleTime,
    scheduleTimezone: s.scheduleTimezone,
    scheduleFrequency: (s.scheduleFrequency as string) ?? "weekly",
    scheduleMonthDay: s.scheduleMonthDay ?? null,
    scheduleUrlListId: s.scheduleUrlListId ?? null,
    primaryGroup1Label: (s.primaryGroup1Label as string) ?? "2026 Events",
    primaryGroup3Label: (s.primaryGroup3Label as string) ?? "",
    defaultMailingState: (s.defaultMailingState as string) ?? "TX",
    geographicStates: (s.geographicStates as string[]) ?? [],
    maxConcurrentSites: s.maxConcurrentSites ?? 5,
    perDomainDelayMs: s.perDomainDelayMs ?? 1000,
    maxRetries: s.maxRetries ?? 3,
  };
}

// GET /admin/settings
router.get("/admin/settings", async (_req, res) => {
  const settings = await getOrCreateSettings();
  res.json(serializeSettings(settings));
});

// PATCH /admin/settings
router.patch("/admin/settings", async (req, res) => {
  const ScheduleFields = z.object({
    scheduleEnabled: z.boolean().optional(),
    scheduleDays: z.array(z.string()).optional(),
    scheduleTime: z.string().optional(),
    scheduleTimezone: z.string().optional(),
    scheduleFrequency: z.enum(["daily", "weekly", "monthly"]).optional(),
    scheduleMonthDay: z.number().int().min(1).max(31).nullable().optional(),
    scheduleUrlListId: z.number().int().nullable().optional(),
  });

  const ExportFields = z.object({
    primaryGroup1Label: z.string().optional(),
    primaryGroup3Label: z.string().optional(),
    defaultMailingState: z.string().max(2).optional(),
    geographicStates: z.array(z.string()).optional(),
  });

  const PerformanceFields = z.object({
    maxConcurrentSites: z.number().int().min(1).max(50).optional(),
    perDomainDelayMs: z.number().int().min(0).max(60000).optional(),
    maxRetries: z.number().int().min(0).max(10).optional(),
  });

  const parsed = UpdateAdminSettingsBody.safeParse(req.body);
  const scheduleParsed = ScheduleFields.safeParse(req.body);

  const exportParsed = ExportFields.safeParse(req.body);
  const perfParsed = PerformanceFields.safeParse(req.body);
  // All these schemas are all-optional, so a valid partial payload passes every
  // one of them. If ANY fails, a provided field was malformed — reject instead
  // of silently dropping it.
  if (!parsed.success || !scheduleParsed.success || !exportParsed.success || !perfParsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const existing = await getOrCreateSettings();
  const update: Partial<typeof adminSettingsTable.$inferInsert> = {};

  const data = parsed.data as any ?? {};
  if (data.searchKeywords !== undefined) update.searchKeywords = data.searchKeywords;
  if (data.avoidKeywords !== undefined) update.avoidKeywords = data.avoidKeywords;
  if (data.overrideKeywords !== undefined) update.overrideKeywords = data.overrideKeywords;
  if (data.maxPagesPerSite !== undefined) update.maxPagesPerSite = data.maxPagesPerSite;
  if (data.timeoutPerPage !== undefined) update.timeoutPerPage = data.timeoutPerPage;
  if (data.imageReadingEnabled !== undefined) update.imageReadingEnabled = data.imageReadingEnabled;
  if (data.scoringWeights !== undefined) update.scoringWeights = data.scoringWeights;
  if (data.tiers !== undefined) update.tiers = data.tiers;
  if (data.minScoreForEmail !== undefined) update.minScoreForEmail = data.minScoreForEmail;
  if (data.minEventScore !== undefined) update.minEventScore = data.minEventScore;

  const sched = scheduleParsed.data ?? {};
  const schedChanged =
    sched.scheduleEnabled !== undefined || sched.scheduleDays !== undefined ||
    sched.scheduleTime !== undefined || sched.scheduleTimezone !== undefined ||
    sched.scheduleFrequency !== undefined || sched.scheduleMonthDay !== undefined ||
    sched.scheduleUrlListId !== undefined;
  if (sched.scheduleEnabled !== undefined) update.scheduleEnabled = sched.scheduleEnabled;
  if (sched.scheduleDays !== undefined) update.scheduleDays = sched.scheduleDays;
  if (sched.scheduleTime !== undefined) update.scheduleTime = sched.scheduleTime;
  if (sched.scheduleTimezone !== undefined) update.scheduleTimezone = sched.scheduleTimezone;
  if (sched.scheduleFrequency !== undefined) update.scheduleFrequency = sched.scheduleFrequency;
  if (sched.scheduleMonthDay !== undefined) update.scheduleMonthDay = sched.scheduleMonthDay;
  if (sched.scheduleUrlListId !== undefined) update.scheduleUrlListId = sched.scheduleUrlListId;

  const exp = exportParsed.data ?? {};
  if (exp.primaryGroup1Label !== undefined) update.primaryGroup1Label = exp.primaryGroup1Label;
  if (exp.primaryGroup3Label !== undefined) update.primaryGroup3Label = exp.primaryGroup3Label;
  if (exp.defaultMailingState !== undefined) update.defaultMailingState = exp.defaultMailingState;
  if (exp.geographicStates !== undefined) update.geographicStates = exp.geographicStates;

  const perf = perfParsed.data ?? {};
  if (perf.maxConcurrentSites !== undefined) update.maxConcurrentSites = perf.maxConcurrentSites;
  if (perf.perDomainDelayMs !== undefined) update.perDomainDelayMs = perf.perDomainDelayMs;
  if (perf.maxRetries !== undefined) update.maxRetries = perf.maxRetries;

  const [updated] = await db
    .update(adminSettingsTable)
    .set(update)
    .where(eq(adminSettingsTable.id, existing.id))
    .returning();

  if (schedChanged) {
    reloadScheduler().catch((err) => req.log.warn({ err }, "Scheduler reload failed after settings update"));
  }

  res.json(serializeSettings(updated));
});

// ── Email Recipients ──────────────────────────────────────────────────────────

router.get("/admin/email-recipients", async (_req, res) => {
  const rows = await db.select().from(emailRecipientsTable);
  res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
});

router.post("/admin/email-recipients", async (req, res) => {
  const parsed = CreateEmailRecipientBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  const [row] = await db.insert(emailRecipientsTable).values({ email: parsed.data.email }).returning();
  res.status(201).json({ ...row, createdAt: row.createdAt.toISOString() });
});

router.patch("/admin/email-recipients/:id", async (req, res) => {
  const idParsed = UpdateEmailRecipientParams.safeParse({ id: Number(req.params.id) });
  if (!idParsed.success) { res.status(400).json({ error: "Invalid id" }); return; }
  const bodyParsed = UpdateEmailRecipientBody.safeParse(req.body);
  if (!bodyParsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  const update: Partial<typeof emailRecipientsTable.$inferInsert> = {};
  if ((bodyParsed.data as any).email !== undefined) update.email = (bodyParsed.data as any).email;
  if ((bodyParsed.data as any).active !== undefined) update.active = (bodyParsed.data as any).active;
  const [updated] = await db.update(emailRecipientsTable).set(update).where(eq(emailRecipientsTable.id, idParsed.data.id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...updated, createdAt: updated.createdAt.toISOString() });
});

router.delete("/admin/email-recipients/:id", async (req, res) => {
  const parsed = DeleteEmailRecipientParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(emailRecipientsTable).where(eq(emailRecipientsTable.id, parsed.data.id));
  res.status(204).send();
});

// ── Domain Blacklist ──────────────────────────────────────────────────────────

router.get("/admin/domain-blacklist", async (_req, res) => {
  const rows = await db.select().from(domainBlacklistTable);
  res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
});

router.post("/admin/domain-blacklist", async (req, res) => {
  const parsed = AddDomainBlacklistBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  const [row] = await db.insert(domainBlacklistTable).values({ domain: parsed.data.domain }).returning();
  res.status(201).json({ ...row, createdAt: row.createdAt.toISOString() });
});

router.delete("/admin/domain-blacklist/:id", async (req, res) => {
  const parsed = DeleteDomainBlacklistParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(domainBlacklistTable).where(eq(domainBlacklistTable.id, parsed.data.id));
  res.status(204).send();
});

// ── Users ─────────────────────────────────────────────────────────────────────

const CreateUserBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(["admin", "viewer"]).default("viewer"),
});

const UpdateUserBody = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: z.enum(["admin", "viewer"]).optional(),
});

function serializeUser(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    activatedAt: u.activatedAt ? u.activatedAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
  };
}

async function countAdmins(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(usersTable).where(eq(usersTable.role, "admin"));
  return row?.n ?? 0;
}

router.get("/admin/users", async (_req, res) => {
  const rows = await db.select().from(usersTable).orderBy(usersTable.createdAt);
  res.json(rows.map(serializeUser));
});

router.post("/admin/users", async (req, res) => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }

  try {
    const token = generateActivationToken();
    const expiresAt = activationTokenExpiresAt();

    const [row] = await db
      .insert(usersTable)
      .values({ ...parsed.data, activationToken: token, activationTokenExpiresAt: expiresAt })
      .returning();

    const activationUrl = `${getAppBaseUrl()}/activate?token=${token}`;

    const emailSent = await sendActivationEmail(row.email, row.name, activationUrl);

    req.log.info(
      { actingAdmin: req.user?.id, targetUser: row.id, emailSent },
      "Admin created user and issued activation link"
    );

    res.status(201).json({ ...serializeUser(row), activationUrl, emailSent });
  } catch {
    res.status(409).json({ error: "Email already exists" });
  }
});

router.patch("/admin/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }
  const parsed = UpdateUserBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }

  // Guard: never demote the last remaining admin — that would lock everyone out.
  if (parsed.data.role === "viewer") {
    const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
    if (target?.role === "admin" && (await countAdmins()) <= 1) {
      res.status(400).json({ error: "Cannot demote the last remaining admin" });
      return;
    }
  }

  const [updated] = await db.update(usersTable).set(parsed.data).where(eq(usersTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(serializeUser(updated));
});

router.delete("/admin/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  // Guard: never delete the last remaining admin — that would lock everyone out.
  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (target?.role === "admin" && (await countAdmins()) <= 1) {
    res.status(400).json({ error: "Cannot delete the last remaining admin" });
    return;
  }

  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.status(204).send();
});

// POST /admin/users/:id/resend-invite — regenerate activation link (and attempt email)
router.post("/admin/users/:id/resend-invite", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (user.activatedAt) { res.status(400).json({ error: "User is already activated" }); return; }

  const token = generateActivationToken();
  const expiresAt = activationTokenExpiresAt();
  const activationUrl = `${getAppBaseUrl()}/activate?token=${token}`;

  await db
    .update(usersTable)
    .set({ activationToken: token, activationTokenExpiresAt: expiresAt })
    .where(eq(usersTable.id, id));

  const emailSent = await sendActivationEmail(user.email, user.name, activationUrl);

  req.log.info(
    { actingAdmin: req.user?.id, targetUser: id, emailSent },
    "Admin issued activation link"
  );

  res.json({
    message: emailSent
      ? "Invitation email sent — you can also copy the link below."
      : "Email could not be delivered — copy the link below and share it directly.",
    activationUrl,
    emailSent,
  });
});

// POST /admin/users/:id/reset-link — generate a password reset link to share out-of-band
router.post("/admin/users/:id/reset-link", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (!user.activatedAt) {
    res.status(400).json({ error: "User is not activated yet — use the invite link instead" });
    return;
  }

  const token = generateResetToken();
  const expiresAt = resetTokenExpiresAt();
  const resetUrl = `${getAppBaseUrl()}/reset-password?token=${token}`;

  await db
    .update(usersTable)
    .set({ resetToken: token, resetTokenExpiresAt: expiresAt })
    .where(eq(usersTable.id, id));

  req.log.info(
    { actingAdmin: req.user?.id, targetUser: id },
    "Admin issued password reset link"
  );

  res.json({ resetUrl, expiresAt: expiresAt.toISOString() });
});

// GET /admin/email-status — is outgoing email actually deliverable?
router.get("/admin/email-status", async (_req, res) => {
  const status = await getEmailDeliveryStatus();
  res.json(status);
});

// GET /admin/ai-status — is AI configured and reachable?
router.get("/admin/ai-status", async (_req, res) => {
  const configured = !!process.env.ANTHROPIC_API_KEY;
  let reachable = false;
  let error: string | null = null;

  if (configured) {
    try {
      const client = getAnthropicClient()!;
      await client.messages.create({
        model: "claude-opus-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
      reachable = true;
    } catch (err: any) {
      error = err.message ?? String(err);
    }
  }

  res.json({ configured, reachable, model: "claude-opus-5", error });
});

export default router;
