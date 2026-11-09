-- Correct the documentation of the existing immutable field without editing its applied migration.
comment on column public.sandboxes.repository_dir is
  'Immutable configured repository directory selected at launch. Used for native harness cwd preparation, including idle launches; not directory confinement. Null preserves legacy behavior.';
