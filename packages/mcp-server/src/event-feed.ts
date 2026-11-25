import type { AgentEvent, SandboxStatus } from "@armada/core";
import type { streamSandboxEvents } from "@armada/core/contract";
import { type DelegatedAuthority, DelegatedAuthorityDenied, decryptSecret, type Sql } from "@armada/core/server";
import type { z } from "zod";
import type { Caller } from "./caller.ts";
import { isPrivateModelEvent } from "./model-usage.ts";
import { SANDBOX_VISIBLE } from "./sandbox-visibility.ts";

type EventReference = z.infer<typeof streamSandboxEvents.output>;
type EventReader = (cursor: string) => Promise<EventReference[] | null>;
export const EVENT_PAGE_SIZE = 100;

export interface EventFeed {
  owner(caller: Caller, sandboxId: string): EventReader;
  child(token: string, sandboxId: string): EventReader;
  ownerTail?(caller: Caller, sandboxId: string): Promise<string | null>;
  childTail?(token: string, sandboxId: string): Promise<string | null>;
}

type RawEventRow = EventReference & {
  id: string | null;
  event_enc: Uint8Array<ArrayBuffer> | null;
  status: SandboxStatus | null;
  statusReason: string | null;
};

const columns = `e.id::text, e.sandbox_id as "sandboxId", e.sequence::text, e.kind, e.ref::text,
  to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
  re.event_enc, t.to_status::text as status,
  case when e.kind <> 'transition' or t.to_status is null then null
    when s.status = t.to_status
      and not exists(select 1 from public.sandbox_transitions t2 where t2.sandbox_id=s.id and t2.id>t.id)
      then s.status_reason
    when t.to_status in ('stopped', 'failed', 'stopping', 'deleted') then t.code else null end as "statusReason"`;
const joins = `left join public.runtime_events re
    on e.kind='runtime_event' and re.sandbox_id=e.sandbox_id and re.sequence=e.sequence
  left join public.sandbox_transitions t
    on e.kind='transition' and t.sandbox_id=e.sandbox_id and t.id=e.ref`;

async function hydrate(rows: readonly RawEventRow[], encryptionKey?: string) {
  const events: EventReference[] = [];
  for (const { event_enc, status, statusReason, ...row } of rows) {
    if (row.id === null) continue;
    const item: EventReference = { ...row, id: row.id };
    if (row.kind === "runtime_event" && event_enc && encryptionKey) {
      const parsed = JSON.parse(await decryptSecret(event_enc, encryptionKey)) as AgentEvent;
      if (!isPrivateModelEvent(parsed)) item.event = parsed as unknown as EventReference["event"];
    } else if (row.kind === "transition" && status !== null) {
      item.status = status;
      item.statusReason = statusReason;
    }
    events.push(item);
  }
  return events;
}

export function createEventFeed(sql: Sql, authority: Pick<DelegatedAuthority, "admit">, encryptionKey?: string) {
  const feed: EventFeed = {
    owner: (caller, sandboxId) => async (cursor) => {
      const { rows } = await sql.query<RawEventRow>(
        `select ${columns} from public.sandboxes s
         left join lateral (
           select * from public.event_log where sandbox_id=s.id and org_id=s.org_id and id>$4::bigint
           order by id limit ${EVENT_PAGE_SIZE}
         ) e on true ${joins}
         where s.id=$3 and ${SANDBOX_VISIBLE} order by e.id::bigint`,
        [caller.orgs.map(({ orgId }) => orgId), caller.userId, sandboxId, cursor],
      );
      return rows.length ? hydrate(rows, encryptionKey) : null;
    },
    child: (token, sandboxId) => async (cursor) => {
      try {
        const rows = await authority.admit(
          token,
          { method: "read", childId: sandboxId },
          async (tx, principal) =>
            (
              await tx.query<RawEventRow>(
                `select ${columns} from public.event_log e join public.sandboxes s on s.id=e.sandbox_id ${joins}
               where e.sandbox_id=$1 and e.org_id=$2 and e.id>$3::bigint order by e.id limit ${EVENT_PAGE_SIZE}`,
                [sandboxId, principal.orgId, cursor],
              )
            ).rows,
        );
        return hydrate(rows, encryptionKey);
      } catch (error) {
        if (error instanceof DelegatedAuthorityDenied) return null;
        throw error;
      }
    },
    ownerTail: async (caller, sandboxId) =>
      (
        await sql.query<{ cursor: string }>(
          `select coalesce(max(e.id), 0)::text as cursor from public.sandboxes s
           left join public.event_log e on e.sandbox_id=s.id and e.org_id=s.org_id
           where s.id=$3 and ${SANDBOX_VISIBLE} group by s.id`,
          [caller.orgs.map(({ orgId }) => orgId), caller.userId, sandboxId],
        )
      ).rows[0]?.cursor ?? null,
    childTail: async (token, sandboxId) => {
      try {
        return await authority.admit(
          token,
          { method: "read", childId: sandboxId },
          async (tx, principal) =>
            (
              await tx.query<{ cursor: string }>(
                `select coalesce(max(id), 0)::text as cursor from public.event_log where sandbox_id=$1 and org_id=$2`,
                [sandboxId, principal.orgId],
              )
            ).rows[0]?.cursor ?? "0",
        );
      } catch (error) {
        if (error instanceof DelegatedAuthorityDenied) return null;
        throw error;
      }
    },
  };
  return feed;
}
