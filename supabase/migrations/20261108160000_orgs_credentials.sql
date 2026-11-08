-- Orgs, members and credentials (#461).
-- Never edit a migration that has been applied.

-- A Codex login file (~/.codex/auth.json), stored as ciphertext like every
-- other credential. OpenCode is deferred, so it has no kind yet.
alter type public.credential_kind add value if not exists 'codex_auth';

-- Org names address an org in the CLI (--org <name>), so they are unique,
-- ignoring case and surrounding spaces.
create unique index orgs_name_key on public.orgs (lower(btrim(name)));
