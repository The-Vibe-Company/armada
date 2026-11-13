-- Service-owned runtime grants retain the Docker issuer membership incarnation.
-- Reuse MCP actor tombstones: host-token membership policy is unchanged.
alter table public.runtime_enrolments add column docker_issuer_fence text;
