import { type Harness, validateReadableVariables } from "@armada/core";
import { decryptSecret, resolveLaunchSecrets, type Sql, VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";

/** Delivery of frozen readable values and current version-pinned secrets through the existing runtime RPC.
 * Never re-resolve readable sources; secret references revalidate on each new turn.
 */
export function createDockerLaunchEnvironment(
  sql: Sql,
  key: string,
  clock?: { now(): number; wait(ms: number): Promise<void> },
) {
  const commands = createRuntimeCommands(createRuntimeEnrolments(sql, key), key, clock);
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
    if (!sql.transaction) throw new VaultError("unavailable", "Runtime environment delivery is unavailable.");
    const prepared = await sql.transaction(async (tx) => {
      const local: Sql = { query: tx.query.bind(tx), transaction: (work) => work(tx) };
      const locked = createRuntimeEnrolments(local, key);
      // Source members -> secret references -> host/sandbox/runtime. No runtime I/O under these locks.
      await locked.lockSourceMembers(tx, id, caller.userId);
      const current = (
        await tx.query<{ org_id: string }>(
          `select s.org_id from public.docker_launch_requests d join public.sandboxes s on s.id=d.sandbox_id
         join public.mcp_actor_epochs e on e.org_id=s.org_id and e.user_id=s.owner_id and e.epoch=d.actor_epoch
         where s.id=$1 and s.owner_id=$2 and s.org_id=any($3::uuid[])`,
          [id, caller.userId, caller.orgs.map((org) => org.orgId)],
        )
      ).rows[0];
      if (!current) throw new VaultError("forbidden", "Runtime environment delivery denied.");
      const secrets = await resolveLaunchSecrets(
        local,
        { userId: caller.userId, orgId: current.org_id },
        manifest.request.secrets ?? [],
        key,
      );
      const variables = validateReadableVariables({ ...manifest.variables, ...secrets });
      return locked.withOwner(id, caller.userId, async (_tx, scope) => {
        const requestId = `docker_variables_${id}_${scope.epoch}`;
        const request = {
          version: 1 as const,
          requestId,
          sandboxId: id,
          op: "configureReadableVariables" as const,
          harness: row.harness,
          variables,
        };
        await createRuntimeCommands(locked, key, clock).enqueue(caller.userId, request, scope.epoch);
        return { request, epoch: scope.epoch };
      });
    });
    const {
      request: { requestId },
      epoch,
    } = prepared;
    const reply = await commands.call(caller.userId, prepared.request, { expectedEpoch: epoch, timeoutMs: 60000 });
    const result = reply.body.result as { acknowledged?: boolean } | undefined;
    if (reply.status !== 200 || reply.body.requestId !== requestId || result?.acknowledged !== true)
      throw new VaultError("unavailable", "Runtime variable delivery is unavailable.");
  };
}
