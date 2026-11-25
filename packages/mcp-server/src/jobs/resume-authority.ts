export function resumeDispatchAuthority(job: string, sandbox: string, pendingTicket = false) {
  return `(${job}.attempts<=${job}.max_attempts and ${job}.deadline_at>clock_timestamp()
    ${pendingTicket ? `and ${job}.state in ('queued','leased')` : `and ${job}.state='leased' and ${job}.lease_until>clock_timestamp()`}
    and ${sandbox}.status in ('starting','ready') and ${sandbox}.stop_requested_at is null and ${sandbox}.deleted_at is null
    and not (${sandbox}.provider='docker' and exists(select 1 from public.jobs stop
      where stop.sandbox_id=${sandbox}.id and stop.generation=${sandbox}.lifecycle_generation
        and stop.kind='stop' and stop.state in ('queued','leased')))
    and not ${sandbox}.application_secret_tainted and ${sandbox}.expires_at>clock_timestamp()
    and date_trunc('milliseconds',${sandbox}.expires_at)=(${job}.outcome->>'expiresAt')::timestamptz
    and exists(select 1 from public.mcp_actor_epochs e join public.members m
       on m.org_id=e.org_id and m.user_id=e.user_id
       where e.org_id=${sandbox}.org_id and e.user_id=${sandbox}.owner_id
         and e.epoch::text=${job}.outcome->>'actorEpoch')
    and exists(select 1 from public.credentials c where c.id=${sandbox}.credential_id
      and c.version=${sandbox}.credential_version and c.id::text=${job}.outcome->>'accountId'
      and c.version::text=${job}.outcome->>'accountVersion' and c.status='active'
      and (c.expires_at is null or c.expires_at>clock_timestamp())
      and ((c.scope='org' and c.owner_id=${sandbox}.org_id) or (c.scope='user' and c.owner_id=${sandbox}.owner_id)))
    and ((${sandbox}.provider='docker' and ${job}.outcome->>'withoutPrompt'='true') or exists(select 1 from public.account_turn_queue q where q.sandbox_id=${sandbox}.id
      and q.request_id::text=${job}.outcome->>'requestId' and
        q.state='dispatching' and q.actor_epoch::text=${job}.outcome->>'actorEpoch')))`;
}

export function resumeDispatchBlocked(sandboxId: string, pendingTicket = false) {
  return `exists(select 1 from public.jobs j join public.sandboxes s
    on s.id=j.sandbox_id and s.lifecycle_generation=j.generation
    where s.id=${sandboxId} and j.kind='resume' and not coalesce(${resumeDispatchAuthority("j", "s", pendingTicket)},false))`;
}
