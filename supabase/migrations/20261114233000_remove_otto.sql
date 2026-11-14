-- Owner decision #1905: remove only the November 14 feature schema.
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
commit;
