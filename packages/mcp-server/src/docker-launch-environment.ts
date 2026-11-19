import type { Harness } from "@armada/core";
import { decryptSecret, type Sql, VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createRuntimeEnvironmentDelivery } from "./runtime-launch-environment.ts";

/** Delivery of frozen readable values and current version-pinned secrets through the existing runtime RPC.
 * Never re-resolve readable sources; secret references revalidate on each new turn.
 */
export function createDockerLaunchEnvironment(
  sql: Sql,
  key: string,
  clock?: { now(): number; wait(ms: number): Promise<void> },
) {
  const deliver = createRuntimeEnvironmentDelivery(sql, key, clock);
  return async (caller: Caller, id: string) => {
    const row = (
      await sql.query<{ request_enc: Uint8Array<ArrayBuffer>; harness: Harness }>(
        `select d.request_enc,s.harness from public.docker_launch_requests d join public.sandboxes s on s.id=d.sandbox_id
       join public.members m on m.org_id=s.org_id and m.user_id=s.owner_id
       join public.mcp_actor_epochs e on e.org_id=s.org_id and e.user_id=s.owner_id and e.epoch=d.actor_epoch
       where s.id=$1 and s.provider='docker' and s.owner_id=$2 and s.org_id=any($3::uuid[])`,
        [id, caller.userId, caller.orgs.map((org) => org.orgId)],
      )
    ).rows[0];
    if (!row) return;
    const manifest = JSON.parse(await decryptSecret(row.request_enc, key));
    if (!Object.keys(manifest.variables ?? {}).length && !manifest.request.secrets?.length) return;
    await deliver({
      provider: "docker",
      ownerId: caller.userId,
      id,
      load: async (tx) => {
        const current = (
          await tx.query<{ org_id: string }>(
            `select s.org_id from public.docker_launch_requests d join public.sandboxes s on s.id=d.sandbox_id
         join public.mcp_actor_epochs e on e.org_id=s.org_id and e.user_id=s.owner_id and e.epoch=d.actor_epoch
         where s.id=$1 and s.owner_id=$2 and s.org_id=any($3::uuid[])`,
            [id, caller.userId, caller.orgs.map((org) => org.orgId)],
          )
        ).rows[0];
        if (!current) throw new VaultError("forbidden", "Runtime environment delivery denied.");
        return {
          orgId: current.org_id,
          harness: row.harness,
          variables: manifest.variables,
          bindings: manifest.request.secrets ?? [],
        };
      },
    });
  };
}
