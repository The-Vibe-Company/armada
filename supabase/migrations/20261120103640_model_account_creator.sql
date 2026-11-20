begin;

alter table public.credentials
  add column created_by uuid references auth.users(id) on delete set null;

comment on column public.credentials.created_by is
  'Authenticated creator of a model account. Null when the creator is unknown or was deleted.';

commit;
