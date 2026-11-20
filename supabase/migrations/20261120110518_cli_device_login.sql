begin;

create schema armada_auth;
revoke all on schema armada_auth from public, anon, authenticated;

create table armada_auth.oauth_device_requests (
  id uuid primary key,
  device_hash text unique not null check (device_hash ~ '^[0-9a-f]{64}$'),
  user_code text not null,
  hostname text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  next_poll_at timestamptz not null,
  poll_interval integer not null default 5,
  state text not null default 'pending' check (state in ('pending', 'approved', 'denied', 'consumed')),
  user_id uuid references auth.users(id) on delete cascade,
  check ((state = 'pending') = (user_id is null))
);

alter table armada_auth.oauth_device_requests enable row level security;
revoke all on armada_auth.oauth_device_requests from public, anon, authenticated;

commit;
