// The organization's keys, kept in the app's database (THE-840, THE-849), and
// each project's (THE-859). Each value is sealed with envelope encryption: a
// fresh 256-bit data key encrypts it with AES-256-GCM, and the master key
// (ARMADA_SECRETS_KEY, held in the app's environment only, never in a
// database) wraps that data key. The row's organization, project, person and
// name are the additional data of both, so a sealed value copied onto another
// row does not open. Besides the keys Armada itself reads (Linear, GitHub),
// the vault keeps the secrets workers need to build and test (`OPENAI_API_KEY`):
// the organization's, and each project's, which wins for that project. Values are write-only: nothing
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

export const SECRET_NAMES = ["linear-api-key", "github-token"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];
export const isSecretName = (v: unknown): v is SecretName => SECRET_NAMES.includes(v as SecretName);

export interface SecretKind {
  /** False for a setting that is not a secret (a URL, a name): the Keys page shows its value. */
  secret: boolean;
  /** Whether a person may keep their own, which wins over the organization's for them. */
  personal: boolean;
  /** Whether a project may keep its own, which wins over a person's and the organization's for that project. */
  project: boolean;
  check: (value: string) => boolean;
}

const token = (v: string) => v.length <= 4096 && !/\s/.test(v);

export const SECRET_KINDS: Record<SecretName, SecretKind> = {
  "linear-api-key": { secret: true, personal: true, project: true, check: token },
  "github-token": { secret: true, personal: false, project: false, check: token },
};

/**
 * A secret for workers (THE-859): an environment variable name, upper snake
 * case. Never one Armada reads itself: those stay named and typed above.
 */
export const WORKER_SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_NAMES = ["LINEAR_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"];

/** Why `name` cannot be a secret for workers; null when it can. Names it, never a value. */
export function workerSecretRefusal(name: string): string | null {
  if (!WORKER_SECRET_NAME.test(name))
    return `"${name.slice(0, 64)}" is not a secret name: upper snake case, e.g. OPENAI_API_KEY`;
  if (RESERVED_NAMES.includes(name) || name.startsWith("ARMADA_"))
    return `${name} is a key Armada itself uses: it is set on the Keys page as such, not as a secret for workers`;
  return null;
}

export const isWorkerSecretName = (v: unknown): v is string => typeof v === "string" && !workerSecretRefusal(v);

/** A worker secret's value: anything printable on one environment variable, up to 32 KB. */
export const checkWorkerSecret = (v: string) => v.length > 0 && v.length <= 32_768 && !v.includes("\0");

/** Where a key or secret applies: the organization's, or one project's. */
export type SecretScope = "organization" | "project";

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

/**
 * Where a value belongs; bound into its encryption. `user` is "" for the
 * organization's own, `project` "" for every project's (and absent before
 * THE-859). `name` is a key's (`linear-api-key`) or a worker secret's.
 */
export interface SecretSlot {
  organization: string;
  project?: string;
  user: string;
  name: string;
}

// A row of no project keeps the additional data it was sealed with before
// projects had their own, so those rows still open; a project's row names it,
// unambiguously.
const aad = (slot: SecretSlot) =>
  Buffer.from(
    slot.project
      ? `armada-secret:v2:${JSON.stringify([slot.organization, slot.project, slot.user, slot.name])}`
      : `armada-secret:v1:${slot.organization}:${slot.user}:${slot.name}`,
  );
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

