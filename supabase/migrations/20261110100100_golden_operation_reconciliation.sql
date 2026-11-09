-- Persist the proposed canonical identity before publication, not after a transport loss.
-- Unknown physical operations with no verified identity remain operator-owned fences.
alter table public.golden_operation_fences add column receipt jsonb;
grant select(golden_id,receipt), update(receipt) on public.golden_operation_fences to authenticated;
create policy golden_fence_update on public.golden_operation_fences for update to authenticated
  using(owner_id=auth.uid()) with check(owner_id=auth.uid());
