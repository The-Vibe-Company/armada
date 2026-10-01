// The organization's keys, kept in the app's database (THE-840, THE-849). Each
// value is sealed with envelope encryption: a fresh 256-bit data key encrypts
// it with AES-256-GCM, and the master key (ARMADA_SECRETS_KEY, held in the
// app's environment only, never in a database) wraps that data key. The row's
// organization, person and name are the additional data of both, so a sealed
// value copied onto another row does not open. Values are write-only: nothing
// here returns a secret's value to a page, only to the broker (`broker.ts`)
// and the dashboard's own reads. Every change and every release is recorded in
// `armada_secret_event`, never with a value; so is every worker launched with a
// launch token (`workers.ts`).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Env } from "./accounts-settings";
import { type Database, isoAt, type Queryable, transaction } from "./db";

export const SECRETS_KEY_VARIABLE = "ARMADA_SECRETS_KEY";

/** The master key and its id: the first characters of a hash, stored with each value to name the key it needs. */
export interface VaultKey {
  id: string;
  key: Buffer;
}

/**
 * Whether the deployment can keep keys. `off`: ARMADA_SECRETS_KEY is not set,
 * so the Keys page says how to set it and the broker answers 503; everything
 * else works as before. `invalid`: set, but not 32 bytes in base64 or hex.
 */
export type VaultMode = { kind: "on"; key: VaultKey } | { kind: "off" } | { kind: "invalid"; reason: string };

function keyBytes(value: string): Buffer | null {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    const bytes = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return bytes.length === 32 ? bytes : null;
  }
  return null;
}

export function vaultModeOf(env: Env): VaultMode {
  const value = env[SECRETS_KEY_VARIABLE]?.trim();
  if (!value) return { kind: "off" };
  const key = keyBytes(value);
  if (!key)
    return {
      kind: "invalid",
      reason: `${SECRETS_KEY_VARIABLE} must be 32 random bytes in base64 or hex (openssl rand -base64 32)`,
    };
  const id = createHash("sha256").update("armada-vault-key-id:").update(key).digest("hex").slice(0, 12);
  return { kind: "on", key: { id, key } };
}

// ------------------------------------------------------------ what is kept

export const SECRET_NAMES = [
  "linear-api-key",
  "turso-url",
  "turso-platform-token",
  "turso-organization",
  "turso-database",
  "turso-database-token",
  "github-token",
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export const isSecretName = (v: unknown): v is SecretName => SECRET_NAMES.includes(v as SecretName);

export interface SecretKind {
  /** False for a setting that is not a secret (a URL, a name): the Keys page shows its value. */
  secret: boolean;
  /** Whether a person may keep their own, which wins over the organization's for them. */
  personal: boolean;
  check: (value: string) => boolean;
}

/**
 * A libsql:// or https:// URL to a named host. Not localhost, an IP address
 * or an internal name: the dashboard's server connects there with the stored
 * token, and must not be pointed at its own network.
 */
function publicDatabaseUrl(v: string): boolean {
  const m = /^(libsql|https):\/\/([a-z0-9.-]+)(:\d+)?\/?$/i.exec(v);
  const host = m?.[2]?.toLowerCase().replace(/\.$/, "");
  if (!host?.includes(".")) return false;
  if (/^[\d.]+$/.test(host)) return false;
  return !/(^|\.)(localhost|local|internal|localdomain|home|lan)$/.test(host);
}

const token = (v: string) => v.length <= 4096 && !/\s/.test(v);
const name = (v: string) => /^[a-z0-9][a-z0-9-]{0,63}$/i.test(v);

export const SECRET_KINDS: Record<SecretName, SecretKind> = {
  "linear-api-key": { secret: true, personal: true, check: token },
  "turso-url": { secret: false, personal: false, check: (v) => publicDatabaseUrl(v) },
  "turso-platform-token": { secret: true, personal: false, check: token },
  "turso-organization": { secret: false, personal: false, check: name },
  "turso-database": { secret: false, personal: false, check: name },
  "turso-database-token": { secret: true, personal: false, check: token },
  "github-token": { secret: true, personal: false, check: token },
};

/** The keys that make up the Turso access: changing any of them changes the tokens handed out. */
export const TURSO_SECRETS: readonly SecretName[] = [
  "turso-url",
  "turso-platform-token",
  "turso-organization",
  "turso-database",
  "turso-database-token",
];

// ------------------------------------------------------------ sealing

interface Sealed {
  v: 1;
  /** The master key's id. */
  k: string;
  /** The data key, wrapped by the master key: iv, tag, ciphertext. */
  w: [string, string, string];
  /** The value, encrypted by the data key. */
  c: [string, string, string];
}

/** Where a value belongs; bound into its encryption. `user` is "" for the organization's own. */
export interface SecretSlot {
  organization: string;
  user: string;
  name: SecretName;
}

const aad = (slot: SecretSlot) => Buffer.from(`armada-secret:v1:${slot.organization}:${slot.user}:${slot.name}`);
const b64 = (b: Buffer) => b.toString("base64");

function encrypt(key: Buffer, plain: Buffer, data: Buffer): [string, string, string] {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(data);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return [b64(iv), b64(cipher.getAuthTag()), b64(ct)];
}

function decrypt(key: Buffer, [iv, tag, ct]: [string, string, string], data: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAAD(data);
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]);
}

