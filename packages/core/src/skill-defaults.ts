import type { ApplicationVaultActor } from "./application-vault.ts";
import { skillDefaultOperations } from "./contract/skill-defaults.ts";
import type { GoldenActor, GoldenRecord } from "./golden.ts";
import type { Sql } from "./golden-store.ts";
import { validateSkillPins } from "./skillpack.ts";
import { VaultError } from "./vault-error.ts";

type Scope = "personal" | "org" | "golden";
type GoldenAccess = { id: string; visibility: "private" | "org"; owner_id: string };
function invalid(): never {
  throw new VaultError("invalid", "Invalid skill defaults request.");
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
    return parseSkills(row?.skills ?? []);
  }
  function parseSkills(skills: unknown) {
    try {
      validateSkillPins(skills);
    } catch {
      throw new VaultError("unavailable", "Skill defaults unavailable.");
    }
    return [...skills];
  }
  return {
    async command(
      actor: ApplicationVaultActor,
      operation: string,
      input: Record<string, unknown>,
    ): Promise<{ skills: string[] }> {
      if (operation !== "get" && operation !== "set") invalid();
      const { readSkillDefaults, setSkillDefaults } = skillDefaultOperations;
      const replacement = operation === "set" ? setSkillDefaults.input.body.safeParse(input) : undefined;
      const parsed = replacement ?? readSkillDefaults.input.body.safeParse(input);
      if (!parsed.success) invalid();
      const target = parsed.data;
      const { org: orgId, scope } = target;
      const skills = replacement?.data?.skills;
      if (!actor.orgs.some((org) => org.orgId === orgId))
        throw new VaultError("forbidden", "Skill defaults access denied.");
      return transaction(async (tx) => {
        const role = await membership(tx, actor.userId, orgId);
        const golden = scope === "golden" ? await goldenAccess(tx, actor.userId, orgId, target.goldenId) : undefined;
        if (operation === "set" && (scope === "org" || golden?.visibility === "org") && role !== "admin")
          throw new VaultError("forbidden", "Skill defaults administrator permission required.");
        const key = scope === "golden" ? target.goldenId : scope === "personal" ? actor.userId : orgId;
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
    resolveInTransaction: (actor: GoldenActor, golden: GoldenRecord | null) => resolveInTransaction(sql, actor, golden),
    async resolve(
      actor: GoldenActor,
      golden: GoldenRecord | null,
    ): Promise<{ environment: string[]; org: string[]; personal: string[] }> {
      return transaction((tx) => resolveInTransaction(tx, actor, golden));
    },
  };
  async function resolveInTransaction(tx: Sql, actor: GoldenActor, golden: GoldenRecord | null) {
    if (golden && actor.orgId !== golden.orgId) throw new VaultError("not_found", "Golden unavailable.");
    try {
      const {
        rows: [row],
      } = await tx.query<{
        golden_id: string | null;
        environment: unknown;
        org: unknown;
        personal: unknown;
      }>(
        `with membership as materialized (
           select user_id from public.members where org_id=$1 and user_id=$2 for share
         )
         select g.id as golden_id,
           coalesce((select skills from public.golden_skill_defaults where golden_id=g.id), '[]'::jsonb) as environment,
           coalesce((select skills from public.org_skill_defaults where org_id=$1), '[]'::jsonb) as org,
           coalesce((select skills from public.personal_skill_defaults where user_id=m.user_id), '[]'::jsonb) as personal
         from membership m left join lateral (
           select id from public.goldens where id=$3 and org_id=$1 and removed_at is null
             and (visibility='org' or owner_id=m.user_id) for share
         ) g on true`,
        [actor.orgId, actor.userId, golden?.id ?? null],
      );
      if (!row) throw new VaultError("forbidden", "Skill defaults access denied.");
      if (golden && !row.golden_id) throw new VaultError("not_found", "Golden unavailable.");
      return {
        environment: parseSkills(row.environment),
        org: parseSkills(row.org),
        personal: parseSkills(row.personal),
      };
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError("unavailable", "Skill defaults unavailable.");
    }
  }
}
export type SkillDefaultsService = ReturnType<typeof createSkillDefaultsService>;
