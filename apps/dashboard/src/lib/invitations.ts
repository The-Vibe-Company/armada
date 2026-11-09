/**
 * Organization invitations (#641), as the dashboard shows them: the admin who invites, resends and revokes, and the
 * person who previews and accepts. The Armada server owns the invitation (#640, control API v1): authenticated POSTs
 * under `/api/v1/org/invitations/`. The dashboard never writes an invitation or a membership itself.
 *
 * The wire types are `@armada/core`'s (`packages/core/src/invitations.ts`, contract v1). The answers are parsed here,
 * field by field, against them: a server that sends anything else is refused, never shown.
 */

import type {
  InvitationConsentContext,
  InvitationPreview,
  InvitationRecipientState,
  InvitationRole,
  OrganizationInvitation,
} from "@armada/core";

export type InviteRole = InvitationRole;
export const INVITE_ROLES: readonly InviteRole[] = ["member", "admin"];
export const isInviteRole = (value: unknown): value is InviteRole => value === "member" || value === "admin";

/**
 * The server's delivery state. `sent` means the mail service accepted the message, not that it reached the inbox;
 * `not_configured` means this server has no mail transport, so nothing was sent.
 */
export type DeliveryState = OrganizationInvitation["delivery"];
const DELIVERY = ["not_configured", "pending", "sent", "failed"] as const satisfies readonly DeliveryState[];

export type InvitationStatus = OrganizationInvitation["status"];
const STATUS = ["pending", "accepted", "revoked"] as const satisfies readonly InvitationStatus[];

/** One invitation as the admin's list shows it: the server's DTO, fields checked. */
export type InvitationView = OrganizationInvitation;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An invitation from the server, or null when the answer is not one. Extra fields are dropped. */
export function parseInvitation(value: unknown): InvitationView | null {
  if (!isRecord(value)) return null;
  const { id, orgId, email, role, expiresAt, status, delivery } = value;
  if (typeof id !== "string" || typeof orgId !== "string" || typeof email !== "string") return null;
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;
  if (!isInviteRole(role)) return null;
  if (!(STATUS as readonly unknown[]).includes(status) || !(DELIVERY as readonly unknown[]).includes(delivery))
    return null;
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

const WITH_CONTEXT = [
  "ready",
  "expired",
  "revoked",
  "used",
  "already_member",
] as const satisfies readonly InvitationRecipientState[];
const WITHOUT_CONTEXT = [
  "not_found",
  "wrong_email",
  "unverified_email",
] as const satisfies readonly InvitationRecipientState[];

/** The org, role and expiry, shown only once the server matched the signed-in, verified address. */
export type ConsentContext = InvitationConsentContext;

/** What the server's recipient preview says about this invitation for the signed-in person. */
export type RecipientPreview = InvitationPreview;

function parseContext(value: unknown): ConsentContext | null {
  if (!isRecord(value)) return null;
  const { orgId, orgName, role, expiresAt } = value;
  if (typeof orgId !== "string" || typeof orgName !== "string" || !isInviteRole(role)) return null;
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) return null;
  return { orgId, orgName, role, expiresAt };
}

/** The preview answer, or null when it is not one. Context is dropped whenever the state must not carry it. */
export function parsePreview(value: unknown): RecipientPreview | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  if (WITHOUT_CONTEXT.includes(state as (typeof WITHOUT_CONTEXT)[number]))
    return { state: state as (typeof WITHOUT_CONTEXT)[number], context: null };
  if (WITH_CONTEXT.includes(state as (typeof WITH_CONTEXT)[number])) {
    const context = parseContext(value.context);
    return context ? { state: state as (typeof WITH_CONTEXT)[number], context } : null;
  }
  return null;
}

/** What the acceptance page shows. Opening it never joins: the button of `preview` / `ready` is the only way. */
export type RecipientState =
  | { kind: "missing" }
  | { kind: "sign_in" }
  | { kind: "unavailable"; message: string; signInAgain: boolean }
  | { kind: "preview"; preview: RecipientPreview; signedInAs: string };

/**
 * Why an acceptance (or a preview) was refused, from the server's `error.reason`, in words that say what to do next.
 * Without a reason (a session or server failure), the status decides.
 */
export function refusalMessage(
  reason: string | undefined,
  status: number | undefined,
  retryAfterSeconds?: number,
): string {
  switch (reason) {
    case "not_found":
    case "invalid":
      return "This invitation link is not valid. Open the latest invitation email, or ask an admin to resend it.";
    case "expired":
      return "This invitation has expired. Ask an admin of the organization to resend it.";
    case "revoked":
      return "This invitation was revoked by an admin of the organization.";
    case "used":
      return "This invitation was already accepted.";
    case "already_member":
      return "You are already a member of this organization.";
    case "wrong_email":
      return "This invitation is for another email address. Sign in with the address it was sent to.";
    case "unverified_email":
      return "Your email address is not verified yet. Sign in again with the emailed link or code, then accept.";
    case "personal_login_required":
      return "Accept with your own signed-in account, not a service token.";
    case "rate_limited":
      return retryAfterSeconds && retryAfterSeconds > 0
        ? `Too many attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} min.`
        : "Too many attempts. Try again in a few minutes.";
  }
  if (status === 401) return "Your session ended. Sign in again, then accept.";
  return "Armada could not answer for this invitation right now. Try again shortly.";
}

/**
 * The invitation link (`/invitations/accept?token=…`) as the email sends it. The token is moved into a short-lived,
 * HTTP-only cookie on the first request, and the address bar loses it: it never travels in a login `next`, a Referer,
 * the history or a page. Only the server reads it: the acceptance page sends it in the body of the preview, and the
 * explicit accept sends it the same way. A successful accept, or a plain sign-out, deletes it. The cookie's
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

/**
 * The invitation email's own sign-in is never used. #649 sends its link through a GoTrue email OTP that this browser did
 * not start (no PKCE challenge), so its credentials (a session in the URL fragment, or a `token_hash`) could belong to
 * anyone who forwarded the link. They are discarded unread: the proxy drops the query (keeping only the invitation
 * token, in its cookie), and this script, inlined in the page, removes the fragment from the address bar and history
 * as early as the page allows; nothing reads the fragment in any case. The recipient then signs in from this
 * browser, as on the login page.
 */
export const DISCARD_LINK_CREDENTIALS_SCRIPT = `(function(){if(location.hash)history.replaceState(history.state,"",location.pathname)})()`;
