-- A user JWT cannot attest provider outcomes. Only trusted server/provider paths
-- may create operation ownership, author receipts, or resolve it. Existing
-- user-owned fences are retained, but cannot be forged/cleared by their old JWT.
revoke all on public.golden_operation_fences from authenticated;
drop policy golden_fence_read on public.golden_operation_fences;
drop policy golden_fence_delete on public.golden_operation_fences;
drop policy golden_fence_insert on public.golden_operation_fences;
drop policy golden_fence_update on public.golden_operation_fences;
