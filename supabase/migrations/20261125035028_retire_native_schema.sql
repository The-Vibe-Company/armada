begin;

-- Dispatch recovery and webhook alias resolution still consume the queue
-- receipt when a sandbox publishes a task prompt.
create function public.record_account_turn_prompt() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.task_prompt_id is not null
    and (tg_op = 'INSERT' or new.task_prompt_id is distinct from old.task_prompt_id) then
    update public.account_turn_queue q set native_prompt_id = new.task_prompt_id
    where q.sandbox_id = new.id and q.owner_id = new.owner_id and q.org_id = new.org_id
      and q.state = 'dispatching' and q.native_prompt_id is null;
  end if;
  return new;
end;
$$;
revoke all on function public.record_account_turn_prompt() from public, anon, authenticated;

drop trigger sandbox_native_webhook_prompt on public.sandboxes;
drop function public.track_native_webhook_prompt();
create trigger sandbox_account_turn_prompt after insert or update of task_prompt_id on public.sandboxes
  for each row execute function public.record_account_turn_prompt();

drop policy sandboxes_native_drain_update on public.sandboxes;
-- contract: last-used-in v12.0.0
alter table public.sandboxes drop column native_drain_pending;

drop function public.settle_unleased_native_launch(uuid, bigint, public.sandbox_status, text, text, text[]);
drop table armada_logs.native_log_pages;
drop schema armada_logs;

commit;
