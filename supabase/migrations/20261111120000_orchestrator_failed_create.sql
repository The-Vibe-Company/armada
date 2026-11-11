-- Proven pre-allocation refusal has no machine to recover.
alter table public.orchestrators drop constraint orchestrators_state_check;
alter table public.orchestrators add constraint orchestrators_state_check
  check (state in ('creating','ready','stopping','stopped','resuming','blocked','failed'));
