-- The launch model is not authoritative for a historical per-turn override.
-- Null is unknown until the server decrypts durable input before serving.
-- Keep capacity conservative during the upgrade, including uncertain reservations.
update public.account_turn_queue set model=null;
update public.account_agent_reservations set model=null;
