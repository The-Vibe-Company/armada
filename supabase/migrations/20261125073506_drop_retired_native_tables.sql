begin;

-- v14.1.0 shipped the caller removal and the queue-only prompt trigger.
drop trigger guard_authenticated_native_drain_stop on public.sandboxes;
drop function public.guard_authenticated_native_drain_stop();
drop function public.copy_native_drain_recovery(uuid, bigint);
drop function public.native_drain_work_proof(uuid, bigint);

drop table public.native_drain_delete_operations;
drop table public.native_drain_stop_requests;
drop table public.native_drain_unclaimed_dispatches;
drop table public.native_steer_cursors;
drop table public.native_webhook_prompts;
drop table public.sandbox_native_exec_attempts;
-- Dropping this table also removes its capture acknowledgement trigger.
drop table public.sandbox_native_preservation_receipts;
drop function public.clear_replaced_native_capture_acknowledgements();
drop table public.sandbox_native_send_attempts;

commit;
