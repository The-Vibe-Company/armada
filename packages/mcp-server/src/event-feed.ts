import type { streamSandboxEvents } from "@armada/core/contract";
import { type DelegatedAuthority, DelegatedAuthorityDenied, type Sql } from "@armada/core/server";
import type { z } from "zod";
import type { Caller } from "./caller.ts";
import { SANDBOX_VISIBLE } from "./sandbox-visibility.ts";

type EventReference = z.infer<typeof streamSandboxEvents.output>;
type EventReader = (cursor: string) => Promise<EventReference[] | null>;
export const EVENT_PAGE_SIZE = 100;

export interface EventFeed {
  owner(caller: Caller, sandboxId: string): EventReader;
  child(token: string, sandboxId: string): EventReader;
}

const columns = `e.id::text, e.sandbox_id as "sandboxId", e.sequence::text, e.kind, e.ref::text,
  to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"`;

export function createEventFeed(sql: Sql, authority: Pick<DelegatedAuthority, "admit">) {
  const feed: EventFeed = {
    owner: (caller, sandboxId) => async (cursor) => {
      const { rows } = await sql.query<EventReference>(
        `select ${columns} from public.sandboxes s
         left join lateral (
           select * from public.event_log where sandbox_id=s.id and org_id=s.org_id and id>$4::bigint
           order by id limit ${EVENT_PAGE_SIZE}
         ) e on true
         where s.id=$3 and ${SANDBOX_VISIBLE} order by e.id::bigint`,
        [caller.orgs.map(({ orgId }) => orgId), caller.userId, sandboxId, cursor],
      );
      return rows.length ? rows.filter((row) => row.id !== null) : null;
    },
    child: (token, sandboxId) => async (cursor) => {
      try {
        return await authority.admit(token, { method: "read", childId: sandboxId }, async (tx, principal) => {
          const { rows } = await tx.query<EventReference>(
            `select ${columns} from public.event_log e where e.sandbox_id=$1 and e.org_id=$2
             and e.id>$3::bigint order by e.id limit ${EVENT_PAGE_SIZE}`,
            [sandboxId, principal.orgId, cursor],
          );
          return rows;
        });
      } catch (error) {
        if (error instanceof DelegatedAuthorityDenied) return null;
        throw error;
      }
    },
  };
  return feed;
}
