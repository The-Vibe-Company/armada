begin;

create or replace function public.discard_stopped_output_transfers() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  delete from public.sandbox_output_transfers t
  where t.sandbox_id=new.id
    and not exists(select 1 from public.sandbox_outputs o where o.sandbox_id=t.sandbox_id and o.transfer_id=t.id)
    and not exists(
      select 1 from public.jobs j
      where j.sandbox_id=new.id and j.kind='stop'
        and (new.status='stopped' or (new.provider='boat' and new.status in ('stopping','failed')
          and new.stopped_at is not null and j.generation=new.lifecycle_generation))
        and j.outcome #> '{output,files}' @> jsonb_build_array(jsonb_build_object('transfer_id',t.id))
    );
  update public.runtime_commands set result_enc=null
  where sandbox_id=new.id and starts_with(request_id,'outputs_') and result_enc is not null;
  return new;
end;
$$;

commit;
