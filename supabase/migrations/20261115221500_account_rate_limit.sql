-- Retry evidence is metadata only, server-written and bounded by the native retry deadline.
alter table public.sandbox_turn_models add column rate_limit_retry_at timestamptz;
