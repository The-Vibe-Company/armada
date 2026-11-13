-- A durable, same-epoch checkpoint intent fences new runtime work before quiescing.
-- Watermark is set only after the command result and exact encrypted journal prefix commit.
create table public.runtime_checkpoints (
 sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
 epoch bigint not null check(epoch>0),
 request_id uuid not null,
 watermark bigint check(watermark>=0 and watermark<=9007199254740991),
 created_at timestamptz not null default now(),
 completed_at timestamptz,
 primary key(sandbox_id,epoch),
 unique(sandbox_id,request_id),
 check((watermark is null)=(completed_at is null))
);
alter table public.runtime_checkpoints enable row level security;
revoke all on public.runtime_checkpoints from public,anon,authenticated;
grant all on public.runtime_checkpoints to service_role;
