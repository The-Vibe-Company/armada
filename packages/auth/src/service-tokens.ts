import { generateToken, sha256Hex } from "./codec.ts";
import { AuthError } from "./errors.ts";
import { assertLabel } from "./labels.ts";
import type { AuthStore, ListedToken, Membership } from "./types.ts";

export interface CreatedServiceToken {
  id: string;
  label: string;
  orgName: string;
  /** Shown once. Only the sha-256 hex of this string is stored. */
  token: string;
}

/** Mints a service token for a bot. The caller must already be a member of the org. */
export async function createServiceToken(
  store: AuthStore,
  input: { userId: string; orgName?: string; label?: string; now: Date },
): Promise<CreatedServiceToken> {
  const org = await resolveOrg(store, input.userId, input.orgName);
  const label = assertLabel(input.label ?? "default");
  const token = generateToken("service");
  const row = await store.insertToken("service", {
    userId: input.userId,
    orgId: org.orgId,
    hash: await sha256Hex(token),
    label,
    createdAt: input.now.toISOString(),
  });
  return { id: row.id, label, orgName: org.name, token };
}

export async function listServiceTokens(store: AuthStore, userId: string): Promise<ListedToken[]> {
  return store.listServiceTokens(userId);
}

export async function revokeServiceToken(
  store: AuthStore,
  input: { userId: string; id: string; now: Date },
): Promise<void> {
  const row = await store.revokeToken("service", {
    id: input.id,
    userId: input.userId,
    revokedAt: input.now.toISOString(),
  });
  if (!row) throw new AuthError("No active service token with that id.", "usage");
}

export async function resolveOrg(store: AuthStore, userId: string, orgName: string | undefined): Promise<Membership> {
  const memberships = await store.memberships(userId);
  if (orgName === undefined) {
    if (memberships.length === 1) {
      const only = memberships[0];
      if (!only) throw new AuthError("You are not a member of an organization.", "usage");
      return only;
    }
    if (memberships.length === 0) throw new AuthError("You are not a member of an organization.", "usage");
    throw new AuthError("Name the org with --org. You belong to more than one.", "usage");
  }
  const found = memberships.filter((membership) => membership.name === orgName);
  const only = found.length === 1 ? found[0] : undefined;
  if (!only) {
    throw new AuthError(
      found.length === 0 ? "You are not a member of that org." : "More than one org has that name.",
      "usage",
    );
  }
  return only;
}
