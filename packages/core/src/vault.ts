import { type CredentialReader, parseCredentialValue } from "./credentials.ts";
import { encryptSecret } from "./crypto.ts";
import type { CredentialKind, CredentialScope, MemberRole } from "./database.types.ts";
import { VaultError } from "./vault-error.ts";

export interface OrgSummary {
  id: string;
  name: string;
  role: MemberRole;
}

export interface MemberInfo {
  userId: string;
  email: string | null;
  role: MemberRole;
  createdAt: string;
}

/** What is stored, never the value. An org boat key has no row of its own, so no date. */
export interface CredentialInfo {
  kind: CredentialKind;
  createdAt: string | null;
}

export interface OrgCredentials extends OrgSummary {
  credentials: CredentialInfo[];
}

/**
 * Orgs, members and credentials with full access: the service role. It is not row level
 * security that decides who may do what here, so every function below checks the caller first.
 * Only the server holds one of these; the CLI reaches it through the control API.
 */
export interface VaultStore extends CredentialReader {
  /** Inserts the org and its first admin together. This is the one way an org is created. */
  createOrg(name: string, adminUserId: string): Promise<{ id: string; name: string }>;
  memberships(userId: string): Promise<OrgSummary[]>;
  findUserByEmail(email: string): Promise<{ id: string; email: string } | null>;
  listMembers(orgId: string): Promise<MemberInfo[]>;
  /** False when the user is already a member. */
  addMember(orgId: string, userId: string, role: MemberRole): Promise<boolean>;
  setMemberRole(orgId: string, userId: string, role: MemberRole): Promise<boolean>;
  removeMember(orgId: string, userId: string): Promise<boolean>;
  upsertCredential(scope: CredentialScope, ownerId: string, kind: CredentialKind, valueEnc: Uint8Array): Promise<void>;
  deleteCredential(scope: CredentialScope, ownerId: string, kind: CredentialKind): Promise<boolean>;
  listCredentials(scope: CredentialScope, ownerId: string): Promise<CredentialInfo[]>;
  /** Null clears the key. */
  setOrgBoatKey(orgId: string, valueEnc: Uint8Array | null): Promise<void>;
  hasOrgBoatKey(orgId: string): Promise<boolean>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseOrgName(raw: string): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > 120) throw new VaultError("invalid", "An org name is 1 to 120 characters.");
  return name;
}

export function parseRole(raw: string): MemberRole {
  if (raw === "admin" || raw === "member") return raw;
  throw new VaultError("invalid", "A role is admin or member.");
}

/** Anyone signed in can create an org. They become its first admin. Orgs are isolated, and each brings its own keys. */
export async function createOrg(store: VaultStore, userId: string, name: string): Promise<OrgSummary> {
  const created = await store.createOrg(parseOrgName(name), userId);
  return { ...created, role: "admin" };
}

export function listOrgs(store: VaultStore, userId: string): Promise<OrgSummary[]> {
  return store.memberships(userId);
}

/**
 * The org a request is about: named by id or by name, or the only one the caller belongs to.
 * An org the caller is not in is the same answer as an org that does not exist.
 */
export async function resolveOrg(store: VaultStore, userId: string, ref: string | undefined): Promise<OrgSummary> {
  const orgs = await store.memberships(userId);
  if (ref === undefined || ref.trim() === "") {
    const only = orgs[0];
    if (only && orgs.length === 1) return only;
    if (orgs.length === 0) throw new VaultError("not_found", "You are not a member of an org.");
    throw new VaultError("invalid", "Name the org with --org. You belong to more than one.");
  }
  const wanted = ref.trim().toLowerCase();
  const found = orgs.find((org) => (UUID.test(wanted) ? org.id === wanted : org.name.trim().toLowerCase() === wanted));
  if (!found) throw new VaultError("not_found", "You are not a member of that org.");
  return found;
}

async function resolveAdminOrg(store: VaultStore, userId: string, ref: string | undefined): Promise<OrgSummary> {
  const org = await resolveOrg(store, userId, ref);
  if (org.role !== "admin") throw new VaultError("forbidden", "Only an org admin can do that.");
  return org;
}

export async function listMembers(
  store: VaultStore,
  userId: string,
  ref: string | undefined,
): Promise<{ org: OrgSummary; members: MemberInfo[] }> {
  const org = await resolveOrg(store, userId, ref);
  return { org, members: await store.listMembers(org.id) };
}

