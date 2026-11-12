-- Private durable command/result mailboxes; payloads can contain credentials.
create table public.runtime_commands (
 sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
 request_id text not null check(request_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
 sequence bigint generated always as identity,
 epoch bigint not null check(epoch > 0),
 request_enc bytea not null,
 result_enc bytea,
 primary key(sandbox_id,request_id)
);
create index runtime_commands_pending on public.runtime_commands(sandbox_id,epoch,sequence) where result_enc is null;
alter table public.runtime_commands enable row level security;
revoke all on public.runtime_commands from public,anon,authenticated;
revoke all on sequence public.runtime_commands_sequence_seq from public,anon,authenticated;
grant all on public.runtime_commands to service_role;
grant usage,select on sequence public.runtime_commands_sequence_seq to service_role;
