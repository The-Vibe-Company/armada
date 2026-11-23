begin;

create function public.preserve_staged_stop_output_transfer() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists (
   select 1 from public.jobs j join public.sandboxes s on s.id=j.sandbox_id
   where j.sandbox_id=old.sandbox_id and j.kind='outputs_publish' and j.state in ('queued','leased')
     and j.deadline_at>clock_timestamp() and j.outcome->'transferIds' ? old.id::text
     and s.status<>'deleted' and not s.application_secret_tainted
 ) then
   return null;
 end if;
 return old;
end;
$$;

revoke all on function public.preserve_staged_stop_output_transfer() from public, anon, authenticated;
create trigger preserve_staged_stop_output_transfer before delete on public.sandbox_output_transfers
 for each row execute function public.preserve_staged_stop_output_transfer();

commit;
