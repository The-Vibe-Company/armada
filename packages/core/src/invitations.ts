/** Organization invitations control API, version 1. All operations use POST and bearer auth. */
export const INVITATIONS_CONTRACT_VERSION = 1 as const;
export type InvitationRole = "member" | "admin";
export interface OrganizationInvitation {
  id: string;
  orgId: string;
  email: string;
  role: InvitationRole;
  expiresAt: string;
  status: "pending" | "accepted" | "revoked";
  delivery: "not_configured" | "pending" | "sent" | "failed";
}
export interface InvitationRequests {
  "org/invitations/create": { org: string; email: string; role: InvitationRole };
  "org/invitations/list": { org: string };
  "org/invitations/resend": { org: string; id: string };
  "org/invitations/revoke": { org: string; id: string };
  "org/invitations/accept": { token: string };
}
export interface InvitationResponses {
  "org/invitations/create": { invitation: OrganizationInvitation };
  "org/invitations/list": { invitations: OrganizationInvitation[] };
  "org/invitations/resend": { invitation: OrganizationInvitation };
  "org/invitations/revoke": { invitation: OrganizationInvitation };
  "org/invitations/accept": { orgId: string; accepted: true };
}

/** Additive v1 recipient consent contract. Token is sent only in the POST body. */
export type InvitationRecipientState =
  | "ready"
  | "not_found"
  | "expired"
  | "revoked"
  | "used"
  | "wrong_email"
  | "unverified_email"
  | "already_member";
export interface InvitationConsentContext {
  orgId: string;
  orgName: string;
  role: InvitationRole;
  expiresAt: string;
}
export type InvitationPreview =
  | { state: "ready" | "expired" | "revoked" | "used" | "already_member"; context: InvitationConsentContext }
  | { state: "not_found" | "wrong_email" | "unverified_email"; context: null };
export type InvitationErrorReason =
  | Exclude<InvitationRecipientState, "ready">
  | "invalid"
  | "personal_login_required"
  | "rate_limited"
  | "pending_exists";
/** Existing control error envelope, with additive machine-readable invitation fields. */
export interface InvitationApiError {
  error: {
    code: "invalid" | "forbidden" | "not_found" | "conflict";
    message: string;
    reason: InvitationErrorReason;
    retryAfterSeconds?: number;
  };
}
export interface InvitationRequests {
  "org/invitations/preview": { token: string };
}
export interface InvitationResponses {
  "org/invitations/preview": InvitationPreview;
}
