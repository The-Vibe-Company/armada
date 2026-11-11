import type { ApplicationVaultActor } from "./application-vault.ts";
import type { Sql } from "./golden-store.ts";
import type { Routine } from "./routines.ts";
import { VaultError } from "./vault-error.ts";

type Row = {
  id: string;
  org_id: string;
  owner_id: string;
  scope: "personal" | "org";
  name: string;
  template_id: string;
  template_revision: number;
  prompt: string;
  interval_hours: number;
  max_runs_per_day: number;
  ttl_seconds: number;
  status: "paused" | "deleted";
  version: number;
  created_at: string | Date;
  updated_at: string | Date;
};
function dto(r: Row): Routine {
  return {
    id: r.id,
    orgId: r.org_id,
    ownerId: r.owner_id,
    scope: r.scope,
    name: r.name,
    templateId: r.template_id,
    templateRevision: r.template_revision,
    prompt: r.prompt,
    intervalHours: r.interval_hours,
    maxRunsPerDay: r.max_runs_per_day,
    ttlSeconds: r.ttl_seconds,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function invalid(): never {
  throw new VaultError("invalid", "Invalid routine request.");
}
function id(v: unknown): string {
  if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) invalid();
  return v;
}
function integer(v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) invalid();
  return v;
}
function text(v: unknown, max: number): string {
  if (typeof v !== "string" || !v.trim() || v.length > max || v.includes("\0")) invalid();
  return v;
}
const configFields = [
  "name",
  "templateId",
  "templateRevision",
  "prompt",
  "intervalHours",
  "maxRunsPerDay",
  "ttlSeconds",
];
/** Service-role writes, with current membership checks in the same transaction as each operation. */
export function createRoutineService(sql: Sql) {
  async function command(
    actor: ApplicationVaultActor,
    operation: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const fields: Record<string, string[]> = {
      create: ["org", "scope", ...configFields],
      list: ["org"],
      get: ["org", "id"],
      update: ["org", "id", "expectedVersion", ...configFields],
      delete: ["org", "id", "expectedVersion"],
    };
    if (!Object.hasOwn(fields, operation) || Object.keys(input).some((k) => !fields[operation]?.includes(k))) invalid();
    const org = id(input.org);
    if (!actor.orgs.some((o) => o.orgId === org)) throw new VaultError("forbidden", "Routine access denied.");
    if (!sql.transaction) throw new VaultError("unavailable", "Routine transactions unavailable.");
    try {
      return await sql.transaction(async (tx) => {
        const member = (
          await tx.query<{ role: string }>("select role from public.members where org_id=$1 and user_id=$2 for share", [
            org,
            actor.userId,
          ])
        ).rows[0];
        if (!member) throw new VaultError("forbidden", "Routine access denied.");
        if (operation === "list")
          return {
            items: (
              await tx.query<Row>(
                "select * from public.routines where org_id=$1 and (scope='org' or owner_id=$2) and status='paused' order by name,id",
                [org, actor.userId],
              )
            ).rows.map(dto),
          };
        let current: Row | undefined;
        if (operation !== "create") {
          current = (
            await tx.query<Row>(
              "select * from public.routines where id=$1 and org_id=$2 and (scope='org' or owner_id=$3) and status='paused' for update",
              [id(input.id), org, actor.userId],
            )
          ).rows[0];
          if (!current) throw new VaultError("not_found", "Routine unavailable.");
          if (operation === "get") return { item: dto(current) };
          if (current.version !== integer(input.expectedVersion, 1, 2147483647))
            throw new VaultError("conflict", "Routine version changed.");
        }
        const scope = current?.scope ?? input.scope;
        if (scope !== "personal" && scope !== "org") invalid();
        if (scope === "org" && member.role !== "admin")
          throw new VaultError("forbidden", "Routine administrator permission required.");
        if (operation === "delete") {
          const row = (
            await tx.query<Row>(
              "update public.routines set status='deleted',version=version+1,updated_at=now() where id=$1 returning *",
              [current!.id],
            )
          ).rows[0]!;
          return { item: dto(row) };
        }
        if (
          current &&
          !(
            await tx.query("select user_id from public.members where org_id=$1 and user_id=$2 for share", [
              org,
              current.owner_id,
            ])
          ).rows.length
        )
          throw new VaultError("conflict", "Routine owner is no longer an organization member.");
        const name = text(input.name, 200),
          templateId = id(input.templateId),
          revision = integer(input.templateRevision, 1, 2147483647);
        const prompt = text(input.prompt, 32000),
          interval = integer(input.intervalHours === undefined && !current ? 24 : input.intervalHours, 1, 720),
          max = integer(input.maxRunsPerDay === undefined && !current ? 24 : input.maxRunsPerDay, 1, 24),
          ttl = integer(input.ttlSeconds === undefined && !current ? 3600 : input.ttlSeconds, 300, 86400);
        // An org routine must not turn an author's personal template into shared automation.
        const template = (
          await tx.query<{ id: string }>(
            `select t.id from public.launch_templates t join public.launch_template_revisions r on r.template_id=t.id and r.revision=$2
          where t.id=$1 and t.org_id=$3 and t.status='active' and (t.scope='org' or (t.owner_id=$4 and $5='personal')) for share of t`,
            [templateId, revision, org, actor.userId, scope],
          )
        ).rows[0];
        if (!template) throw new VaultError("not_found", "Routine template revision unavailable.");
        const params = [name, templateId, revision, prompt, interval, max, ttl];
        const row = current
          ? (
              await tx.query<Row>(
                "update public.routines set name=$1,template_id=$2,template_revision=$3,prompt=$4,interval_hours=$5,max_runs_per_day=$6,ttl_seconds=$7,version=version+1,updated_at=now() where id=$8 returning *",
                [...params, current.id],
              )
            ).rows[0]!
          : (
              await tx.query<Row>(
                "insert into public.routines(name,template_id,template_revision,prompt,interval_hours,max_runs_per_day,ttl_seconds,org_id,owner_id,scope) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *",
                [...params, org, actor.userId, scope],
              )
            ).rows[0]!;
        return { item: dto(row) };
      });
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("unavailable", "Routine service unavailable.");
    }
  }
  return { command };
}
export type RoutineService = ReturnType<typeof createRoutineService>;