export function sealSecret(vault: VaultKey, slot: SecretSlot, value: string): string {
  const data = aad(slot);
  const dataKey = randomBytes(32);
  try {
    const sealed: Sealed = {
      v: 1,
      k: vault.id,
      w: encrypt(vault.key, dataKey, data),
      c: encrypt(dataKey, Buffer.from(value, "utf8"), data),
    };
    return JSON.stringify(sealed);
  } finally {
    dataKey.fill(0);
  }
}

/** A sealed value that does not open: another master key, another row, or tampered with. Never quotes it. */
export class SealError extends Error {}

export function openSecret(vault: VaultKey, slot: SecretSlot, text: string): string {
  let sealed: Sealed;
  try {
    sealed = JSON.parse(text) as Sealed;
  } catch {
    throw new SealError(`the stored ${slot.name} is not a sealed value`);
  }
  if (sealed.v !== 1) throw new SealError(`the stored ${slot.name} has an unknown format`);
  if (sealed.k !== vault.id)
    throw new SealError(`the stored ${slot.name} was sealed with another ${SECRETS_KEY_VARIABLE}: enter it again`);
  const data = aad(slot);
  let dataKey: Buffer | null = null;
  try {
    dataKey = decrypt(vault.key, sealed.w, data);
    return decrypt(dataKey, sealed.c, data).toString("utf8");
  } catch {
    throw new SealError(`the stored ${slot.name} does not open: it was altered or moved; enter it again`);
  } finally {
    dataKey?.fill(0);
  }
}

// ------------------------------------------------------------ storage

/** What the Keys page shows of a key: who set it and when, never a secret's value. */
export interface SecretInfo {
  name: SecretName;
  /** Whether it is the person's own (true) or the organization's. */
  own: boolean;
  setBy: string;
  setAt: string;
  /** The value of a setting that is not a secret (a URL, a name); always null for a secret. */
  value: string | null;
  /** False when it no longer opens with this deployment's master key: it must be entered again. */
  readable: boolean;
}

/** Who acts: a person in the app, a terminal (session, API key or worker session), or the dashboard's own reads. */
export interface Actor {
  kind: "person" | "session" | "api-key" | "worker" | "dashboard";
  /** A user id, an API key id or a worker id; "" for the dashboard. */
  id: string;
  /** Shown in the audit list: a name and address, or the key's name. */
  label: string;
}

/**
 * `launch`, `exchange` and `end` are the workers' (THE-841): a launch token
 * made, used, and a worker ended. `link` and `unlink` are the GitHub App's
 * installations (THE-851).
 */
export type SecretAction = "set" | "delete" | "release" | "launch" | "exchange" | "end" | "link" | "unlink";

export interface SecretEvent {
  id: number;
  at: string;
  action: SecretAction;
  /** Which keys, e.g. ["linear-api-key", "turso"]. */
  keys: string[];
  actor: Actor;
  /** What happened, in words; never a value. */
  detail: string;
}

/** Lists the organization's keys and the person's own, without any secret value. */
export async function listSecrets(
  client: Queryable,
  vault: VaultKey | null,
  { organization, user }: { organization: string; user: string },
): Promise<SecretInfo[]> {
  const rs = await client.query(
    `SELECT "userId", "name", "sealed", "setByLabel", "updatedAt" FROM "armada_secret"
     WHERE "organizationId" = $1 AND "userId" IN ('', $2) ORDER BY "name", "userId"`,
    [organization, user],
  );
  return rs.rows.flatMap((row): SecretInfo[] => {
    const secretName = String(row.name);
    if (!isSecretName(secretName)) return [];
    const slot = { organization, user: String(row.userId), name: secretName };
    let value: string | null = null;
    let readable = vault !== null;
    if (vault)
      try {
        const opened = openSecret(vault, slot, String(row.sealed));
        if (!SECRET_KINDS[secretName].secret) value = opened;
      } catch {
        readable = false;
      }
    return [
      {
        name: secretName,
        own: slot.user !== "",
        setBy: String(row.setByLabel),
        setAt: isoAt(row.updatedAt),
        value,
        readable,
      },
    ];
  });
}

