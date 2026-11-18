/** A failed refresh clears proof. Generation, task and authority fences reject
 * observations from before a new turn, ownership change or GitHub revocation. */
export function mergedWorkProof(alias: "s" | "sandboxes"): string {
  return `(${alias}.stop_when_work_merged
    and ${alias}.pull_request_merge_proof is not null
    and (${alias}.pull_request_merge_proof->>'checkedAt')::timestamptz > now()-interval '5 minutes'
    and ${alias}.pull_request_merge_proof->>'generation'=${alias}.lifecycle_generation::text
    and (${alias}.pull_request_merge_proof->>'promptId') is not distinct from ${alias}.task_prompt_id
    and not exists(select 1 from public.account_turn_queue q where q.sandbox_id=${alias}.id
      and q.state in ('queued','dispatching'))
    and exists(select 1 from public.github_connections c where c.user_id=${alias}.owner_id
      and c.revoked_at is null and c.connection_epoch::text=${alias}.pull_request_merge_proof->>'connectionEpoch')
    and exists(select 1 from public.mcp_actor_epochs e join public.members m
      on m.org_id=e.org_id and m.user_id=e.user_id
      where e.org_id=${alias}.org_id and e.user_id=${alias}.owner_id
        and e.epoch::text=${alias}.pull_request_merge_proof->>'membershipEpoch'))`;
}
