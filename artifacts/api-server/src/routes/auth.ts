import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, emailRecipientsTable } from "@workspace/db";
import { eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  hashPassword,
  verifyPassword,
  generateActivationToken,
  activationTokenExpiresAt,
  generateResetToken,
  resetTokenExpiresAt,
  signJwt,
  getAppBaseUrl,
} from "../utils/auth";
import { sendActivationEmail, sendPasswordResetEmail } from "../services/emailService";

const router = Router();

const RegisterBody = z.object({
  email: z.string().email(),
});

const ActivateBody = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const ResendBody = z.object({
  email: z.string().email(),
});

// One-time admin bootstrap: if the users table has NO admin at all, promote
// this user. Prevents a fresh (or wiped) deployment from being stuck with
// zero admins and nobody able to manage accounts. Note: under READ COMMITTED,
// two concurrent first logins could both pass the NOT EXISTS check and both
// get promoted — benign, since both are password-verified internal users.
async function bootstrapAdminIfNone(userId: number): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE users SET role = 'admin'
    WHERE id = ${userId}
      AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}

// POST /auth/register — @gofffinancial.com self-registration
router.post("/auth/register", async (req, res) => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const { email } = parsed.data;

  if (!email.toLowerCase().endsWith("@gofffinancial.com")) {
    res.status(403).json({ error: "Only @gofffinancial.com addresses may self-register" });
    return;
  }

  try {
    const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);

    if (existing.length > 0 && existing[0].activatedAt) {
      res.status(409).json({ error: "This email is already registered and activated. Please log in." });
      return;
    }

    const token = generateActivationToken();
    const expiresAt = activationTokenExpiresAt();
    const activationUrl = `${getAppBaseUrl()}/activate?token=${token}`;

    let user;
    if (existing.length > 0) {
      // Reuse existing pending user — refresh the token
      [user] = await db
        .update(usersTable)
        .set({ activationToken: token, activationTokenExpiresAt: expiresAt })
        .where(eq(usersTable.id, existing[0].id))
        .returning();
    } else {
      const name = email.split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      [user] = await db
        .insert(usersTable)
        .values({ email, name, role: "viewer", activationToken: token, activationTokenExpiresAt: expiresAt })
        .returning();
    }

    await sendActivationEmail(user.email, user.name, activationUrl);

    res.status(200).json({ message: "Check your email for an activation link." });
  } catch (err) {
    req.log.error({ err }, "register error");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /auth/activate — set password, activate account
router.post("/auth/activate", async (req, res) => {
  const parsed = ActivateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input — password must be at least 8 characters" });
    return;
  }

  const { token, password } = parsed.data;

  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.activationToken, token))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "Invalid activation link" });
      return;
    }

    if (user.activationTokenExpiresAt && user.activationTokenExpiresAt < new Date()) {
      res.status(410).json({ error: "This activation link has expired. Please request a new one." });
      return;
    }

    const passwordHash = await hashPassword(password);
    const now = new Date();

    const [activated] = await db
      .update(usersTable)
      .set({
        passwordHash,
        activatedAt: now,
        activationToken: null,
        activationTokenExpiresAt: null,
      })
      .where(eq(usersTable.id, user.id))
      .returning();

    // Upsert into email_recipients for weekly digest
    await db
      .insert(emailRecipientsTable)
      .values({ email: activated.email })
      .onConflictDoNothing();

    let role = activated.role;
    if (role !== "admin" && (await bootstrapAdminIfNone(activated.id))) {
      role = "admin";
      req.log.info({ userId: activated.id }, "Admin bootstrap: first user promoted to admin on activation");
    }

    const jwt = await signJwt({
      id: activated.id,
      email: activated.email,
      name: activated.name,
      role,
    });

    res.json({
      token: jwt,
      user: {
        id: activated.id,
        email: activated.email,
        name: activated.name,
        role,
      },
    });
  } catch (err) {
    req.log.error({ err }, "activate error");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /auth/login
router.post("/auth/login", async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const { email, password } = parsed.data;

  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);

    if (!user || !user.activatedAt || !user.passwordHash) {
      res.status(401).json({ error: "Invalid email or password, or account not yet activated" });
      return;
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    let role = user.role;
    if (role !== "admin" && (await bootstrapAdminIfNone(user.id))) {
      role = "admin";
      req.log.info({ userId: user.id }, "Admin bootstrap: first user promoted to admin on login");
    }

    const jwt = await signJwt({
      id: user.id,
      email: user.email,
      name: user.name,
      role,
    });

    res.json({
      token: jwt,
      user: { id: user.id, email: user.email, name: user.name, role },
    });
  } catch (err) {
    req.log.error({ err }, "login error");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /auth/resend — resend activation email for an unactivated user
router.post("/auth/resend", async (req, res) => {
  const parsed = ResendBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const { email } = parsed.data;

  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);

    if (!user || user.activatedAt) {
      // Don't leak whether email exists
      res.json({ message: "If that email is registered and pending, you will receive a new activation link." });
      return;
    }

    const token = generateActivationToken();
    const expiresAt = activationTokenExpiresAt();
    const activationUrl = `${getAppBaseUrl()}/activate?token=${token}`;

    await db
      .update(usersTable)
      .set({ activationToken: token, activationTokenExpiresAt: expiresAt })
      .where(eq(usersTable.id, user.id));

    await sendActivationEmail(user.email, user.name, activationUrl);

    res.json({ message: "If that email is registered and pending, you will receive a new activation link." });
  } catch (err) {
    req.log.error({ err }, "resend error");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /auth/forgot-password — send a password reset link
router.post("/auth/forgot-password", async (req, res) => {
  const parsed = ResendBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const { email } = parsed.data;
  // Generic message regardless of outcome — don't leak which emails exist.
  const message = "If that email is registered, you'll receive a password reset link shortly.";

  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);

    // Only activated accounts (those with a password) can reset.
    if (!user || !user.activatedAt) {
      res.json({ message });
      return;
    }

    const token = generateResetToken();
    const expiresAt = resetTokenExpiresAt();
    const resetUrl = `${getAppBaseUrl()}/reset-password?token=${token}`;

    await db
      .update(usersTable)
      .set({ resetToken: token, resetTokenExpiresAt: expiresAt })
      .where(eq(usersTable.id, user.id));

    await sendPasswordResetEmail(user.email, user.name, resetUrl);

    res.json({ message });
  } catch (err) {
    req.log.error({ err }, "forgot-password error");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /auth/reset-password — set a new password using a reset token
router.post("/auth/reset-password", async (req, res) => {
  const parsed = ActivateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input — password must be at least 8 characters" });
    return;
  }

  const { token, password } = parsed.data;

  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.resetToken, token))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "Invalid or already-used reset link" });
      return;
    }

    if (!user.resetTokenExpiresAt || user.resetTokenExpiresAt < new Date()) {
      res.status(410).json({ error: "This reset link has expired. Please request a new one." });
      return;
    }

    const passwordHash = await hashPassword(password);

    const [updated] = await db
      .update(usersTable)
      .set({
        passwordHash,
        resetToken: null,
        resetTokenExpiresAt: null,
        // Safety net: a reset always leaves the account activated.
        activatedAt: user.activatedAt ?? new Date(),
      })
      .where(eq(usersTable.id, user.id))
      .returning();

    const jwt = await signJwt({
      id: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
    });

    res.json({
      token: jwt,
      user: { id: updated.id, email: updated.email, name: updated.name, role: updated.role },
    });
  } catch (err) {
    req.log.error({ err }, "reset-password error");
    res.status(500).json({ error: "Server error" });
  }
});

// POST /auth/change-password — authenticated user changes their own password
router.post("/auth/change-password", async (req, res) => {
  const ChangeBody = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
  });
  const parsed = ChangeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input — new password must be at least 8 characters" });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const { verifyJwt } = await import("../utils/auth");
    const payload = await verifyJwt(authHeader.slice(7));

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, payload.id))
      .limit(1);

    if (!user || !user.passwordHash) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const valid = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const newHash = await hashPassword(parsed.data.newPassword);
    await db
      .update(usersTable)
      .set({ passwordHash: newHash })
      .where(eq(usersTable.id, user.id));

    res.json({ message: "Password updated" });
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
});

// GET /auth/me — return current user (used by frontend to rehydrate session)
router.get("/auth/me", async (req, res) => {
  // This is mounted on the public router, but we manually check the token
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const { verifyJwt } = await import("../utils/auth");
    const payload = await verifyJwt(authHeader.slice(7));

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, payload.id))
      .limit(1);

    if (!user || !user.activatedAt) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    res.json({ id: user.id, email: user.email, name: user.name, role: user.role });
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
});

export default router;
