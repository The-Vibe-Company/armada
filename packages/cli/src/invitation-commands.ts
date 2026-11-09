import {
  type InvitationRequests,
  type InvitationResponses,
  type OrganizationInvitation,
  type OrgSummary,
  VaultError,
} from "@armada/core";
import { armadaApiUrl } from "./armada-api.ts";
import { control } from "./control.ts";
import { parseInvitationInput, readInvitationToken } from "./invitation-input.ts";
import type { VaultIo } from "./vault-commands.ts";

export async function invitationCommand(argv: readonly string[], io: VaultIo): Promise<number> {
  const input = parseInvitationInput(argv);
  if (input.action === "accept") {
    const token = await readInvitationToken(input.file, io);
    const result = await request(io, "org/invitations/accept", { token });
    // Do not serialize an arbitrary server object, even on acceptance.
    const output = { orgId: result.orgId, accepted: result.accepted };
    io.auth.out(input.json ? `${JSON.stringify(output)}\n` : `Accepted invitation for organization ${output.orgId}.\n`);
    return 0;
  }
  const selected = input.org ?? (await io.auth.preferences?.read(armadaApiUrl(io.auth.env.ARMADA_URL)));
  const org = selected ? await resolveOrganization(selected, io) : undefined;
  if (!org) throw new VaultError("invalid", "Select an organization with --org <name|UUID> or armada org use.");
  if (input.action === "list") {
    const result = await request(io, "org/invitations/list", { org });
    const invitations = result.invitations.map(publicInvitation);
    io.auth.out(
      input.json
        ? `${JSON.stringify({ invitations })}\n`
        : invitations.length
          ? `${invitations.map(formatInvitation).join("\n")}\n`
          : "No invitations.\n",
    );
    return 0;
  }
  const result =
    input.action === "create"
      ? await request(io, "org/invitations/create", { org, email: input.email, role: input.role })
      : await request(io, input.action === "resend" ? "org/invitations/resend" : "org/invitations/revoke", {
          org,
          id: input.id,
        });
  const invitation = publicInvitation(result.invitation);
  io.auth.out(input.json ? `${JSON.stringify({ invitation })}\n` : `${formatInvitation(invitation)}\n`);
  return 0;
}

function request<R extends keyof InvitationRequests>(
  io: VaultIo,
  route: R,
  body: InvitationRequests[R],
): Promise<InvitationResponses[R]> {
  return control<InvitationResponses[R]>(io.auth, route, body);
}

/** Only the producer's public fields reach output; never a token, URL, hash or future secret field. */
function publicInvitation(value: OrganizationInvitation): OrganizationInvitation {
  return {
    id: value.id,
    orgId: value.orgId,
    email: value.email,
    role: value.role,
    expiresAt: value.expiresAt,
    status: value.status,
    delivery: value.delivery,
  };
}

function formatInvitation(value: OrganizationInvitation): string {
  const delivery =
    value.delivery === "sent" ? "sent (email provider accepted; inbox delivery unconfirmed)" : value.delivery;
  return `${value.id}  ${value.email}  ${value.role}  ${value.status}  email: ${delivery}  expires: ${value.expiresAt}`;
}

/** Invitation management takes an org UUID; names use the existing authenticated org listing. */
async function resolveOrganization(ref: string, io: VaultIo): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref;
  const { orgs } = await control<{ orgs: OrgSummary[] }>(io.auth, "org/list", {});
  const matches = orgs.filter((org) => org.name.toLowerCase() === ref.toLowerCase());
  if (matches.length !== 1 || !matches[0])
    throw new VaultError("invalid", "Choose one of your organizations by UUID or exact unambiguous name.");
  return matches[0].id;
}
