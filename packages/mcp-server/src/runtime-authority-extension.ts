export const authorityExtensionPrefix = "boat_authority_";
export const authorityExtensionRequestId = (jobId: string) => `${authorityExtensionPrefix}${jobId}`;
export function liveAuthorityExtension(sandboxId: string, epoch: string, id: string, leaseEpoch?: string) {
  return `exists (
    select 1
    from public.boat_runtime_extension_state ext
    join public.jobs j on j.id=ext.pending_job_id
    join public.sandboxes s on s.id=ext.sandbox_id
    where s.id=${sandboxId} and s.boat_runtime and s.status in ('ready','running')
      and s.stop_requested_at is null and j.sandbox_id=s.id and j.generation=s.lifecycle_generation
      and j.kind='boat_runtime_extend' and j.state='leased'
      and j.lease_until>clock_timestamp() and j.deadline_at>clock_timestamp()
      and '${authorityExtensionPrefix}' || j.id::text=${id}
      ${leaseEpoch ? `and j.lease_epoch=${leaseEpoch}` : ""}
      and not exists (select 1 from public.runtime_checkpoints c where c.sandbox_id=s.id and c.epoch=${epoch})
  )`;
}

export function dispatchableRuntimeCommand(sandboxId: string, epoch: string, id: string) {
  return `(not starts_with(${id},'${authorityExtensionPrefix}') or ${liveAuthorityExtension(sandboxId, epoch, id)})`;
}
