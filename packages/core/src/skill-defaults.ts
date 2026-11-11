import type { ApplicationVaultActor } from "./application-vault.ts";
import type { GoldenActor, GoldenRecord } from "./golden.ts";
import type { Sql } from "./golden-store.ts";
import { validateSkillPins } from "./skillpack.ts";
import { VaultError } from "./vault-error.ts";

type Scope = "personal" | "org" | "golden";
type GoldenAccess = { id: string; visibility: "private" | "org"; owner_id: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never {
  throw new VaultError("invalid", "Invalid skill defaults request.");
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) invalid();
  return value;
}
function pins(value: unknown): string[] {
  try {
    validateSkillPins(value);
  } catch {
    invalid();
  }
  return [...(value as string[])];
}

/** Service-owned writes; personal defaults belong to the user, not the selected organization. */
export function createSkillDefaultsService(sql: Sql) {
  async function transaction<T>(work: (tx: Sql) => Promise<T>): Promise<T> {
    if (!sql.transaction) throw new VaultError("unavailable", "Skill defaults unavailable.");
    try {
      return await sql.transaction(work);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("unavailable", "Skill defaults unavailable.");
    }
  }
  async function membership(tx: Sql, userId: string, orgId: string) {
    const member = (
      await tx.query<{ role: "admin" | "member" }>(
        "select role from public.members where org_id=$1 and user_id=$2 for share",
        [orgId, userId],
      )
    ).rows[0];
    if (!member) throw new VaultError("forbidden", "Skill defaults access denied.");
    return member.role;
  }
  async function goldenAccess(tx: Sql, userId: string, orgId: string, goldenId: string): Promise<GoldenAccess> {
    const golden = (
      await tx.query<GoldenAccess>(
        `select id,visibility,owner_id from public.goldens where id=$1 and org_id=$2
         and removed_at is null and (visibility='org' or owner_id=$3) for share`,
        [goldenId, orgId, userId],
      )
    ).rows[0];
    if (!golden) throw new VaultError("not_found", "Golden unavailable.");
    return golden;
  }
  const targets = {
    personal: { table: "personal_skill_defaults", key: "user_id" },
    org: { table: "org_skill_defaults", key: "org_id" },
    golden: { table: "golden_skill_defaults", key: "golden_id" },
  } as const;
  async function read(tx: Sql, scope: Scope, key: string): Promise<string[]> {
    const target = targets[scope];
    const row = (
      await tx.query<{ skills: unknown }>(`select skills from public.${target.table} where ${target.key}=$1`, [key])
    ).rows[0];
    if (!row) return [];
    try {
      validateSkillPins(row.skills);
    } catch {
      throw new VaultError("unavailable", "Skill defaults unavailable.");
    }
    return [...row.skills];
  }
  return {
    async command(
      actor: ApplicationVaultActor,
      operation: string,
      input: Record<string, unknown>,
    ): Promise<{ skills: string[] }> {
      if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
      if (operation !== "get" && operation !== "set") invalid();
      const allowed = operation === "set" ? ["org", "scope", "goldenId", "skills"] : ["org", "scope", "goldenId"];
      if (Object.keys(input).some((key) => !allowed.includes(key))) invalid();
      const orgId = identifier(input.org);
      const scope = input.scope;
      if (scope !== "personal" && scope !== "org" && scope !== "golden") invalid();
      if (scope !== "golden" && Object.hasOwn(input, "goldenId")) invalid();
      const goldenId = scope === "golden" ? identifier(input.goldenId) : undefined;
      const skills = operation === "set" ? pins(input.skills) : undefined;
      if (!actor.orgs.some((org) => org.orgId === orgId))
        throw new VaultError("forbidden", "Skill defaults access denied.");
      return transaction(async (tx) => {
        const role = await membership(tx, actor.userId, orgId);
        const golden = goldenId ? await goldenAccess(tx, actor.userId, orgId, goldenId) : undefined;
        if (operation === "set" && (scope === "org" || golden?.visibility === "org") && role !== "admin")
          throw new VaultError("forbidden", "Skill defaults administrator permission required.");
        const key = scope === "personal" ? actor.userId : scope === "org" ? orgId : identifier(goldenId);
        if (skills) {
          const target = targets[scope];
          await tx.query(
            `insert into public.${target.table}(${target.key},skills) values($1,$2::text::jsonb)
             on conflict(${target.key}) do update set skills=excluded.skills,updated_at=now()`,
            [key, JSON.stringify(skills)],
          );
          return { skills };
        }
        return { skills: await read(tx, scope, key) };
      });
    },
    /** Trusted server callers must already own the supplied SQL transaction. */
    resolveInTransaction: (actor: GoldenActor, golden: GoldenRecord) => resolveInTransaction(sql, actor, golden),
    async resolve(
      actor: GoldenActor,
      golden: GoldenRecord,
    ): Promise<{ environment: string[]; org: string[]; personal: string[] }> {
      return transaction((tx) => resolveInTransaction(tx, actor, golden));
    },
  };
  async function resolveInTransaction(tx: Sql, actor: GoldenActor, golden: GoldenRecord) {
    if (actor.orgId !== golden.orgId) throw new VaultError("not_found", "Golden unavailable.");
    try {
      await membership(tx, actor.userId, actor.orgId);
      await goldenAccess(tx, actor.userId, actor.orgId, golden.id);
      return {
        environment: await read(tx, "golden", golden.id),
        org: await read(tx, "org", actor.orgId),
        personal: await read(tx, "personal", actor.userId),
      };
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("unavailable", "Skill defaults unavailable.");
    }
  }
}
export type SkillDefaultsService = ReturnType<typeof createSkillDefaultsService>;
