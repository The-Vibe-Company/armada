import type { ModalBinding, ProviderInventoryMachine, SandboxStatus, Sql } from "@armada/core";
import { modalDeploymentId } from "@armada/provider-modal";
import { createProviderReaperLane, type ProviderReaperSource } from "./provider-reaper.ts";

interface ModalInventoryRegistration {
  app_id: string;
  app_name: string;
  environment: string;
  authority_scope: "org" | "user";
  authority_owner_id: string;
}

type OpenInventory = (
  registration: ModalInventoryRegistration,
  binding: ModalBinding,
  deploymentId: string,
) => Promise<ProviderReaperSource["inventory"] & { close(): void }>;

function reaperQuery<T>(sql: Sql, query: string, params?: unknown[]) {
  if (!sql.transaction) return sql.query<T>(query, params);
  return sql.transaction(async (tx) => {
    await tx.query("set local statement_timeout = '5s'");
    return tx.query<T>(query, params);
  });
}

async function lookupOwnership(
  sql: Sql,
  binding: ModalBinding,
  machine: ProviderInventoryMachine,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!machine.sandboxId) return { kind: "unresolved" } as const;
  const { rows } = await reaperQuery<{
    status: SandboxStatus | null;
    bound: boolean | null;
    physical_count: number;
    physical_owner_matches: boolean;
    physical_generation: string | null;
  }>(
    sql,
    `with physical as (
      select id, org_id, record->>'generation' as generation
      from public.modal_machines where record->>'physicalId'=$2 limit 2
    )
    select s.status, (g.modal_app_id=$3 and g.modal_environment=$4) as bound,
      (select count(*)::int from physical) as physical_count,
      exists(select 1 from physical p where p.id=$1 and (s.id is null or p.org_id=s.org_id)) as physical_owner_matches,
      (select p.generation from physical p where p.id=$1 and p.org_id=s.org_id limit 1) as physical_generation
    from (select 1) as probe
    left join public.sandboxes s on s.provider='modal' and s.provider_sandbox_id=$1
    left join public.goldens g on g.id=s.golden_id`,
    [machine.sandboxId, machine.machineId, binding.appId, binding.environment],
  );
  signal.throwIfAborted();
  const result = rows[0];
  if (!result || result.physical_count > 1 || (result.physical_count === 1 && !result.physical_owner_matches))
    return { kind: "unresolved" } as const;
  if (!result.status) return { kind: "absent" } as const;
  if (!result.bound) return { kind: "unresolved" } as const;
  return {
    kind: "owned" as const,
    status: result.status,
    ...(result.physical_generation ? { generation: result.physical_generation } : {}),
  };
}

export function createModalReaper(
  sql: Sql,
  publicUrl: string,
  openInventory: OpenInventory,
  log?: (line: string) => void,
  now?: () => number,
) {
  return createProviderReaperLane(
    async (signal) => {
      const { rows } = await reaperQuery<ModalInventoryRegistration>(
        sql,
        `select distinct app_id, app_name, environment, authority_scope, authority_owner_id
       from public.modal_server_apps
       where authority_scope='user' or authority_owner_id=org_id`,
      );
      return rows.map((registration) => {
        const { app_id: appId, environment } = registration;
        const binding: ModalBinding = { workspace: `app:${appId}`, appId, environment };
        const deploymentId = modalDeploymentId(environment, publicUrl);
        return {
          provider: "modal",
          sourceId: appId,
          deploymentId,
          inventory: {
            async *listInventory() {
              signal.throwIfAborted();
              const connection = await openInventory(registration, binding, deploymentId);
              try {
                signal.throwIfAborted();
                yield* connection.listInventory(signal);
              } finally {
                connection.close();
              }
            },
          },
          lookupOwnership: (machine, signal) => lookupOwnership(sql, binding, machine, signal),
        } satisfies ProviderReaperSource;
      });
    },
    log,
    now,
  );
}
