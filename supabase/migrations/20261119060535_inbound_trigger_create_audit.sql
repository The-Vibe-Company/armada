alter table public.trigger_admin_audit
  drop constraint trigger_admin_audit_action_check,
  add constraint trigger_admin_audit_action_check check (action in ('create', 'rotate', 'disable'));
