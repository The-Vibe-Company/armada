/**
 * Organization invitations (#641): the dashboard's presentation of an invitation, for the admin who sends it and
 * the person who accepts it.
 *
 * PRESENTATION ONLY. These are view models, not the wire contract: the versioned DTOs and routes belong to #640
 * and are bound in one adapter once that contract is published. Nothing here names a backend field or endpoint.
 */

export type InviteRole = "member" | "admin";

export const INVITE_ROLES: readonly InviteRole[] = ["member", "admin"];

export const isInviteRole = (value: unknown): value is InviteRole => value === "member" || value === "admin";

/** The delivery outcomes #640 promises: never "sent" without a transport that accepted the message. */
export type DeliveryState = "pending" | "sent" | "failed";

/** Where an invitation stands, as the recipient's link sees it. */
export type InvitationStatus = "pending" | "expired" | "revoked" | "accepted";

/** One pending invitation in the admin's list. */
export type InvitationView = {
  id: string;
  email: string;
  role: InviteRole;
  delivery: DeliveryState;
  /** ISO 8601. */
  expiresAt: string;
};

/** What the recipient's link shows before they accept. No token: the page never prints one. */
export type InvitationPreview = {
  orgName: string;
  /** The address it was sent to; the recipient must be signed in with this one, verified. */
  email: string;
  role: InviteRole;
  status: InvitationStatus;
  expiresAt: string;
};

export type Viewer = { email: string; emailVerified: boolean } | null;

const MAX_EMAIL = 254;
// One `@`, a dot-separated domain with a top-level label of two letters or more: a full address, not `bob@corp`.
const FULL_EMAIL = /^[^\s@]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/** The address an admin typed, trimmed and lowercased, or null when it is not one full email address. */
export function normalizeInviteEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_EMAIL) return null;
  return FULL_EMAIL.test(email) ? email : null;
}

type Tone = "neutral" | "success" | "warning" | "danger";

/** The honest delivery label: "pending" is not "sent", and a failure says what to do. */
export function deliveryLabel(delivery: DeliveryState): { label: string; tone: Tone; hint?: string } {
  switch (delivery) {
    case "pending":
      return { label: "Sending", tone: "warning", hint: "The email has not been accepted by the mail service yet." };
    case "sent":
      return { label: "Email sent", tone: "success" };
    case "failed":
      return { label: "Not delivered", tone: "danger", hint: "The email could not be sent. Resend it or share again." };
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
 * What the recipient's page shows. GET only previews: acceptance is always the explicit button of the `ready` state.
 */
export type RecipientState =
  | { kind: "not_found" }
  | { kind: "expired" | "revoked" | "accepted"; preview: InvitationPreview }
  | { kind: "sign_in"; preview: InvitationPreview }
  | { kind: "wrong_account"; preview: InvitationPreview; signedInAs: string }
  | { kind: "unverified"; preview: InvitationPreview }
  | { kind: "ready"; preview: InvitationPreview };

export function recipientState(preview: InvitationPreview | null, viewer: Viewer, now: Date): RecipientState {
  if (!preview) return { kind: "not_found" };
  if (preview.status === "revoked" || preview.status === "accepted") return { kind: preview.status, preview };
  if (preview.status === "expired" || Date.parse(preview.expiresAt) <= now.getTime())
    return { kind: "expired", preview };
  if (!viewer) return { kind: "sign_in", preview };
  if (viewer.email.trim().toLowerCase() !== preview.email.trim().toLowerCase())
    return { kind: "wrong_account", preview, signedInAs: viewer.email };
  if (!viewer.emailVerified) return { kind: "unverified", preview };
  return { kind: "ready", preview };
}
