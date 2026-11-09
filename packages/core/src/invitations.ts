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
