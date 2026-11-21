begin;

create table public.native_drain_stop_requests (
  sandbox_id uuid primary key references public.sandboxes(id) on delete cascade,
  stop_generation bigint not null
);
alter table public.native_drain_stop_requests enable row level security;
revoke all on public.native_drain_stop_requests from public, anon, authenticated, service_role;
grant select, insert, update on public.native_drain_stop_requests to service_role;
create policy "Service owns native drain stop requests" on public.native_drain_stop_requests
  for all to service_role using (true) with check (true);

-- Both callers check lifecycle ownership before using the same preservation proof.
create function public.native_drain_work_proof(p_sandbox_id uuid, p_generation bigint)
returns table(outcome text, archive_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_sandbox public.sandboxes%rowtype;
  v_archive_id uuid;
begin
  select * into v_sandbox from public.sandboxes where id = p_sandbox_id;
  if not found or v_sandbox.lifecycle_generation is distinct from p_generation then
    return query select 'ineligible'::text, null::uuid;
    return;
  end if;

  -- Keep these reads in the caller's statement snapshot. Steer reconciliation
  -- can turn a pending cursor into a prompt receipt in a single transaction.
  if exists (
    select 1 from public.sandbox_native_exec_attempts e where e.sandbox_id = p_sandbox_id
  ) or exists (
    select 1 from public.sandbox_native_send_attempts a where a.sandbox_id = p_sandbox_id
  ) or exists (
    select 1 from public.native_webhook_prompts p
    where p.sandbox_id = p_sandbox_id
      and p.provider = v_sandbox.provider and p.provider_sandbox_id = v_sandbox.provider_sandbox_id
      and p.owner_id = v_sandbox.owner_id and p.org_id = v_sandbox.org_id
      -- The exact terminal observation must predate the capture.
      and (p.completed_at is null or not exists (
        select 1 from public.sandbox_native_preservation_receipts r
        where r.sandbox_id = p.sandbox_id
          and r.generation = p_generation and r.capture_generation = r.generation
          and r.stop_generation = v_sandbox.stop_generation
          and r.stop_generation = v_sandbox.preservation_stop_generation
          and r.capture_stop_generation = r.stop_generation
          and (r.capture_acknowledgements->'completedPrompts') ? p.prompt_id
      ))
  ) or exists (
    select 1 from public.native_steer_cursors c
    where c.sandbox_id = p_sandbox_id and c.pending_since is not null
  ) or exists (
    select 1 from public.account_turn_queue q
    where q.sandbox_id = p_sandbox_id and (
      q.state in ('queued', 'dispatching')
      or (
        q.state = 'failed'
        -- A confirmed stop clears the capacity generation. The retained
        -- deadline still distinguishes a claimed receipt from a queued refusal.
        -- A sandbox-level prompt alias is evidence of activity, but the
        -- publication trigger does not bind it to the exact queue request.
        and (q.dispatch_generation is not null or q.dispatch_until is not null
          or q.native_prompt_id is not null
          or v_sandbox.task_prompt_id = q.request_id::text
          or q.failure_reason in (
            'Dispatch outcome uncertain; inspect sandbox history before resending.',
            'Queued receipt already has dispatch evidence; inspect sandbox history before resending.',
            'Dispatch cancelled by confirmed stop.'
          ))
        and not exists (
          select 1 from public.native_webhook_prompts p
          join public.sandbox_native_preservation_receipts r on r.sandbox_id = p.sandbox_id
          where p.sandbox_id = q.sandbox_id and p.acknowledged_request_id = q.request_id
            and p.completed_at is not null
            and p.provider = v_sandbox.provider and p.provider_sandbox_id = v_sandbox.provider_sandbox_id
            and p.owner_id = v_sandbox.owner_id and p.org_id = v_sandbox.org_id
            and q.owner_id = p.owner_id and q.org_id = p.org_id
            and r.generation = p_generation and r.capture_generation = r.generation
            and r.stop_generation = v_sandbox.stop_generation
            and r.stop_generation = v_sandbox.preservation_stop_generation
            and r.capture_stop_generation = r.stop_generation
            and r.capture_acknowledgements->'prompts'->>q.request_id::text = p.prompt_id
        )
      )
    )
  ) then
    return query select 'ineligible'::text, null::uuid; return;
  end if;

  -- Never substitute an older archive.
  select r.archive_id into v_archive_id
  from public.sandbox_native_preservation_receipts r
  where r.sandbox_id = p_sandbox_id
    and r.generation = p_generation
    and r.stop_generation = v_sandbox.stop_generation
    and r.stop_generation = v_sandbox.preservation_stop_generation
    and r.capture_generation = r.generation
    and r.capture_stop_generation = r.stop_generation;

  if not found then return query select 'unverified'::text, null::uuid; return; end if;
  if v_archive_id is null then return query select 'clean'::text, null::uuid; return; end if;

  -- Check the live source on every call, including a replay of a successful copy.
  perform 1 from public.sandbox_work_recovery a
  where a.id = v_archive_id and a.sandbox_id = p_sandbox_id;
  if not found then return query select 'unverified'::text, null::uuid; return; end if;

  return query select 'archived'::text, v_archive_id;
end;
$$;
revoke all on function public.native_drain_work_proof(uuid, bigint) from public, anon, authenticated;
grant execute on function public.native_drain_work_proof(uuid, bigint) to service_role;

create or replace function public.copy_native_drain_recovery(p_sandbox_id uuid, p_generation bigint)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_sandbox public.sandboxes%rowtype;
  v_archive_id uuid;
  v_outcome text;
begin
  -- Serialize with preservation publication, taint and lifecycle admission.
  select * into v_sandbox from public.sandboxes s where s.id = p_sandbox_id for update;
  if not found
    or v_sandbox.lifecycle_generation is distinct from p_generation
    or v_sandbox.provider not in ('boat', 'modal')
    or v_sandbox.provider_sandbox_id is null
    or v_sandbox.boat_runtime
    or v_sandbox.runtime_transport is not distinct from 'dialout'
    or v_sandbox.application_secret_tainted
    or v_sandbox.deleted_at is not null
    or v_sandbox.status not in ('stopped', 'failed')
    or v_sandbox.stopped_at is null
    or v_sandbox.stop_requested_at is not null
    or v_sandbox.activity_until > clock_timestamp()
    or v_sandbox.reconcile_lease_until > clock_timestamp()
  then
    return 'ineligible';
  end if;

  select proof.outcome, proof.archive_id into v_outcome, v_archive_id
  from public.native_drain_work_proof(p_sandbox_id, p_generation) proof;
  if v_outcome <> 'archived' then return v_outcome; end if;

  -- Lock and recheck the archive before copying it.
  perform 1 from public.sandbox_work_recovery a
  where a.id = v_archive_id and a.sandbox_id = p_sandbox_id for share;
  if not found then return 'unverified'; end if;

  insert into public.native_drain_recovery (archive_id, sandbox_id, org_id, owner_id, archive_enc)
  select a.id, a.sandbox_id, v_sandbox.org_id, v_sandbox.owner_id, a.archive_enc
  from public.sandbox_work_recovery a where a.id = v_archive_id
  on conflict (archive_id) do nothing;
  return 'archived';
end;
$$;

commit;
