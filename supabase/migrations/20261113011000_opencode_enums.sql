-- ACP-backed OpenCode, enabled only on Modal. Commit enum values before using them in constraints.
alter type public.harness add value if not exists 'opencode';
alter type public.credential_kind add value if not exists 'opencode';