/** Adds someone who has already signed in to Armada. There are no pending invitations. */
export async function addMember(
  store: VaultStore,
  userId: string,
  input: { org: string | undefined; email: string; role: MemberRole },
): Promise<MemberInfo> {
  const org = await resolveAdminOrg(store, userId, input.org);
  const target = await findMember(store, input.email);
  if (!(await store.addMember(org.id, target.id, input.role))) {
    throw new VaultError("conflict", `${target.email} is already a member.`);
  }
  const member = (await store.listMembers(org.id)).find((candidate) => candidate.userId === target.id);
  if (!member) throw new VaultError("unavailable", "The member could not be added.");
  return member;
}

export async function setMemberRole(
  store: VaultStore,
  userId: string,
  input: { org: string | undefined; email: string; role: MemberRole },
): Promise<void> {
  const org = await resolveAdminOrg(store, userId, input.org);
  const target = await findMember(store, input.email);
  if (!(await store.setMemberRole(org.id, target.id, input.role))) {
    throw new VaultError("not_found", `${target.email} is not a member.`);
  }
}

export async function removeMember(
  store: VaultStore,
  userId: string,
  input: { org: string | undefined; email: string },
): Promise<void> {
  const org = await resolveAdminOrg(store, userId, input.org);
  const target = await findMember(store, input.email);
  if (!(await store.removeMember(org.id, target.id))) {
    throw new VaultError("not_found", `${target.email} is not a member.`);
  }
}

/**
 * Stores a credential encrypted. A user credential is the caller's own. An org credential needs an
 * org admin. The org boat.dev key is the org's own column; every other org credential is a row.
 * Setting a kind again replaces it.
 */
export async function setCredential(
  store: VaultStore,
  encryptionKey: string | undefined,
  userId: string,
  input: { scope: CredentialScope; org: string | undefined; kind: CredentialKind; value: string },
): Promise<void> {
  const value = parseCredentialValue(input.kind, input.value);
  if (input.scope === "user") {
    await store.upsertCredential("user", userId, input.kind, await encryptSecret(value, encryptionKey));
    return;
  }
  const org = await resolveAdminOrg(store, userId, input.org);
  const sealed = await encryptSecret(value, encryptionKey);
  if (input.kind === "boat") await store.setOrgBoatKey(org.id, sealed);
  else await store.upsertCredential("org", org.id, input.kind, sealed);
}

export async function removeCredential(
  store: VaultStore,
  userId: string,
  input: { scope: CredentialScope; org: string | undefined; kind: CredentialKind },
): Promise<void> {
  let removed: boolean;
  if (input.scope === "user") {
    removed = await store.deleteCredential("user", userId, input.kind);
  } else {
    const org = await resolveAdminOrg(store, userId, input.org);
    if (input.kind === "boat") {
      removed = await store.hasOrgBoatKey(org.id);
      await store.setOrgBoatKey(org.id, null);
    } else {
      removed = await store.deleteCredential("org", org.id, input.kind);
    }
  }
  if (!removed) throw new VaultError("not_found", "No such credential is stored.");
}

/** The caller's own credentials and those of their orgs (or of the one named). Kinds and dates only. */
export async function listCredentials(
  store: VaultStore,
  userId: string,
  ref: string | undefined,
): Promise<{ user: CredentialInfo[]; orgs: OrgCredentials[] }> {
  const orgs = ref === undefined ? await store.memberships(userId) : [await resolveOrg(store, userId, ref)];
  return {
    user: await store.listCredentials("user", userId),
    orgs: await Promise.all(
      orgs.map(async (org) => {
        const rows = await store.listCredentials("org", org.id);
        const boat: CredentialInfo[] = (await store.hasOrgBoatKey(org.id)) ? [{ kind: "boat", createdAt: null }] : [];
        return { ...org, credentials: [...boat, ...rows] };
      }),
    ),
  };
}

async function findMember(store: VaultStore, email: string): Promise<{ id: string; email: string }> {
  const trimmed = email.trim();
  if (!EMAIL.test(trimmed)) throw new VaultError("invalid", "Give the person's email address.");
  const user = await store.findUserByEmail(trimmed);
  if (!user) {
    throw new VaultError(
      "not_found",
      "No Armada account has that email. The person signs in with 'armada login' first.",
    );
  }
  return user;
}
