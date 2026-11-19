-- Transfer receipts transactionally. The producer remains enqueue_webhook_turn,
-- including for the old server revision during deployment overlap.
lock table public.langfuse_turn_exports in share row exclusive mode;

create function public.queue_langfuse_export() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.completed_at is null then
    insert into public.jobs(kind, sandbox_id, org_id, idem_key, run_after, attempts, max_attempts, outcome)
    select 'langfuse_export', new.sandbox_id, new.org_id,
      jsonb_build_array('internal', new.org_id, 'langfuse_export', new.sandbox_id, null, new.prompt_id)::text,
      greatest(new.observed_at, new.lease_until),
      -- An in-flight legacy claim cannot record its outcome after transfer.
      -- Use one statement cutoff so a lease cannot expire midway through the bulk transfer.
      greatest(0, new.attempts - coalesce((new.lease_id is not null and new.lease_until > statement_timestamp())::int, 0)),
      35, jsonb_build_object('promptId', new.prompt_id)
    on conflict (idem_key) do nothing;

    -- Keep the receipt as the producer's deduplication record. Retire its
    -- legacy claim so the overlapping revision cannot send or settle it again.
    update public.langfuse_turn_exports set lease_id = null, lease_until = 'infinity'
      where sandbox_id = new.sandbox_id and prompt_id = new.prompt_id;
  end if;
  return null;
end;
$$;
revoke all on function public.queue_langfuse_export() from public, anon, authenticated;

-- Fire the same transfer for pending receipts. The update trigger is temporary
-- within this transaction. Its inner update does not touch observed_at.
create trigger transfer_langfuse_exports after update of observed_at on public.langfuse_turn_exports
  for each row execute function public.queue_langfuse_export();
update public.langfuse_turn_exports set observed_at = observed_at where completed_at is null;
drop trigger transfer_langfuse_exports on public.langfuse_turn_exports;

create trigger queue_langfuse_export after insert on public.langfuse_turn_exports
  for each row execute function public.queue_langfuse_export();
