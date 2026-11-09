/**
 * Organization invitations (#641), as the dashboard shows them: the admin who invites, resends and revokes, and the
 * person who previews and accepts. The Armada server owns the invitation (#640, control API v1): authenticated POSTs
 * under `/api/v1/org/invitations/`. The dashboard never writes an invitation or a membership itself.
 *
 * The answers are parsed here, field by field, into what the pages show. BINDING POINT: until #640's
 * `packages/core/src/invitations.ts` is merged, the shapes below mirror its v1 contract for parsing only; once it is,
 * they become `import type` from `@armada/core` and only the runtime parsers stay.
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

/** What the server's recipient preview says about this invitation for the signed-in person (#640). */
export type RecipientPreviewState =
  | "ready"
  | "not_found"
  | "expired"
  | "revoked"
  | "used"
  | "wrong_email"
  | "unverified_email"
  | "already_member";
const WITH_CONTEXT = ["ready", "expired", "revoked", "used", "already_member"] as const;
const WITHOUT_CONTEXT = ["not_found", "wrong_email", "unverified_email"] as const;

/** The org, role and expiry, shown only once the server matched the signed-in, verified address. */
export type ConsentContext = { orgId: string; orgName: string; role: InviteRole; expiresAt: string };

export type RecipientPreview =
  | { state: (typeof WITH_CONTEXT)[number]; context: ConsentContext }
  | { state: (typeof WITHOUT_CONTEXT)[number]; context: null };

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
  /** Signed out, with the email's own sign-in (`token_hash`): continuing verifies it and signs in as its address. */
  | { kind: "link_sign_in" }
  /** That link, verified: whose account it signs in as and for which org, before anything is stored. */
  | { kind: "link_confirm"; email: string; orgName: string }
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

/**
 * The email's own sign-in (#640 asks GoTrue for an email OTP, without a PKCE challenge from this browser). It arrives in
 * one of two shapes, both on the invitation link:
 * - GoTrue's default confirmation redirects with the session in the URL fragment (`#access_token=…&refresh_token=…`),
 *   or `#error=…` when the link is spent. The fragment never reaches a server; the page's bridge reads it once,
 *   removes it from the address bar and keeps it in memory only.
 * - A template that sends `token_hash` and `type` instead: the proxy moves them into {@link INVITATION_LINK_COOKIE}
 *   with the invitation token, and they are verified server-side only when the person chooses to continue.
 * Either way, signing in is its own explicit step, separate from joining, and never replaces another account silently.
 */
export const INVITATION_LINK_COOKIE = "armada_invitation_link";
/** The session a verified `token_hash` minted, waiting for the explicit "continue as …" (path: the acceptance page). */
export const INVITATION_LINK_SESSION_COOKIE = "armada_invitation_link_session";
/** A confirmation link is short-lived at GoTrue too; this only bounds how long the browser keeps it. */
export const INVITATION_LINK_MAX_AGE = 10 * 60;

const EMAIL_LINK_TYPES = ["magiclink", "email", "signup", "invite"] as const;
export type EmailLinkType = (typeof EMAIL_LINK_TYPES)[number];
export const isEmailLinkType = (value: unknown): value is EmailLinkType =>
  EMAIL_LINK_TYPES.includes(value as EmailLinkType);

/** `type:token_hash` as the cookie stores it, or null when either part is malformed. */
export function encodeEmailLink(type: string | null, tokenHash: string | null): string | null {
  if (!isEmailLinkType(type) || !tokenHash || !/^[A-Za-z0-9._~-]{8,512}$/.test(tokenHash)) return null;
  return `${type}:${tokenHash}`;
}

export function decodeEmailLink(value: string | undefined): { type: EmailLinkType; tokenHash: string } | null {
  if (!value) return null;
  const [type, tokenHash, ...rest] = value.split(":");
  return rest.length === 0 && encodeEmailLink(type ?? null, tokenHash ?? null)
    ? { type: type as EmailLinkType, tokenHash: tokenHash as string }
    : null;
}

const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type EmailLinkFragment =
  | { kind: "session"; accessToken: string; refreshToken: string }
  | { kind: "error"; expired: boolean };

/** The session or the error GoTrue put in the URL fragment, or null when the fragment is neither. */
export function parseEmailLinkFragment(hash: string): EmailLinkFragment | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  if (params.has("error") || params.has("error_code"))
    return { kind: "error", expired: params.get("error_code") === "otp_expired" };
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken && !refreshToken) return null;
  if (!accessToken || !refreshToken || !JWT.test(accessToken) || accessToken.length > 8192)
    return { kind: "error", expired: false };
  if (!/^[A-Za-z0-9._~-]{1,512}$/.test(refreshToken)) return { kind: "error", expired: false };
  return { kind: "session", accessToken, refreshToken };
}
