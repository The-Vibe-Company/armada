-- Serialize GitHub refresh-token rotation across server replicas and retain only sealed access tokens.
-- The function is service-role only; user JWTs cannot read or invoke it.
alter table public.github_connections
  add column access_token_enc bytea,
  add column access_expires_at timestamptz;

comment on column public.github_connections.access_token_enc is 'Ciphertext. Never a raw token.';

-- The service process takes `pg_advisory_xact_lock(hashtextextended(user_id::text, 0))`
-- inside one transaction which encloses the read, GitHub request, and cache write. Do not expose
-- a helper that returns ciphertext: anon and authenticated retain no access to this table or helper.
