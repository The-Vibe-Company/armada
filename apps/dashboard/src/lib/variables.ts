import type { Bucket, ResourceState } from "./resource-list.ts";

/**
 * The Variables page (#935, slice 3b of #906): readable variables and write-only application secrets, personal and
 * organization, as the control API's `variables/*` and `secrets/*` routes return them. A secret is metadata only:
 * there is no value field to parse, keep or show, and no operation that would return one.
 */
export type VaultKind = "variable" | "secret";
export type VaultScope = "personal" | "org";
export type VaultStatus = "active" | "revoked";
/** A delete answers with its value-free tombstone; a list never includes one. */
export type VaultAnswerStatus = VaultStatus | "deleted";

export type VaultItem = {
  kind: VaultKind;
  id: string;
  orgId: string;
  ownerId: string;
  scope: VaultScope;
  name: string;
  version: number;
  status: VaultStatus;
  createdAt: string;
  updatedAt: string;
  /** Secrets only: stored metadata, not enforced by this slice. */
  expiresAt: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function iso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * One item of a `list`, or the `item` of a mutation, kept only when it is well formed. Only the known metadata
 * fields are copied: anything else the server might send (a value, a ciphertext) never enters the page.
 */
export function parseVaultItem(kind: VaultKind, value: unknown): VaultItem | null;
export function parseVaultItem(
  kind: VaultKind,
  value: unknown,
  options: { tombstone: true },
): (Omit<VaultItem, "status"> & { status: VaultAnswerStatus }) | null;
export function parseVaultItem(
  kind: VaultKind,
  value: unknown,
  options?: { tombstone: true },
): (Omit<VaultItem, "status"> & { status: VaultAnswerStatus }) | null {
  if (!isRecord(value)) return null;
  const { id, orgId, ownerId, scope, name, version, status } = value;
  const createdAt = iso(value.createdAt);
  const updatedAt = iso(value.updatedAt);
  if (
    typeof id !== "string" ||
    !UUID.test(id) ||
    typeof orgId !== "string" ||
    typeof ownerId !== "string" ||
    (scope !== "personal" && scope !== "org") ||
    typeof name !== "string" ||
    !name ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    (status !== "active" && status !== "revoked" && !(options?.tombstone && status === "deleted")) ||
    !createdAt ||
    !updatedAt
  )
    return null;
  return {
    kind,
    id,
    orgId,
    ownerId,
    scope,
    name,
    version,
    status,
    createdAt,
    updatedAt,
    expiresAt: kind === "secret" ? iso(value.expiresAt) : null,
  };
}

/** Prefixes the server keeps for Armada, the providers and the harnesses (`application-vault.ts`). */
const RESERVED_PREFIXES = /^(ARMADA_|BOAT_|MODAL_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|GH_|GITHUB_|MCP_|LD_|DYLD_)/;
const RESERVED_NAMES = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "ENV",
  "BASH_ENV",
  "NODE_OPTIONS",
  "PYTHONPATH",
  "SSL_CERT_FILE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);
/** Prefixes a frontend build publishes into its bundle: a secret there would ship to every browser. */
const PUBLIC_PREFIXES = /^(NEXT_PUBLIC_|VITE_|PUBLIC_)/;

export const MAX_VALUE_BYTES = 8192;

/**
 * Why the server would refuse this name, in words, or null when it is valid. The server answers every refusal with
 * the same generic sentence (it never echoes what was sent), so the dashboard says why before sending.
 */
export function nameProblem(name: string, kind: VaultKind): string | null {
  if (!name) return "Enter a name.";
  if (!/^[A-Z][A-Z0-9_]*$/.test(name))
    return "Use capital letters, digits and underscores, starting with a letter (like APP_REGION).";
  if (name.length > 128) return "Use at most 128 characters.";
  const prefix = RESERVED_PREFIXES.exec(name)?.[1];
  if (prefix) return `Names starting with ${prefix} are reserved for Armada and the agents.`;
  if (RESERVED_NAMES.has(name)) return `${name} is reserved: the sandbox sets it.`;
  const exposed = kind === "secret" ? PUBLIC_PREFIXES.exec(name)?.[1] : undefined;
  if (exposed) return `A secret cannot start with ${exposed}: frontend builds publish those names.`;
  return null;
}

/** Why the server would refuse this value, or null. Never quotes the value. */
export function valueProblem(value: string, kind: VaultKind, name: string): string | null {
  if (kind === "secret" && !value) return "Enter the secret value.";
  if (value.includes("\0")) return "The value cannot contain a NUL character.";
  if (new TextEncoder().encode(value).byteLength > MAX_VALUE_BYTES) return "The value is over 8 KiB.";
  // The server refuses a secret whose name contains it: the name is shown everywhere, the value nowhere.
  if (kind === "secret" && name.includes(value)) return "The secret value cannot appear in its name.";
  return null;
}

/** An item's state: an active one is ready; a revoked one is not a fault, just no longer usable. */
export function vaultState(item: Pick<VaultItem, "status">): ResourceState & { bucket: Bucket } {
  return item.status === "active"
    ? { bucket: "ready", tone: "success", label: "Active" }
    : { bucket: "rest", tone: "neutral", label: "Revoked" };
}

/** Who may change an item: its owner for a personal one, an admin for an org one. */
export function canManage(item: Pick<VaultItem, "scope" | "ownerId">, viewer: { userId: string; admin: boolean }) {
  return item.scope === "org" ? viewer.admin : item.ownerId === viewer.userId;
}

/** Who can use an item, the row's fact. */
export function audience(item: Pick<VaultItem, "scope">, orgName: string): string {
  return item.scope === "personal" ? "Only you" : `Everyone in ${orgName}`;
}

/** The row and panel key: a variable and a secret are separate objects even with the same name. */
export const itemKey = (item: Pick<VaultItem, "kind" | "id">) => `${item.kind}-${item.id}`;

/**
 * A control API refusal in words. The vault's own messages are deliberately generic ("Application vault access
 * denied."), so the dashboard says what each status means for this page instead.
 */
export function vaultFailure(status: number | undefined, fallback: string): string {
  switch (status) {
    case 400:
      return "The server refused that name or value. Check the rules under each field and try again.";
    case 403:
      return "Only an admin changes organization variables and secrets.";
    case 404:
      return "It no longer exists. Refresh the page.";
    case 409:
      return "It changed since this page loaded, or the name is already used. Refresh and try again.";
    default:
      return fallback;
  }
}
