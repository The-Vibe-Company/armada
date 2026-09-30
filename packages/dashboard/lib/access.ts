// Who may read the fleet on this request, whichever gate the deployment runs:
// accounts (a signed-in member of an organization, who sees that
// organization's projects and signs requests as themselves) or, until the
// accounts variables are set, the shared-password gate of THE-834 (every
// project, requests signed with a name the viewer gives).
import "server-only";
import { accounts, homeOrganization, requireMember, type Viewer, type ViewerOrganization } from "./accounts-server";
import { requireSession } from "./auth-server";
import type { Scope } from "./fleet-data";

export type Access =
  | { kind: "account"; viewer: Viewer & { organization: ViewerOrganization }; scope: Scope }
  | { kind: "password" };

/** Call first in every fleet read and server action. Redirects a viewer who may not read the fleet. */
export async function requireFleetAccess(): Promise<Access> {
  if (await accounts()) {
    const viewer = await requireMember();
    return { kind: "account", viewer, scope: { organization: viewer.organization.id, home: await homeOrganization() } };
  }
  await requireSession();
  return { kind: "password" };
}

export const scopeOf = (access: Access): Scope | null => (access.kind === "account" ? access.scope : null);
