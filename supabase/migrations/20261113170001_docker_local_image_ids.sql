-- Permit full local content-addressed image IDs without weakening private host/sandbox bindings.
alter table public.sandboxes drop constraint sandboxes_docker_binding_chk,
  add constraint sandboxes_docker_binding_chk check (
    (provider <> 'docker' and docker_host_id is null and docker_installation_id is null
      and docker_generation is null and docker_image is null)
    or (provider = 'docker' and docker_host_id is not null and docker_installation_id is not null
      and docker_generation is not null and docker_image is not null
      and char_length(docker_image) <= 512
      and docker_image ~ '^(sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64})$'
      and harness in ('codex', 'claude', 'opencode') and visibility = 'private' and access_owner_id = owner_id
      and not boat_runtime and repository_dir is null and expires_at is not null)
  );
