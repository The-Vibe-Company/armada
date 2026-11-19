create table public.account_spend (
  account_id uuid not null,
  period_start date not null check (extract(day from period_start) = 1),
  usd numeric not null check (usd >= 0),
  unpriced_turns integer not null check (unpriced_turns >= 0),
  primary key (account_id, period_start)
);

-- A logical turn can publish multiple model shares and can be corrected by
-- later observations. Retain its last contribution until sandbox deletion.
create table public.account_spend_turns (
  sandbox_id uuid not null references public.sandboxes(id) on delete cascade,
  prompt_id text not null,
  period_start date not null,
  account_id uuid,
  usd numeric not null,
  unpriced boolean not null,
  primary key (sandbox_id, prompt_id)
);

alter table public.account_spend enable row level security;
alter table public.account_spend_turns enable row level security;
revoke all on public.account_spend, public.account_spend_turns from public, anon, authenticated, service_role;

-- Called by the quote publisher while it holds the sandbox row lock, inside
-- the transaction that saves the quotes. Only changed prompts are supplied.
create function public.publish_account_spend(p_sandbox_id uuid, p_turns jsonb)
returns void
language sql
set search_path = ''
as $$
  with incoming as (
    select t.prompt_id,
      date_trunc('month', t.completed_at at time zone 'UTC')::date as period_start,
      t.account_id, t.usd, t.unpriced
    from jsonb_to_recordset(p_turns)
      as t(prompt_id text, completed_at timestamptz, account_id uuid, usd numeric, unpriced boolean)
  ), changes as (
    select i.prompt_id, coalesce(old.period_start, i.period_start) as period_start,
      coalesce(old.account_id, i.account_id) as account_id,
      case when i.account_id is not null and (old.account_id is null or old.account_id = i.account_id)
        then i.usd else coalesce(old.usd, 0) end as usd,
      case when i.account_id is not null and (old.account_id is null or old.account_id = i.account_id)
        then i.unpriced else coalesce(old.unpriced, false) end as unpriced,
      coalesce(old.usd, 0) as old_usd,
      coalesce(old.unpriced, false) as old_unpriced
    from incoming i left join public.account_spend_turns old
      on old.sandbox_id = p_sandbox_id and old.prompt_id = i.prompt_id
    where coalesce(old.period_start, i.period_start) is not null
  ), recorded as (
    insert into public.account_spend_turns(sandbox_id, prompt_id, period_start, account_id, usd, unpriced)
    select p_sandbox_id, prompt_id, period_start, account_id, usd, unpriced from changes
    on conflict (sandbox_id, prompt_id) do update
      set account_id = excluded.account_id, usd = excluded.usd, unpriced = excluded.unpriced
    where (account_spend_turns.account_id, account_spend_turns.usd, account_spend_turns.unpriced)
      is distinct from (excluded.account_id, excluded.usd, excluded.unpriced)
    returning prompt_id
  ), deltas as (
    select c.account_id, c.period_start, sum(c.usd - c.old_usd) as usd,
      sum(c.unpriced::int - c.old_unpriced::int)::int as unpriced_turns
    from changes c join recorded r using (prompt_id)
    where c.account_id is not null
    group by c.account_id, c.period_start
  )
  -- Delta rows can be negative after a correction, so insert zero rows first
  -- within the upsert and look up the delta for existing rows in the update.
  insert into public.account_spend(account_id, period_start, usd, unpriced_turns)
    select account_id, period_start, greatest(usd, 0), greatest(unpriced_turns, 0)
    from deltas order by account_id, period_start
  on conflict (account_id, period_start) do update set
    usd = account_spend.usd + (
      select d.usd from deltas d where d.account_id = excluded.account_id and d.period_start = excluded.period_start),
    unpriced_turns = account_spend.unpriced_turns + (
      select d.unpriced_turns from deltas d where d.account_id = excluded.account_id and d.period_start = excluded.period_start);
$$;

revoke all on function public.publish_account_spend(uuid, jsonb) from public, anon, authenticated, service_role;
