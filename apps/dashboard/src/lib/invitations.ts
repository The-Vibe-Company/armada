/**
 * Organization invitations (#641), as the dashboard shows them: the admin who invites, resends and revokes, and the
 * person who accepts. The Armada server owns the invitation (#640, control API v1): five authenticated POSTs under
 * `/api/v1/org/invitations/`. The dashboard never writes an invitation or a membership itself.
 *
 * The answers are parsed here, field by field, into what the pages show. The wire types themselves come from
 * `@armada/core` once #640 is merged; this file does not redeclare them.
 */

export type InviteRole = "member" | "admin";
export const INVITE_ROLES: readonly InviteRole[] = ["member", "admin"];
export const isInviteRole = (value: unknown): value is InviteRole => value === "member" || value === "admin";

/**
 * The server's delivery state. `sent` means the mail service accepted the message, not that it reached the inbox;
 * `not_configured` means this server has no mail transport, so nothing was sent.
 */
export type DeliveryState = "not_configured" | "pending" | "sent" | "failed";
const DELIVERY: readonly DeliveryState[] = ["not_configured", "pending", "sent", "failed"];

export type InvitationStatus = "pending" | "accepted" | "revoked";
const STATUS: readonly InvitationStatus[] = ["pending", "accepted", "revoked"];

/** One invitation as the admin's list shows it. */
export type InvitationView = {
  id: string;
  orgId: string;
  email: string;
  role: InviteRole;
  /** ISO 8601. */
  expiresAt: string;
  status: InvitationStatus;
  delivery: DeliveryState;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An invitation from the server, or null when the answer is not one. Extra fields are dropped. */
export function parseInvitation(value: unknown): InvitationView | null {
  if (!isRecord(value)) return null;
  const { id, orgId, email, role, expiresAt, status, delivery } = value;
  if (typeof id !== "string" || typeof orgId !== "string" || typeof email !== "string") return null;
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;
  if (!isInviteRole(role)) return null;
  if (!STATUS.includes(status as InvitationStatus) || !DELIVERY.includes(delivery as DeliveryState)) return null;
  return {
    id,
    orgId,
    email,
    role,
    expiresAt,
    status: status as InvitationStatus,
    delivery: delivery as DeliveryState,
  };
}

/** The invitations the admin can still act on: pending, of this org, not past their expiry. Soonest to expire first. */
export function pendingInvitations(list: unknown, org: string, now: Date): InvitationView[] | null {
  if (!Array.isArray(list)) return null;
  return list
    .map(parseInvitation)
    .filter(
      (row): row is InvitationView =>
        row !== null && row.orgId === org && row.status === "pending" && Date.parse(row.expiresAt) > now.getTime(),
    )
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
}

const MAX_EMAIL = 254;
// One `@`, a dot-separated domain with a top-level label of two letters or more: a full address, not `bob@corp`.
const FULL_EMAIL = /^[^\s@]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/** The address an admin typed, trimmed and lowercased, or null when it is not one full email address. */
export function normalizeInviteEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL) return null;
  return FULL_EMAIL.test(email) ? email : null;
}

export type Tone = "neutral" | "success" | "warning" | "danger";

/** The delivery badge: never "sent" for a message the mail service did not accept. */
export function deliveryLabel(delivery: DeliveryState): { label: string; tone: Tone; hint: string } {
  switch (delivery) {
    case "not_configured":
      return {
        label: "Email off",
        tone: "danger",
        hint: "This Armada server cannot send email, so no invitation email was sent.",
      };
    case "pending":
      return { label: "Sending", tone: "warning", hint: "The email is not handed to the mail service yet." };
    case "sent":
      return {
        label: "Sent",
        tone: "success",
        hint: "The mail service accepted the email. Delivery to the inbox is not confirmed.",
      };
    case "failed":
      return { label: "Not sent", tone: "danger", hint: "The mail service refused the email. Resend it." };
  }
}

/**
 * The result of an invite or a resend, in one sentence. Only `sent` is a plain success: an invitation whose email
 * did not leave is reported as a failure the admin acts on, even though the invitation itself exists.
 */
