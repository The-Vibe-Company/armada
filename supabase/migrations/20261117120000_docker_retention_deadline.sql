-- The host daemon owns the authoritative per-generation cleanup deadline. It
-- reports each retained generation's local deadline on poll; the server persists
-- it so resume admission can fence on the exact value the daemon will delete at,
-- instead of estimating from the stop ACK age. Service-role only: no JWT grant.
alter table public.sandboxes add column docker_retention_deadline timestamptz;
comment on column public.sandboxes.docker_retention_deadline is
  'Host-reported local cleanup deadline for this Docker generation; null when the host holds no obligation.';
