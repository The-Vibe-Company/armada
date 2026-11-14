-- Owner decision #1905: remove the entire feature, including the earlier observation schema.
begin;
drop table public.otto_intentions;
drop table public.otto_interview_revisions;
drop table public.otto_interviews;
drop table public.otto_ticket_publications;
drop table public.otto_waits;
drop table public.otto_ticket_graphs;
drop table public.otto_engine_preferences;
drop table public.otto_objective_messages;
drop table public.otto_objectives;
drop function public.otto_wait_question_cap();
-- Earlier production observation schema. Drop dependents before the facts journal.
drop table public.otto_tasks;
drop table public.otto_resources;
drop table public.otto_orphan_days;
drop table public.otto_github_pages;
drop table public.otto_facts;
drop function public.otto_facts_immutable();
-- Feature-specific indexes on otherwise retained shared tables.
drop index public.sandboxes_otto_live;
drop index public.modal_events_otto_agent;
commit;
