import { createHash, randomBytes } from "node:crypto";
import { encryptSecret } from "./crypto.ts";
import type { Sql } from "./golden-store.ts";
import { VaultError } from "./vault-error.ts";

type Kind = "variable" | "secret";
type Operation = "list" | "read" | "set" | "update" | "rotate" | "revoke" | "delete" | "upload" | "commit";
export interface ApplicationVaultActor {
  userId: string;
  orgs: readonly { orgId: string }[];
}
interface Row {
  id: string;
  org_id: string;
  owner_id: string;
  scope: "personal" | "org";
  name: string;
  version: number;
  epoch: number;
  status: "active" | "revoked" | "deleted";
  expires_at?: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}
const columns = "id,org_id,owner_id,scope,name,version,epoch,status,created_at,updated_at";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const prefixes = /^(ARMADA_|BOAT_|MODAL_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|GH_|GITHUB_|MCP_|LD_|DYLD_)/i;
const reserved = new Set([
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
function invalid(): never {
  throw new VaultError("invalid", "Invalid application vault request.");
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) invalid();
  return value;
}
function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}
function name(value: unknown, kind: Kind): string {
  if (
    typeof value !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(value) ||
    prefixes.test(value) ||
    reserved.has(value.toUpperCase()) ||
    (kind === "secret" && /^(NEXT_PUBLIC_|VITE_|PUBLIC_)/i.test(value))
  )
    invalid();
  return value;
}
function value(input: unknown, kind: Kind): string {
  if (
    typeof input !== "string" ||
    input.includes("\0") ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(input) ||
    Buffer.byteLength(input, "utf8") > 8192 ||
    (kind === "secret" && !input.length)
  )
    invalid();
  return input;
}
function expiry(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "string" || !/^\d{4}-\d\d-\d\dT/.test(input) || !Number.isFinite(Date.parse(input))) invalid();
  return new Date(input).toISOString();
}
function metadata(row: Row) {
  return {
    id: row.id,
    orgId: row.org_id,
    ownerId: row.owner_id,
    scope: row.scope,
    name: row.name,
    version: row.version,
    epoch: row.epoch,
    status: row.status,
    ...(row.expires_at !== undefined
      ? { expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
const hash = (reference: string) => createHash("sha256").update(reference).digest("hex");

/** Server-only management. No decryption, delivery or secret-value read operation exists. */
export function createApplicationVault(sql: Sql, encryptionKey: string | undefined) {
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    if (!sql.transaction) throw new VaultError("unavailable", "Application vault transactions unavailable.");
    try {
      return await sql.transaction(work);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505")
        throw new VaultError("conflict", "An application vault name is already in use.");
      // Database/encryption errors can contain submitted data. Never forward their text or cause.
      throw new VaultError("unavailable", "Application vault unavailable.");
    }
  }
  async function membership(tx: Sql, actor: ApplicationVaultActor, orgId: string) {
    if (!actor.orgs.some((org) => org.orgId === orgId))
      throw new VaultError("forbidden", "Application vault access denied.");
    const m = (
      await tx.query<{ role: string }>(
        "select role from public.members where org_id=$1::uuid and user_id=$2::uuid for share",
        [orgId, actor.userId],
      )
    ).rows[0];
    if (!m) throw new VaultError("forbidden", "Application vault access denied.");
    return m.role;
  }
  async function audit(tx: Sql, actor: ApplicationVaultActor, kind: Kind, op: string, row: Row) {
    await tx.query(
      `insert into public.application_vault_audit(org_id,owner_id,scope,actor_id,resource_id,kind,operation,version,epoch)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [row.org_id, row.owner_id, row.scope, actor.userId, row.id, kind, op, row.version, row.epoch],
    );
  }
  async function mutate(
    tx: Sql,
    actor: ApplicationVaultActor,
    kind: Kind,
    operation: Operation,
    input: Record<string, unknown>,
    sealed?: Uint8Array,
  ) {
    const orgId = identifier(input.org);
    const role = await membership(tx, actor, orgId);
    const table = kind === "variable" ? "readable_variables" : "application_secrets";
    const projection = columns + (kind === "secret" ? ",expires_at" : "");
    if (operation === "list") {
      const rows = (
        await tx.query<Row>(
          `select ${projection} from public.${table} where org_id=$1 and (scope='org' or owner_id=$2) and status<>'deleted' order by created_at,id`,
          [orgId, actor.userId],
        )
      ).rows;
      return { items: rows.map(metadata) };
    }
    if (operation === "set") {
      if (input.scope !== "personal" && input.scope !== "org") invalid();
      if (input.scope === "org" && role !== "admin")
        throw new VaultError("forbidden", "Application vault access denied.");
      const key = name(input.name, kind);
      if (kind === "secret" && typeof input.value === "string" && key.includes(input.value)) invalid();
      const payload =
        kind === "variable"
          ? value(input.value, kind)
          : (sealed ?? (await encryptSecret(value(input.value, kind), encryptionKey)));
      const row = (
        await tx.query<Row>(
          `insert into public.${table}(org_id,owner_id,scope,name,${kind === "secret" ? "value_enc,expires_at" : "value"})
        values($1,$2,$3,$4,$5${kind === "secret" ? ",$6" : ""}) returning ${projection}`,
          [orgId, actor.userId, input.scope, key, payload, ...(kind === "secret" ? [expiry(input.expiresAt)] : [])],
        )
      ).rows[0];
      if (!row) throw new VaultError("unavailable", "Application vault unavailable.");
      await audit(tx, actor, kind, operation, row);
      return { item: metadata(row) };
    }
    const id = identifier(input.id);
    const current = (
      await tx.query<Row>(
        `select ${projection} from public.${table} where id=$1 and org_id=$2 and (scope='org' or owner_id=$3) for update`,
        [id, orgId, actor.userId],
      )
    ).rows[0];
    if (!current) throw new VaultError("not_found", "Application vault resource unavailable.");
    if (operation === "read" && kind === "variable") {
      if (current.status !== "active") throw new VaultError("not_found", "Application vault resource unavailable.");
      const row = (await tx.query<{ value: string }>(`select value from public.${table} where id=$1`, [id])).rows[0];
      return { item: metadata(current), value: row?.value };
    }
    if (current.scope === "org" && role !== "admin")
      throw new VaultError("forbidden", "Application vault access denied.");
    const expected = version(input.expectedVersion);
    if (current.version !== expected) throw new VaultError("conflict", "Application vault version changed.");
    if (
      (operation === "delete" && current.status === "deleted") ||
      (operation === "revoke" && current.status === "revoked")
    )
      return { item: metadata(current) };
    if (
      current.status === "deleted" ||
      ((operation === "update" || operation === "rotate") && current.status !== "active")
    )
      throw new VaultError("conflict", "Application vault resource is not active.");
    if (
      kind === "secret" &&
      typeof input.value === "string" &&
      (typeof input.name === "string" ? input.name : current.name).includes(input.value)
    )
      invalid();
    const changes: string[] = ["version=version+1", "epoch=epoch+1", "updated_at=now()"];
    const params: unknown[] = [id, expected];
    if (operation === "update" || operation === "rotate") {
      if (input.name !== undefined) {
        params.push(name(input.name, kind));
        changes.push(`name=$${params.length}`);
      }
      if (input.value !== undefined || sealed) {
        params.push(
          kind === "variable"
            ? value(input.value, kind)
            : (sealed ?? (await encryptSecret(value(input.value, kind), encryptionKey))),
        );
        changes.push(`${kind === "variable" ? "value" : "value_enc"}=$${params.length}`);
      } else if (operation === "rotate") invalid();
      if (kind === "secret" && input.expiresAt !== undefined) {
        params.push(expiry(input.expiresAt));
        changes.push(`expires_at=$${params.length}`);
      }
    } else {
      changes.push(
        `status='${operation === "delete" ? "deleted" : "revoked"}'`,
        `${kind === "variable" ? "value" : "value_enc"}=null`,
      );
    }
    const row = (
      await tx.query<Row>(
        `update public.${table} set ${changes.join(",")} where id=$1 and version=$2 returning ${projection}`,
        params,
      )
    ).rows[0];
    if (!row) throw new VaultError("conflict", "Application vault version changed.");
    await audit(tx, actor, kind, operation, row);
    return { item: metadata(row) };
  }
  return {
    /** Called by the server's existing retention worker; no tombstone or active object is removed. */
    async purgeExpired(): Promise<void> {
      await transaction(async (tx) => {
        await tx.query("delete from public.application_secret_uploads where expires_at<=clock_timestamp()");
        await tx.query(
          "delete from public.application_vault_audit where created_at<=clock_timestamp()-interval '90 days'",
        );
      });
    },
    async command(
      actor: ApplicationVaultActor,
      kind: Kind,
      operation: Operation,
      input: Record<string, unknown>,
      ingress: "api" | "mcp" = "api",
    ): Promise<Record<string, unknown>> {
      const allowed: Record<string, string[]> = {
        list: ["org"],
        read: ["org", "id"],
        set: ["org", "scope", "name", "value", "expiresAt"],
        update: ["org", "id", "expectedVersion", "name", "value"],
        rotate: ["org", "id", "expectedVersion", "name", "value", "expiresAt"],
        revoke: ["org", "id", "expectedVersion"],
        delete: ["org", "id", "expectedVersion"],
        upload: ["org", "operation", "id", "expectedVersion", "scope", "name", "value", "expiresAt"],
        commit: ["org", "uploadReference"],
      };
      if (!Object.hasOwn(allowed, operation) || Object.keys(input).some((key) => !allowed[operation]?.includes(key)))
        invalid();
      if (
        (kind === "secret" && operation === "read") ||
        (kind === "variable" && ["rotate", "upload", "commit"].includes(operation)) ||
        (kind === "secret" && operation === "update") ||
        (ingress === "mcp" && kind === "secret" && ["set", "rotate", "upload"].includes(operation))
      )
        invalid();
      if (kind === "variable" && input.expiresAt !== undefined) invalid();
      if (operation === "update" && input.name === undefined && input.value === undefined) invalid();
      if (operation === "upload" && input.operation === "rotate" && input.scope !== undefined) invalid();
      return transaction(async (tx) => {
        if (operation === "upload") {
          if (kind !== "secret" || (input.operation !== "set" && input.operation !== "rotate")) invalid();
          const orgId = identifier(input.org),
            role = await membership(tx, actor, orgId);
          let scope = input.scope,
            key = input.name,
            secretExpiry = expiry(input.expiresAt);
          if (input.operation === "rotate") {
            const row = (
              await tx.query<Row>(
                `select ${columns},expires_at from public.application_secrets where id=$1 and org_id=$2 and (scope='org' or owner_id=$3) for update`,
                [identifier(input.id), orgId, actor.userId],
              )
            ).rows[0];
            if (!row) throw new VaultError("not_found", "Application vault resource unavailable.");
            if (row.version !== version(input.expectedVersion) || row.status !== "active")
              throw new VaultError("conflict", "Application vault version changed.");
            scope = row.scope;
            key = input.name ?? row.name;
            // Upload captures the current expiry when omitted; the pinned version fences commit.
            if (input.expiresAt === undefined)
              secretExpiry = row.expires_at instanceof Date ? row.expires_at.toISOString() : expiry(row.expires_at);
          } else if (input.id !== undefined || input.expectedVersion !== undefined) invalid();
          if (scope !== "personal" && scope !== "org") invalid();
          if (scope === "org" && role !== "admin")
            throw new VaultError("forbidden", "Application vault access denied.");
          if (typeof key === "string" && typeof input.value === "string" && key.includes(input.value)) invalid();
          const reference = randomBytes(32).toString("base64url");
          const ciphertext = await encryptSecret(value(input.value, kind), encryptionKey);
          await tx.query("delete from public.application_secret_uploads where expires_at<=now()");
          await tx.query(
            `insert into public.application_secret_uploads(hash,actor_id,org_id,operation,target_id,expected_version,scope,name,value_enc,secret_expires_at)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              hash(reference),
              actor.userId,
              orgId,
              input.operation,
              input.id ?? null,
              input.expectedVersion ?? null,
              scope,
              name(key, kind),
              ciphertext,
              secretExpiry,
            ],
          );
          return { uploadReference: reference, expiresInSeconds: 300 };
        }
        if (operation === "commit") {
          const orgId = identifier(input.org);
          await membership(tx, actor, orgId);
          if (typeof input.uploadReference !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.uploadReference))
            invalid();
          const upload = (
            await tx.query<{
              operation: "set" | "rotate";
              target_id: string | null;
              expected_version: number | null;
              scope: string;
              name: string;
              value_enc: Uint8Array;
              secret_expires_at: string | Date | null;
            }>(
              `delete from public.application_secret_uploads where hash=$1 and actor_id=$2 and org_id=$3 and expires_at>clock_timestamp() returning operation,target_id,expected_version,scope,name,value_enc,secret_expires_at`,
              [hash(input.uploadReference), actor.userId, orgId],
            )
          ).rows[0];
          if (!upload) throw new VaultError("not_found", "Secret upload unavailable.");
          return mutate(
            tx,
            actor,
            kind,
            upload.operation,
            {
              org: orgId,
              id: upload.target_id,
              expectedVersion: upload.expected_version,
              scope: upload.scope,
              name: upload.name,
              expiresAt:
                upload.secret_expires_at instanceof Date
                  ? upload.secret_expires_at.toISOString()
                  : upload.secret_expires_at,
            },
            upload.value_enc,
          );
        }
        return mutate(tx, actor, kind, operation, input);
      });
    },
  };
}
export type ApplicationVault = ReturnType<typeof createApplicationVault>;
