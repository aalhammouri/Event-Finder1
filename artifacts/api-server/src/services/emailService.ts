import { ReplitConnectors } from "@replit/connectors-sdk";
import { logger } from "../lib/logger";

interface EventSummary {
  eventName?: string | null;
  eventDate?: string | null;
  eventVenue?: string | null;
  score: number;
  tier: string;
  eventPageUrl?: string | null;
  orgName?: string | null;
}

interface EmailRunSummary {
  runDate: string;
  listName: string;
  newEvents: EventSummary[];
  updatedEvents: EventSummary[];
}

// Sender address for outgoing email.
// Temporary default uses Resend's built-in `onboarding@resend.dev` sender, which
// works without a verified domain but only DELIVERS to the Resend account owner's
// own email address. Once a domain is verified in Resend (resend.com/domains),
// set RESEND_FROM_EMAIL to e.g. "Event Finder <noreply@gofffinancial.com>" to
// deliver to any recipient — no code change needed.
const DEFAULT_FROM = "Event Finder <onboarding@resend.dev>";
const FROM_ADDRESS = process.env.RESEND_FROM_EMAIL || DEFAULT_FROM;

async function sendViaResend(payload: {
  from: string;
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  // Uses Replit Connectors integration for Resend — handles auth automatically
  const connectors = new ReplitConnectors();
  const response = await connectors.proxy("resend", "/emails", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend API error ${response.status}: ${text}`);
  }
}

// ── Deliverability Status ──────────────────────────────────────────────────────
//
// Email is only actually deliverable to arbitrary recipients when a custom
// sender is configured AND its domain is verified in Resend. The default
// onboarding@resend.dev sender delivers only to the Resend account owner.

export interface EmailDeliveryStatus {
  deliverable: boolean;
  reason: string;
  fromAddress: string;
}

let statusCache: { value: EmailDeliveryStatus; fetchedAt: number } | null = null;
const STATUS_CACHE_TTL_MS = 5 * 60 * 1000;

function extractDomain(address: string): string | null {
  // Handles both "Name <user@domain>" and plain "user@domain"
  const match = address.match(/<([^>]+)>/);
  const email = (match ? match[1] : address).trim();
  const at = email.lastIndexOf("@");
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

export async function getEmailDeliveryStatus(): Promise<EmailDeliveryStatus> {
  if (statusCache && Date.now() - statusCache.fetchedAt < STATUS_CACHE_TTL_MS) {
    return statusCache.value;
  }

  let value: EmailDeliveryStatus;

  if (!process.env.RESEND_FROM_EMAIL) {
    value = {
      deliverable: false,
      reason:
        "No custom sender configured — using Resend's test sender, which only delivers to the Resend account owner. Verify your domain at resend.com/domains, then set RESEND_FROM_EMAIL.",
      fromAddress: FROM_ADDRESS,
    };
  } else {
    const fromDomain = extractDomain(FROM_ADDRESS);
    try {
      const connectors = new ReplitConnectors();
      const response = await connectors.proxy("resend", "/domains", { method: "GET" });
      if (!response.ok) {
        throw new Error(`Resend API error ${response.status}`);
      }
      const body = (await response.json()) as {
        data?: { name?: string; status?: string }[];
      };
      const verified = (body.data ?? []).filter((d) => d.status === "verified");
      const match = verified.some((d) => (d.name ?? "").toLowerCase() === fromDomain);
      value = match
        ? { deliverable: true, reason: "Sender domain is verified.", fromAddress: FROM_ADDRESS }
        : {
            deliverable: false,
            reason: `The sender domain "${fromDomain}" is not verified in Resend. Verify it at resend.com/domains.`,
            fromAddress: FROM_ADDRESS,
          };
    } catch (err) {
      logger.warn({ err }, "Email delivery status check failed");
      return {
        deliverable: false,
        reason: "Could not reach Resend to check domain verification status.",
        fromAddress: FROM_ADDRESS,
      };
    }
  }

  statusCache = { value, fetchedAt: Date.now() };
  return value;
}

// ── Activation Email ───────────────────────────────────────────────────────────

export async function sendActivationEmail(
  to: string,
  name: string,
  activationUrl: string
): Promise<boolean> {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Set up your Event Finder account</title></head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <div style="background: #214292; color: white; padding: 28px; border-radius: 8px 8px 0 0; text-align: center;">
    <h1 style="margin: 0; font-size: 26px;">Event Finder</h1>
    <p style="margin: 8px 0 0; opacity: 0.85; font-size: 14px;">The Goff Financial Group</p>
  </div>

  <div style="background: #fff; border: 1px solid #e5e7eb; border-top: 0; border-radius: 0 0 8px 8px; padding: 32px;">
    <h2 style="margin-top: 0; color: #214292;">Welcome, ${name}!</h2>
    <p style="color: #555; line-height: 1.6;">
      Your Event Finder account has been created. Click the button below to set your password
      and activate your account.
    </p>

    <div style="text-align: center; margin: 32px 0;">
      <a href="${activationUrl}"
         style="display: inline-block; background: #f5a01e; color: white; text-decoration: none;
                padding: 14px 32px; border-radius: 6px; font-weight: bold; font-size: 16px;">
        Set up your account
      </a>
    </div>

    <p style="color: #888; font-size: 13px; line-height: 1.5;">
      This link expires in <strong>7 days</strong>. If you didn't request this, you can safely ignore it.<br>
      Or copy and paste this URL into your browser:<br>
      <span style="color: #214292; word-break: break-all;">${activationUrl}</span>
    </p>
  </div>

  <div style="margin-top: 24px; text-align: center; color: #bbb; font-size: 12px;">
    Sent by Event Finder &middot; The Goff Financial Group
  </div>
</body>
</html>`;

  try {
    await sendViaResend({
      from: FROM_ADDRESS,
      to,
      subject: "Set up your Event Finder account",
      html,
    });
    logger.info({ to }, "Activation email sent");
    return true;
  } catch (err) {
    logger.error({ err, to }, "Failed to send activation email");
    return false;
  }
}

// ── Password Reset Email ─────────────────────────────────────────────────────────

export async function sendPasswordResetEmail(
  to: string,
  name: string,
  resetUrl: string
): Promise<boolean> {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Reset your Event Finder password</title></head>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
  <div style="background: #214292; color: white; padding: 28px; border-radius: 8px 8px 0 0; text-align: center;">
    <h1 style="margin: 0; font-size: 26px;">Event Finder</h1>
    <p style="margin: 8px 0 0; opacity: 0.85; font-size: 14px;">The Goff Financial Group</p>
  </div>

  <div style="background: #fff; border: 1px solid #e5e7eb; border-top: 0; border-radius: 0 0 8px 8px; padding: 32px;">
    <h2 style="margin-top: 0; color: #214292;">Reset your password</h2>
    <p style="color: #555; line-height: 1.6;">
      Hi ${name}, we received a request to reset the password for your Event Finder account.
      Click the button below to choose a new password.
    </p>

    <div style="text-align: center; margin: 32px 0;">
      <a href="${resetUrl}"
         style="display: inline-block; background: #f5a01e; color: white; text-decoration: none;
                padding: 14px 32px; border-radius: 6px; font-weight: bold; font-size: 16px;">
        Reset password
      </a>
    </div>

    <p style="color: #888; font-size: 13px; line-height: 1.5;">
      This link expires in <strong>1 hour</strong>. If you didn't request a password reset, you can safely
      ignore this email — your password will not change.<br>
      Or copy and paste this URL into your browser:<br>
      <span style="color: #214292; word-break: break-all;">${resetUrl}</span>
    </p>
  </div>

  <div style="margin-top: 24px; text-align: center; color: #bbb; font-size: 12px;">
    Sent by Event Finder &middot; The Goff Financial Group
  </div>
</body>
</html>`;

  try {
    await sendViaResend({
      from: FROM_ADDRESS,
      to,
      subject: "Reset your Event Finder password",
      html,
    });
    logger.info({ to }, "Password reset email sent");
    return true;
  } catch (err) {
    logger.error({ err, to }, "Failed to send password reset email");
    return false;
  }
}

// ── Weekly Digest ──────────────────────────────────────────────────────────────

export async function sendWeeklyDigest(
  recipients: string[],
  summary: EmailRunSummary
): Promise<void> {
  const allEvents = [
    ...summary.newEvents.map((e) => ({ ...e, badge: "NEW" })),
    ...summary.updatedEvents.map((e) => ({ ...e, badge: "UPDATED" })),
  ].sort((a, b) => b.score - a.score);

  // Tier names are admin-configurable and the scorer emits "Tier A" / "Tier B",
  // while legacy rows stored bare "A" / "B". Comparing against "A" matched
  // NEITHER for new events, so both sections of every digest rendered empty
  // even when the header counted events. Normalise before grouping.
  const tierRank = (t: string | null | undefined): string =>
    (t ?? "").replace(/^tier\s+/i, "").trim().toUpperCase();
  const tierA = allEvents.filter((e) => tierRank(e.tier) === "A");
  const tierB = allEvents.filter((e) => tierRank(e.tier) === "B");
  const otherTiers = allEvents.filter((e) => !["A", "B"].includes(tierRank(e.tier)));

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Event Finder Weekly Digest</title></head>
<body style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; color: #333;">
  <div style="background: #214292; color: white; padding: 24px; border-radius: 8px 8px 0 0;">
    <h1 style="margin: 0; font-size: 24px;">Event Finder Weekly Digest</h1>
    <p style="margin: 8px 0 0; opacity: 0.8;">${summary.runDate} — ${summary.listName}</p>
  </div>

  <div style="background: #f8f9fa; padding: 20px; border-left: 4px solid #f5a01e;">
    <strong>${summary.newEvents.length} new events</strong> ·
    <strong>${summary.updatedEvents.length} updated events</strong>
  </div>

  ${tierA.length > 0 ? `
  <h2 style="color: #f5a01e; border-bottom: 2px solid #f5a01e; padding-bottom: 8px;">Tier A Events (Score 70+)</h2>
  ${tierA.map(renderEventRow).join("")}
  ` : ""}

  ${tierB.length > 0 ? `
  <h2 style="color: #214292; border-bottom: 2px solid #214292; padding-bottom: 8px;">Tier B Events (Score 45-69)</h2>
  ${tierB.map(renderEventRow).join("")}
  ` : ""}

  ${otherTiers.length > 0 ? `
  <h2 style="color: #64748b; border-bottom: 2px solid #cbd5e1; padding-bottom: 8px;">Other Qualifying Events</h2>
  ${otherTiers.map(renderEventRow).join("")}
  ` : ""}

  <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #eee; color: #999; font-size: 12px;">
    Sent by Event Finder &middot; The Goff Financial Group
  </div>
</body>
</html>`;

  try {
    for (const recipient of recipients) {
      await sendViaResend({
        from: FROM_ADDRESS,
        to: recipient,
        subject: `Event Finder Digest — ${summary.newEvents.length} new events found`,
        html,
      });
    }
    logger.info({ recipients }, "Weekly digest sent");
  } catch (err) {
    logger.error({ err }, "Failed to send weekly digest");
  }
}

function renderEventRow(event: EventSummary & { badge: string }): string {
  return `
  <div style="background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 12px;">
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <h3 style="margin: 0; font-size: 16px;">${event.eventName || "Unnamed Event"}</h3>
      <span style="background: ${event.badge === "NEW" ? "#10b981" : "#f5a01e"}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px;">${event.badge}</span>
    </div>
    <div style="margin-top: 8px; color: #666; font-size: 14px;">
      <div>${event.orgName || ""} ${event.eventDate ? "· " + event.eventDate : ""}</div>
      ${event.eventVenue ? `<div>${event.eventVenue}</div>` : ""}
      <div style="margin-top: 8px;"><strong>Score: ${event.score}</strong> · Tier ${event.tier}</div>
      ${event.eventPageUrl ? `<a href="${event.eventPageUrl}" style="color: #214292; margin-top: 8px; display: block;">View Event Page</a>` : ""}
    </div>
  </div>`;
}
