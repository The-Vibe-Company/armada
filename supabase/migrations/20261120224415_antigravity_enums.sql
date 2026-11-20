-- Commit the enum labels before part 2 of #3704 uses them in constraints and indexes.
begin;
alter type public.harness add value if not exists 'antigravity';
alter type public.credential_kind add value if not exists 'antigravity';
commit;