/** What the Keys page shows of a key or secret: who set it and when, never a secret's value. */
export interface SecretInfo {
  /** A key's name (`linear-api-key`) or a worker secret's (`OPENAI_API_KEY`). */
  name: string;
  /** The project it belongs to; "" for the organization's. */
  project: string;
  /** Whether it is the person's own (true) or the organization's or project's. */
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
 * installations (THE-851). `refuse` is a release Armada refused, e.g. a
 * worker asking for another project's secrets (THE-859).
 */
export type SecretAction = "set" | "delete" | "release" | "refuse" | "launch" | "exchange" | "end" | "link" | "unlink";

export interface SecretEvent {
  id: number;
  at: string;
  action: SecretAction;
  /** The project it concerns; "" for the organization's. */
  project: string;
  /** Which keys or secrets, e.g. ["linear-api-key"]. */
  keys: string[];
  actor: Actor;
  /** What happened, in words; never a value. */
  detail: string;
}

/** Whether a stored name is one the vault keeps: a key, or a worker secret. */
const known = (name: string) => isSecretName(name) || isWorkerSecretName(name);

/**
 * Lists the keys and secrets of one scope, without any secret value: the
 * organization's (`project` ""), with the person's own, or one project's.
 */
export async function listSecrets(
  client: Queryable,
  vault: VaultKey | null,
  { organization, user, project = "" }: { organization: string; user: string; project?: string },
): Promise<SecretInfo[]> {
  const rs = await client.query(
    `SELECT "userId", "name", "sealed", "setByLabel", "updatedAt" FROM "armada_secret"
     WHERE "organizationId" = $1 AND "project" = $3 AND "userId" IN ('', $2) ORDER BY "name", "userId"`,
    [organization, user, project],
  );
  return rs.rows.flatMap((row): SecretInfo[] => {
    const name = String(row.name);
    if (!known(name)) return [];
    const slot = { organization, project, user: String(row.userId), name };
    let value: string | null = null;
    let readable = vault !== null;
    if (vault)
      try {
        const opened = openSecret(vault, slot, String(row.sealed));
        if (isSecretName(name) && !SECRET_KINDS[name].secret) value = opened;
      } catch {
        readable = false;
      }
    return [
      {
        name,
        project,
        own: slot.user !== "",
        setBy: String(row.setByLabel),
        setAt: isoAt(row.updatedAt),
        value,
        readable,
      },
    ];
  });
}

/**
 * The opened values of the keys Armada reads: for `project`, the project's
 * own first, then the person's own, then the organization's. Server only: the
 * broker and the dashboard's reads.
 */
export async function readSecrets(
  client: Queryable,
  vault: VaultKey,
  { organization, user, project = null }: { organization: string; user: string | null; project?: string | null },
): Promise<{
  values: Partial<Record<SecretName, string>>;
  own: SecretName[];
  fromProject: SecretName[];
  problems: string[];
}> {
  const rs = await client.query(
    `SELECT "project", "userId", "name", "sealed" FROM "armada_secret"
     WHERE "organizationId" = $1 AND "project" IN ('', $3) AND "userId" IN ('', $2) AND "name" = ANY($4)`,
    [organization, user ?? "", project ?? "", [...SECRET_NAMES]],
  );
  // The organization's (0), the person's own over it (1), the project's over both (2).
  const rank = (r: { project: string; user: string }) => (r.project ? 2 : r.user ? 1 : 0);
  const rows = rs.rows
    .map((row) => ({ project: String(row.project), user: String(row.userId), name: String(row.name), sealed: row }))
    .sort((a, b) => rank(a) - rank(b));
  const values: Partial<Record<SecretName, string>> = {};
  const own: SecretName[] = [];
  const fromProject: SecretName[] = [];
  const problems: string[] = [];
  for (const row of rows) {
    const name = row.name;
    if (!isSecretName(name)) continue;
    if (row.user && (!user || !SECRET_KINDS[name].personal)) continue;
    if (row.project && (row.user || !SECRET_KINDS[name].project)) continue;
    const slot = { organization, project: row.project, user: row.user, name };
    try {
      values[name] = openSecret(vault, slot, String(row.sealed.sealed));
      if (row.user) own.push(name);
      if (row.project) fromProject.push(name);
    } catch (err) {
      problems.push(
        `${err instanceof Error ? err.message : String(err)}${row.project ? ` (project ${row.project})` : ""}`,
      );
    }
  }
  return {
    values,
    own: own.filter((n) => !fromProject.includes(n)),
    fromProject,
    problems,
  };
}

/** A worker secret as `armada secrets` lists it: where it is set, who set it and when. Never its value. */
export interface WorkerSecretInfo {
  name: string;
  scope: SecretScope;
  setBy: string;
  setAt: string;
  /** True for an organization's secret the project sets too: the project's wins. */
  overridden: boolean;
}

/** The worker secrets of one project: its own and the organization's, without any value. */
export async function listWorkerSecrets(
  client: Queryable,
  { organization, project }: { organization: string; project: string },
): Promise<WorkerSecretInfo[]> {
  const rs = await client.query(
    `SELECT "project", "name", "setByLabel", "updatedAt" FROM "armada_secret"
     WHERE "organizationId" = $1 AND "project" IN ('', $2) AND "userId" = '' ORDER BY "name", "project" DESC`,
    [organization, project],
  );
  const rows = rs.rows.filter((r) => isWorkerSecretName(String(r.name)));
  const inProject = new Set(rows.filter((r) => String(r.project)).map((r) => String(r.name)));
  return rows.map((r) => {
    const scope: SecretScope = String(r.project) ? "project" : "organization";
    return {
      name: String(r.name),
      scope,
      setBy: String(r.setByLabel),
      setAt: isoAt(r.updatedAt),
      overridden: scope === "organization" && inProject.has(String(r.name)),
    };
  });
}

/**
 * The opened worker secrets of one project: its own over the organization's.
 * `names` null asks for every one. Server only: the broker.
 */
export async function readWorkerSecrets(
  client: Queryable,
  vault: VaultKey,
  { organization, project, names }: { organization: string; project: string; names: string[] | null },
): Promise<{ values: Record<string, string>; scopes: Record<string, SecretScope>; problems: string[] }> {
  const rs = await client.query(
    `SELECT "project", "name", "sealed" FROM "armada_secret"
     WHERE "organizationId" = $1 AND "project" IN ('', $2) AND "userId" = ''
       AND ($3::text[] IS NULL OR "name" = ANY($3)) ORDER BY "project"`,
    [organization, project, names],
  );
  const values: Record<string, string> = {};
  const scopes: Record<string, SecretScope> = {};
  const problems: string[] = [];
  // Ordered by project: the organization's ('') first, the project's over it.
  for (const row of rs.rows) {
    const name = String(row.name);
    if (!isWorkerSecretName(name)) continue;
    const slot = { organization, project: String(row.project), user: "", name };
    try {
      values[name] = openSecret(vault, slot, String(row.sealed));
      scopes[name] = slot.project ? "project" : "organization";
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { values, scopes, problems };
}

/** What one `setSecret` or `deleteSecret` names: whose, which project's, which key or secret. */
export interface SecretTarget {
  organization: string;
  /** The project's; null or "" for the organization's (or the person's own). */
  project?: string | null;
  /** The person's own; null for the organization's or the project's. */
  user: string | null;
  name: string;
}

/** Why a target is not a slot the vault keeps; null when it is. */
export function targetRefusal({ project, user, name }: SecretTarget): string | null {
  if (isSecretName(name)) {
    if (user && !SECRET_KINDS[name].personal) return `${name} is the organization's only`;
    if (project && !SECRET_KINDS[name].project) return `${name} is the organization's only`;
    if (project && user) return `a person's own ${name} is not kept per project`;
    return null;
  }
  const refusal = workerSecretRefusal(name);
  if (refusal) return refusal;
  return user ? "a secret for workers is the organization's or a project's, never a person's own" : null;
}

const scopeWords = (t: SecretTarget) =>
  t.project ? `for the project ${t.project}` : t.user ? "their own key" : "for the organization";

/** Sets or replaces one key or worker secret. Throws on a target the vault does not keep (`targetRefusal`). */
export async function setSecret(
  client: Database,
  vault: VaultKey,
  input: SecretTarget & { value: string; actor: Actor; now: Date },
): Promise<void> {
  const refusal = targetRefusal(input);
  if (refusal) throw new Error(refusal);
  const slot = {
    organization: input.organization,
    project: input.project ?? "",
    user: input.user ?? "",
    name: input.name,
  };
  const at = input.now;
  await transaction(client, async (tx) => {
    await tx.query(
      `INSERT INTO "armada_secret" ("organizationId", "project", "userId", "name", "sealed", "setById", "setByLabel", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
       ON CONFLICT ("organizationId", "project", "userId", "name") DO UPDATE SET
         "sealed" = excluded."sealed", "setById" = excluded."setById",
         "setByLabel" = excluded."setByLabel", "updatedAt" = excluded."updatedAt"`,
      [
        slot.organization,
        slot.project,
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
      project: slot.project,
      keys: [input.name],
      actor: input.actor,
      detail: scopeWords(input),
    });
  });
}

/** Deletes one key or worker secret; true when there was one. Its next release no longer has it. */
export async function deleteSecret(
  client: Database,
  input: SecretTarget & { actor: Actor; now: Date },
): Promise<boolean> {
  return transaction(client, async (tx) => {
    const rs = await tx.query(
      `DELETE FROM "armada_secret" WHERE "organizationId" = $1 AND "project" = $2 AND "userId" = $3 AND "name" = $4`,
      [input.organization, input.project ?? "", input.user ?? "", input.name],
    );
    if (rs.rowCount > 0)
      await recordEvent(tx, input.organization, {
        at: input.now.toISOString(),
        action: "delete",
        project: input.project ?? "",
        keys: [input.name],
        actor: input.actor,
        detail: scopeWords(input),
      });
    return rs.rowCount > 0;
  });
}

// ------------------------------------------------------------ audit

export async function recordEvent(
  client: Queryable,
  organization: string,
  e: Omit<SecretEvent, "id" | "project"> & { project?: string | null },
): Promise<void> {
  await client.query(
    `INSERT INTO "armada_secret_event" ("organizationId", "project", "at", "action", "keys", "actorKind", "actorId", "actorLabel", "detail")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      organization,
      e.project ?? "",
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

/** The organization's audit list, newest first; with `project`, that project's events only. */
export async function listEvents(
  client: Queryable,
  organization: string,
  limit = 50,
  project: string | null = null,
): Promise<SecretEvent[]> {
  const rs = await client.query(
    `SELECT "id", "at", "action", "project", "keys", "actorKind", "actorId", "actorLabel", "detail" FROM "armada_secret_event"
     WHERE "organizationId" = $1 AND ($3::text IS NULL OR "project" = $3) ORDER BY "id" DESC LIMIT $2`,
    [organization, limit, project],
  );
  return rs.rows.map((r) => ({
    id: Number(r.id),
    at: isoAt(r.at),
    action: String(r.action) as SecretAction,
    project: String(r.project),
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
