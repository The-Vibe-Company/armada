import type { LaunchStage } from "@armada/core";
import type { Sql } from "@armada/core/server";

/**
 * #2560: persist one launch stage for a runtime activation (enrolment epoch), first write wins,
 * inside the caller's already-authenticated transaction, dated by the database clock.
 */
export async function recordLaunchStage(
  tx: Pick<Sql, "query">,
  scope: { sandboxId: string; epoch: string },
  stage: LaunchStage,
) {
  await tx.query(
    `insert into public.sandbox_launch_stages(sandbox_id,epoch,stage,at)
     values($1,$2::bigint,$3,clock_timestamp()) on conflict do nothing`,
    [scope.sandboxId, scope.epoch, stage],
  );
}