export function deliveryOutcome(
  invitation: InvitationView,
  verb: "Invited" | "Resent",
): { ok: true; message: string } | { ok: false; error: string } {
  const who = invitation.email;
  switch (invitation.delivery) {
    case "sent":
      return {
        ok: true,
        message: verb === "Invited" ? `Invitation emailed to ${who}.` : `Invitation emailed to ${who} again.`,
      };
    case "pending":
      return { ok: true, message: `Invitation to ${who} saved. Its email is still being sent.` };
    case "failed":
      return { ok: false, error: `Invitation to ${who} saved, but its email was refused. Resend it.` };
    case "not_configured":
      return {
        ok: false,
        error: `Invitation to ${who} saved, but this server cannot send email. Ask your Armada operator to set up email, then resend it.`,
      };
  }
}

/** "Expires in 3 days", "Expires today", "Expired": coarse on purpose, the list stays compact. */
export function expiryLabel(expiresAt: string, now: Date): string {
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) return "";
  const ms = end - now.getTime();
  if (ms <= 0) return "Expired";
  const hours = ms / 3_600_000;
  if (hours < 24) return "Expires today";
  const days = Math.round(hours / 24);
  return days === 1 ? "Expires tomorrow" : `Expires in ${days} days`;
}

/**
 * Why an acceptance failed, from the server's status, for the recipient: what to do next. The server's own message
 * is shown for a conflict (already a member, used, too many tries), where it is the most precise.
 */
export type AcceptFailure = {
  kind: "invalid" | "session" | "wrong_account" | "gone" | "conflict" | "unavailable";
  message: string;
};

export function acceptFailure(status: number | undefined, serverMessage: string | undefined): AcceptFailure {
  switch (status) {
    case 400:
      return { kind: "invalid", message: "This invitation link is incomplete. Open the link from the email again." };
    case 401:
      return { kind: "session", message: "Your session ended. Sign in again, then accept." };
    case 403:
      return {
        kind: "wrong_account",
        message:
          "This invitation is for another email address, or your address is not verified. Sign in with the invited address.",
      };
    case 404:
      return {
        kind: "gone",
        message:
          "This invitation is no longer valid: it expired, was revoked, was already used or was replaced by a newer email. Ask an admin to resend it.",
      };
    case 409:
      return { kind: "conflict", message: serverMessage?.trim() || "This invitation cannot be accepted right now." };
    default:
      return { kind: "unavailable", message: "Armada could not accept the invitation right now. Try again shortly." };
  }
}

/**
 * The invitation link (`/invitations/accept?token=…`) as the email sends it. The token is moved into a short-lived,
 * HTTP-only cookie on the first request, and the address bar loses it: it never travels in a login `next`, a Referer,
 * the history or a page. Only the explicit accept reads it, server-side, and a successful one deletes it. The cookie's
 * path is `/`: signing in with a code is a server action on `/login` that renders the invitation page within that
 * same request, so a cookie scoped to the invitation path would not be there.
 */
export const INVITATION_ACCEPT_PATH = "/invitations/accept";
export const INVITATION_COOKIE = "armada_invitation";
/** Long enough to sign in with an emailed code; the invitation's own expiry still applies on the server. */
export const INVITATION_COOKIE_MAX_AGE = 60 * 60;

/** A token as a cookie may carry it: URL-safe characters only, bounded. Anything else is dropped, not stored. */
export function isInvitationToken(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{16,512}$/.test(value);
}

export const invitationCookieOptions = (secure: boolean) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure,
  path: "/",
  maxAge: INVITATION_COOKIE_MAX_AGE,
});

/** What the acceptance page shows before the explicit accept. Opening it never joins. */
export type RecipientState = { kind: "missing" } | { kind: "sign_in" } | { kind: "ready"; signedInAs: string };

export function recipientState(hasToken: boolean, viewerEmail: string | null): RecipientState {
  if (!hasToken) return { kind: "missing" };
  if (viewerEmail === null) return { kind: "sign_in" };
  return { kind: "ready", signedInAs: viewerEmail };
}