/** The opened values of the organization's keys, with the person's own on top. Server only: the broker and the dashboard's reads. */
export async function readSecrets(
  client: Queryable,
  vault: VaultKey,
  { organization, user }: { organization: string; user: string | null },
): Promise<{ values: Partial<Record<SecretName, string>>; own: SecretName[]; revision: string; problems: string[] }> {
  const rs = await client.query(
    `SELECT "userId", "name", "sealed", "updatedAt" FROM "armada_secret"
     WHERE "organizationId" = $1 AND "userId" IN ('', $2) ORDER BY "userId", "name"`,
    [organization, user ?? ""],
  );
  const values: Partial<Record<SecretName, string>> = {};
  const own: SecretName[] = [];
  const problems: string[] = [];
  const turso: string[] = [];
  // Ordered by user: the organization's row ('') first, the person's own over it.
  for (const row of rs.rows) {
    const secretName = String(row.name);
    if (!isSecretName(secretName)) continue;
    const slot = { organization, user: String(row.userId), name: secretName };
    if (slot.user && (!user || !SECRET_KINDS[secretName].personal)) continue;
    try {
      values[secretName] = openSecret(vault, slot, String(row.sealed));
      if (slot.user) own.push(secretName);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
    if (!slot.user && TURSO_SECRETS.includes(secretName)) turso.push(`${secretName}@${isoAt(row.updatedAt)}`);
  }
  // Which Turso keys, and when each was set: a token handed out under another revision is replaced.
  const revision = createHash("sha256")
    .update([organization, ...turso.sort()].join("\n"))
    .digest("hex")
    .slice(0, 16);
  return { values, own, revision, problems };
}

/** Sets or replaces one key. `user` null is the organization's; a person's own key only for a personal kind. */
export async function setSecret(
  client: Database,
  vault: VaultKey,
  input: { organization: string; user: string | null; name: SecretName; value: string; actor: Actor; now: Date },
): Promise<void> {
  const slot = { organization: input.organization, user: input.user ?? "", name: input.name };
  if (slot.user && !SECRET_KINDS[input.name].personal) throw new Error(`${input.name} is the organization's only`);
  const at = input.now;
  await transaction(client, async (tx) => {
    await tx.query(
      `INSERT INTO "armada_secret" ("organizationId", "userId", "name", "sealed", "setById", "setByLabel", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT ("organizationId", "userId", "name") DO UPDATE SET
         "sealed" = excluded."sealed", "setById" = excluded."setById",
         "setByLabel" = excluded."setByLabel", "updatedAt" = excluded."updatedAt"`,
      [
        slot.organization,
        slot.user,
        slot.name,
        sealSecret(vault, slot, input.value),
        input.actor.id,
        input.actor.label,
        at,
      ],
    );
    await recordEvent(tx, input.organization, {
      at: at.toISOString(),
      action: "set",
      keys: [input.name],
      actor: input.actor,
      detail: slot.user ? "their own key" : "for the organization",
    });
  });
}

/** Deletes one key; true when there was one. */
export async function deleteSecret(
  client: Database,
  input: { organization: string; user: string | null; name: SecretName; actor: Actor; now: Date },
): Promise<boolean> {
  return transaction(client, async (tx) => {
    const rs = await tx.query(
      `DELETE FROM "armada_secret" WHERE "organizationId" = $1 AND "userId" = $2 AND "name" = $3`,
      [input.organization, input.user ?? "", input.name],
    );
    if (rs.rowCount > 0)
      await recordEvent(tx, input.organization, {
        at: input.now.toISOString(),
        action: "delete",
        keys: [input.name],
        actor: input.actor,
        detail: input.user ? "their own key" : "for the organization",
      });
    return rs.rowCount > 0;
  });
}

// ------------------------------------------------------------ audit

export async function recordEvent(client: Queryable, organization: string, e: Omit<SecretEvent, "id">): Promise<void> {
  await client.query(
    `INSERT INTO "armada_secret_event" ("organizationId", "at", "action", "keys", "actorKind", "actorId", "actorLabel", "detail")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      organization,
      new Date(e.at),
      e.action,
      e.keys.join(","),
      e.actor.kind,
      e.actor.id,
      e.actor.label,
      e.detail.slice(0, 500),
    ],
  );
}

/** The organization's audit list, newest first. */
export async function listEvents(client: Queryable, organization: string, limit = 50): Promise<SecretEvent[]> {
  const rs = await client.query(
    `SELECT "id", "at", "action", "keys", "actorKind", "actorId", "actorLabel", "detail" FROM "armada_secret_event"
     WHERE "organizationId" = $1 ORDER BY "id" DESC LIMIT $2`,
    [organization, limit],
  );
  return rs.rows.map((r) => ({
    id: Number(r.id),
    at: isoAt(r.at),
    action: String(r.action) as SecretAction,
    keys: String(r.keys).split(",").filter(Boolean),
    actor: { kind: String(r.actorKind) as Actor["kind"], id: String(r.actorId), label: String(r.actorLabel) },
    detail: String(r.detail),
  }));
}

/** How many releases went to this actor since `since`: the broker's rate limit, shared by every server instance. */
export async function releasesSince(client: Queryable, actor: Actor, since: Date): Promise<number> {
  const rs = await client.query(
    `SELECT count(*)::int AS n FROM "armada_secret_event"
     WHERE "actorKind" = $1 AND "actorId" = $2 AND "action" = 'release' AND "at" > $3`,
    [actor.kind, actor.id, since],
  );
  return Number(rs.rows[0]?.n ?? 0);
}
