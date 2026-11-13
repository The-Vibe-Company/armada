-- One explicitly dispatched resume per stopped checkpoint epoch. No plaintext prompt/config.
create table public.runtime_resumes (
 sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
 request_id uuid not null,
 source_epoch bigint not null check(source_epoch>0),
 target_epoch bigint not null check(target_epoch>source_epoch),
 watermark bigint not null check(watermark>=0 and watermark<=9007199254740991),
 request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'),
 conversation_id text not null check(length(conversation_id) between 1 and 256),
 model text not null,
 reasoning_effort text not null,
 phase text not null default 'dispatched' check(phase in ('dispatched','complete','failed')),
 verified_at timestamptz,
 receipt jsonb,
 created_at timestamptz not null default now(),
 primary key(sandbox_id,request_id),
 unique(sandbox_id,source_epoch),
 check((phase='complete')=(receipt is not null)),
 check(receipt is null or (verified_at is not null and jsonb_typeof(receipt)='object'))
);
alter table public.runtime_resumes enable row level security;
revoke all on public.runtime_resumes from public,anon,authenticated;
grant all on public.runtime_resumes to service_role;
