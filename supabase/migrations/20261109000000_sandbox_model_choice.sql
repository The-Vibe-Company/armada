-- The model and reasoning effort a sandbox's turns run with (#515), chosen at launch for its harness.
-- Never edit a migration that has been applied.
--
-- Existing sandboxes are deliberately not backfilled: they were launched without a model, so their
-- turns ran on the provider's own default. Null keeps that behaviour for them; every new launch records
-- both values, idle launches included, and later sends reuse them.

alter table public.sandboxes
  add column model text,
  add column reasoning_effort text;

alter table public.sandboxes
  add constraint sandboxes_model_chk
  check (
    (model is null and reasoning_effort is null)
    or (model is not null and reasoning_effort is not null
      and char_length(model) between 1 and 200 and char_length(reasoning_effort) between 1 and 40)
  );

comment on column public.sandboxes.model is
  'The model the harness runs with, as the harness names it. Null for sandboxes launched before #515.';
comment on column public.sandboxes.reasoning_effort is
  'The reasoning effort the harness runs with. Null exactly when model is null.';

-- A user JWT already inserts and selects every column of a sandbox it may see. The choice is fixed at
-- launch, so no update grant is added.
