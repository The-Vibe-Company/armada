-- MCP actor epochs start at zero for members backfilled by mcp_bootstrap.
-- Reservations must preserve that current epoch, not invent a new authority.
-- Host job bindings already accept zero; runtime epochs are separately 1-based.
alter table public.docker_launch_requests
  drop constraint docker_launch_requests_actor_epoch_check,
  add constraint docker_launch_requests_actor_epoch_check check (actor_epoch >= 0);
