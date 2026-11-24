import { createSqlVaultStore, resolveBoatKey, type Sql, type VaultStore } from "@armada/core/server";
import { createBoatMachine } from "@armada/provider-boat";
import { createObservedBoatProvider } from "../observed-boat.ts";
import type { RuntimeConfigurationTarget } from "../runtime-configuration.ts";
import {
  type BoatAuthority,
  boatAuthority,
  boatLaunchPayload,
  runFailedModalLaunchDelete,
  runModalLaunch,
} from "./modal-launch.ts";
import type { Job, JobContext } from "./runner.ts";

export function boatLaunchJobs(options: {
  sql: Sql;
  store: VaultStore;
  encryptionKey: string;
  deploymentId: string;
  prepareTicket: Parameters<typeof import("./modal-launch.ts").createModalLaunchJob>[3];
}) {
  const { sql, store, encryptionKey, deploymentId, prepareTicket } = options;
  async function target(job: Job) {
    const {
      rows: [row],
    } = await sql.query<RuntimeConfigurationTarget & { sourceVisibility: "org" | "private" }>(
      `select s.id, s.org_id as "orgId", s.owner_id as "ownerId", s.provider, s.harness, s.status,
              s.deleted_at as "deletedAt", s.stop_requested_at as "stopRequestedAt",
              s.expires_at as "expiresAt", s.credential_id as "credentialId",
              s.credential_version as "credentialVersion", s.repository_dir as "repositoryDir",
              s.source_golden_visibility as "sourceVisibility"
       from public.sandboxes s join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
       where s.id=$1 and s.lifecycle_generation=$2 and exists(select 1 from public.jobs j where j.id=$3 and j.org_id=s.org_id and j.sandbox_id=s.id and j.generation=s.lifecycle_generation) and s.provider='boat' and s.boat_runtime
         and s.deleted_at is null`,
      [job.sandbox_id, job.generation, job.id],
    );
    if (!row) throw new Error("Boat launch target is unavailable.");
    return row;
  }
  async function placement(sandbox: Awaited<ReturnType<typeof target>>, authority: BoatAuthority) {
    const resolve = (tx?: Sql) =>
      resolveBoatKey(tx ? createSqlVaultStore(tx) : store, encryptionKey, {
        userId: sandbox.ownerId,
        orgId: sandbox.orgId,
        visibility: sandbox.sourceVisibility,
      });
    const { key, scope } = await resolve();
    const host = createObservedBoatProvider({ apiKey: key, deploymentId }, sandbox.id);
    if (scope !== authority.scope || (await host.backendIdentity?.())?.id !== authority.backendId)
      throw new Error("Boat launch authority changed.");
    return {
      host,
      options: { apiKey: key, deploymentId },
      async current(tx?: Sql) {
        const current = await resolve(tx);
        return current.scope === scope && current.key === key;
      },
    };
  }
  return {
    launch(job: Job, context: JobContext) {
      const prepare = async () => {
        const { allocation, boat } = boatLaunchPayload.parse(job.payload);
        const sandbox = await target(job);
        const binding = await placement(sandbox, boat);
        return {
          boat: true as const,
          allocation,
          bindingRef: job.id,
          machine: (ticket: Parameters<typeof createBoatMachine>[2], authorize: () => Promise<void>) =>
            createBoatMachine(binding.options, binding.host, ticket, authorize),
          canUseModalCredential: binding.current,
          prepareRuntimeTicket: () => prepareTicket(sandbox),
        };
      };
      return runModalLaunch(sql, encryptionKey, job, context, prepare, "boat");
    },
    cleanup(job: Job, context: JobContext) {
      return runFailedModalLaunchDelete(sql, job, context, undefined, async (authorize) => {
        const authority = boatAuthority.parse((job.payload as { boat?: unknown }).boat);
        const binding = await placement(await target(job), authority);
        return createBoatMachine(
          binding.options,
          binding.host,
          async () => null,
          async () => {
            if (!(await binding.current())) throw new Error("Boat cleanup authority changed.");
            await authorize();
          },
        );
      });
    },
  };
}
