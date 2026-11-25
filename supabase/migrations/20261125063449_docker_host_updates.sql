alter table public.docker_hosts
  add column update_policy text not null default 'automatic',
  add column pinned_version text,
  add column update_requested boolean not null default false,
  add column last_update_result jsonb,
  add constraint docker_hosts_update_policy_check check (
    (update_policy in ('automatic', 'manual') and pinned_version is null)
    or (update_policy = 'pinned' and pinned_version is not null
      and pinned_version ~ '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$')
  );
