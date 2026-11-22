import {
  type AgentDefault,
  accountModelCountsSql,
  accountWaitingCountSql,
  accountWorkingCountSql,
  type CredentialInfo,
  listCredentials,
  type OrgSummary,
  type Sql,
  type VaultStore,
} from "@armada/core/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type MonthlySpend = { periodStart: string; usd: string; unpricedTurns: number };
type Row = {
  exhausted_until: string | null;
  monthly_spend: MonthlySpend | null;
  result_scope: "user" | "org";
  org_id: string | null;
  org_name: string | null;
  org_role: OrgSummary["role"] | null;
  boat_present: boolean | null;
  id: string | null;
  name: string;
  max_agents: number | null;
  model_limits: Record<string, number>;
  model_counts: Record<string, { runningAgents: number; waitingAgents: number }>;
  running_agents: string;
  rate_limited: boolean;
  waiting_agents: string;
  is_default: boolean;
  status: string;
  expires_at: string | Date | null;
  updated_at: string | Date;
  version: number;
  kind: CredentialInfo["kind"];
  created_at: string | Date;
};
const instant = (value: string | Date) => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

/** Metadata only; caller identity and service-token org binding are supplied by the authenticated control route. */
export function createSqlCredentialList(sql: Sql, store: VaultStore) {
  return async (userId: string, ref: string | undefined) => {
    const wanted = ref?.trim().toLowerCase();
    const result = await sql.query<{ entries: Row[]; defaults: AgentDefault[] }>(
      `with memberships as materialized (
         select o.id as org_id, o.name as org_name, m.role::text as org_role,
           o.boat_api_key_enc is not null as boat_present
         from public.members m join public.orgs o on o.id=m.org_id
         where m.user_id=$1::uuid and ($2::uuid is null or m.org_id=$2::uuid)
       ), entries as (
         select 'user'::text as result_scope, null::uuid as org_id, null::text as org_name,
           null::text as org_role, null::boolean as boat_present,
           c.id,c.name,c.max_agents,c.model_limits,${accountModelCountsSql("c.id", "c.model_limits")} as model_counts,${accountWorkingCountSql("c.id")} as running_agents,${accountWaitingCountSql("c.id", "c.max_agents")} as waiting_agents,exists(select 1 from public.sandboxes s join public.sandbox_turn_models t on t.sandbox_id=s.id where s.credential_id=c.id and s.deleted_at is null and s.stopped_at is null and s.status='running' and t.rate_limit_retry_at > now() and t.evidence->'terminalOutcome' is null) as rate_limited,c.is_default,c.status,c.expires_at,c.updated_at,c.version,c.kind::text as kind,c.created_at
         from public.credentials c where c.scope='user' and c.owner_id=$1::uuid and c.status is distinct from 'deleted'
         union all
         select 'org'::text, m.org_id,m.org_name,m.org_role,m.boat_present,
           c.id,c.name,c.max_agents,c.model_limits,${accountModelCountsSql("c.id", "c.model_limits")} as model_counts,${accountWorkingCountSql("c.id")} as running_agents,${accountWaitingCountSql("c.id", "c.max_agents")} as waiting_agents,exists(select 1 from public.sandboxes s join public.sandbox_turn_models t on t.sandbox_id=s.id where s.credential_id=c.id and s.deleted_at is null and s.stopped_at is null and s.status='running' and t.rate_limit_retry_at > now() and t.evidence->'terminalOutcome' is null) as rate_limited,c.is_default,c.status,c.expires_at,c.updated_at,c.version,c.kind::text,c.created_at
         from memberships m left join public.credentials c
           on c.scope='org' and c.owner_id=m.org_id and c.status is distinct from 'deleted'
       ), with_account_status as (
         select e.*, x.resets_at as exhausted_until, case when s.account_id is not null then jsonb_build_object(
           'periodStart', to_char(s.period_start, 'YYYY-MM-DD'),
           'usd', trim_scale(s.usd)::text,
           'unpricedTurns', s.unpriced_turns
         ) end as monthly_spend
         from entries e left join public.account_spend s on s.account_id=e.id
           and s.period_start=date_trunc('month', statement_timestamp() at time zone 'UTC')::date
         left join public.account_exhaustion x on x.account_id=e.id and x.account_version=e.version
           and x.resets_at>statement_timestamp()
       ) select coalesce((select jsonb_agg(e order by lower(e.org_name), e.org_id, e.kind) from with_account_status e),'[]'::jsonb) as entries,
         coalesce((select jsonb_agg(jsonb_build_object('harness',d.harness,'credentialId',d.credential_id,'model',d.model) order by d.harness) from public.agent_defaults d where d.user_id=$1::uuid),'[]'::jsonb) as defaults`,
      [userId, wanted && UUID.test(wanted) ? wanted : null],
    );
    const orgs = new Map<string, OrgSummary>();
    const keys = new Map<string, boolean>();
    const credentials = new Map<string, Row[]>();
    const user: Row[] = [];
    for (const row of result.rows[0]?.entries ?? []) {
      if (row.result_scope === "org" && row.org_id !== null) {
        orgs.set(row.org_id, { id: row.org_id, name: row.org_name!, role: row.org_role! });
        keys.set(row.org_id, row.boat_present === true);
        if (!credentials.has(row.org_id)) credentials.set(row.org_id, []);
      }
      if (row.id === null) continue;
      if (row.result_scope === "user") user.push(row);
      else credentials.get(row.org_id!)!.push(row);
    }
    // Keep core's exact name/UUID/empty-ref resolution, ordering, synthetic Boat entry and payload policy.
    return listCredentials(
      {
        ...store,
        agentDefaults: async () => result.rows[0]?.defaults ?? [],
        memberships: async () => [...orgs.values()],
        listCredentials: async (scope, ownerId) => {
          const rows = scope === "user" ? (ownerId === userId ? user : []) : (credentials.get(ownerId) ?? []);
          // Core resolves authority first; format only the metadata it actually requests.
          return rows.map((row): CredentialInfo & { monthlySpend?: MonthlySpend; exhaustedUntil?: string } => ({
            id: row.id!,
            ...(row.monthly_spend ? { monthlySpend: row.monthly_spend } : {}),
            ...(row.exhausted_until ? { exhaustedUntil: instant(row.exhausted_until) } : {}),
            name: row.name,
            maxAgents: row.max_agents,
            modelLimits: row.model_limits ?? {},
            modelCounts: row.model_counts ?? {},
            runningAgents: Number(row.running_agents ?? 0),
            ...(row.rate_limited ? { rateLimited: true } : {}),
            waitingAgents: Number(row.waiting_agents ?? 0),
            isDefault: row.is_default,
            status: row.status,
            expiresAt: row.expires_at ? instant(row.expires_at) : null,
            updatedAt: instant(row.updated_at),
            version: row.version,
            kind: row.kind,
            createdAt: instant(row.created_at),
          }));
        },
        hasOrgBoatKey: async (id) => keys.get(id) ?? false,
      },
      userId,
      ref,
    );
  };
}
