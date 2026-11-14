import {
  createRoutineScheduler,
  type ProviderRegistry,
  type Sql,
  type TemplateService,
  VaultError,
} from "@armada/core/server";
import type { ControlOptions } from "./control.ts";
import type { DataSource } from "./data.ts";
import { templateRuntime } from "./launch-control.ts";
import { observeRoutinePrompt } from "./routine-observer.ts";

interface ServerRoutineOptions {
  sql: Sql;
  control: Parameters<typeof templateRuntime>[0] & Pick<ControlOptions, "dockerControls">;
  templates: TemplateService;
  providers: ProviderRegistry;
  data: DataSource;
}

/** Routine execution is always rebound to the persisted owner's current membership. */
export function createServerRoutineScheduler({ sql, control, templates, providers, data }: ServerRoutineOptions) {
  return createRoutineScheduler(sql, {
    observe: async (actor, turn) => {
      const orgId = actor.orgs[0]?.orgId;
      const member = (
        await sql.query<{ role: "admin" | "member" }>(
          "select role from public.members where org_id=$1 and user_id=$2",
          [orgId, actor.userId],
        )
      ).rows[0];
      if (!member) return "unknown";
      const caller = { userId: actor.userId, orgs: [{ orgId: orgId!, role: member.role }], via: "service" as const };
      return observeRoutinePrompt(caller, turn, {
        ...(control.dockerControls ? { docker: control.dockerControls } : {}),
        get: (id) => data(caller).sandboxes.get(id),
        provider: (sandbox) => providers.resolve(sandbox, caller),
      });
    },
    launch: async (actor, input, admission) => {
      // Re-read the persisted execution owner's role, never impersonate the editing admin.
      const orgId = input.org as string;
      const member = (
        await sql.query<{ role: "admin" | "member" }>(
          "select role from public.members where org_id=$1 and user_id=$2",
          [orgId, actor.userId],
        )
      ).rows[0];
      if (!member) throw new Error("Routine owner unavailable.");
      const caller = { userId: actor.userId, orgs: [{ orgId, role: member.role }], via: "service" as const };
      const runtime = templateRuntime(control, caller);
      if (!runtime) throw new VaultError("unavailable", "Routine launch runtime unavailable.");
      const authorize = async (tx: Sql = sql) => {
        const grant = (
          await tx.query(
            `select m.user_id from public.routine_runs run
          join public.routines r on r.id=run.routine_id
          join public.members m on m.org_id=r.org_id and m.user_id=run.owner_id
          where run.request_key=$1 and run.owner_id=$2 and run.org_id=$3
          and (r.scope='personal' or m.role='admin')`,
            [input.requestKey, actor.userId, orgId],
          )
        ).rows[0];
        if (!grant) throw new VaultError("forbidden", "Routine owner authorization changed.");
      };
      return templates.command(caller, "launch", input, {
        ...runtime,
        beforeDockerReserve: async (tx: Sql, id: string) => {
          await authorize(tx);
          await admission.beforeFork(tx);
          await runtime.options?.beforeFork?.(id);
        },
        beforeDockerStart: () => authorize(),
        options: {
          ...runtime.options,
          beforeFork: async (id) => {
            await authorize();
            await runtime.options?.beforeFork?.(id);
            await admission.beforeFork();
          },
          beforeStart: async (provider, sandbox) => {
            await authorize();
            await runtime.options?.beforeStart?.(provider, sandbox);
          },
        },
      });
    },
  });
}
