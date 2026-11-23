import { modalLaunchSetupKeySql } from "@armada/core/server";

export const publicSandboxStatusSql = `case
  when s.status in ('ready','running') then coalesce(
    (select case setup.state when 'queued' then 'starting' when 'leased' then 'starting' when 'failed' then 'failed' end
     from public.jobs setup where setup.idem_key=${modalLaunchSetupKeySql()}),
    (case when exists(select 1 from public.docker_launch_requests d where d.sandbox_id=s.id and d.result_enc is null) then 'starting' end),
    s.status::text)
  else s.status::text end`;
