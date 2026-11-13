import { type Harness, validateReadableVariables } from "@armada/core";
import { decryptSecret, type Sql, VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import { createRuntimeCommands } from "./runtime-commands.ts";
import { createRuntimeEnrolments } from "./runtime-enrolment.ts";

/** Delivery of an admitted frozen readable environment through the existing runtime RPC.
 * Never re-resolve mutable variable sources on later/resumed turns.
 */
export function createDockerLaunchVariables(
  sql: Sql,
  key: string,
  clock?: { now(): number; wait(ms: number): Promise<void> },
) {
  const authority = createRuntimeEnrolments(sql, key);
  const commands = createRuntimeCommands(authority, key, clock);
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
    if (manifest.variables === undefined || !Object.keys(manifest.variables).length) return;
    const variables = validateReadableVariables(manifest.variables);
    const epoch = await authority.withOwner(id, caller.userId, async (_tx, scope) => scope.epoch);
    const requestId = `docker_variables_${id}_${epoch}`;
    const reply = await commands.call(
      caller.userId,
      { version: 1, requestId, sandboxId: id, op: "configureReadableVariables", harness: row.harness, variables },
      { expectedEpoch: epoch, timeoutMs: 60000 },
    );
    const result = reply.body.result as { acknowledged?: boolean } | undefined;
    if (reply.status !== 200 || reply.body.requestId !== requestId || result?.acknowledged !== true)
      throw new VaultError("unavailable", "Runtime variable delivery is unavailable.");
  };
}
