import { createHash } from "node:crypto";
import {
  decryptSecret,
  type EventPage,
  encryptSecret,
  eventPageOptions,
  type Provider,
  type Sql,
  VaultError,
} from "@armada/core/server";
import { NativeOutputPending, pausedNativePages } from "./event-pagination.ts";
import { SANDBOX_VISIBLE } from "./sandbox-visibility.ts";

const authorizedSandbox = `
  ${SANDBOX_VISIBLE} and s.id=$3::uuid and s.provider_sandbox_id=$4
  and s.provider='boat' and not s.boat_runtime and s.runtime_transport is null
  and s.deleted_at is null and s.status<>'deleted'
  and (coalesce(s.visibility,(select g.visibility from public.goldens g where g.id=s.golden_id))='org'
       or s.owner_id=$2::uuid)
`;

const pendingCommand = `
  s.activity_lease_id is not null and s.activity_until>now()
  and exists(select 1 from public.model_auth_state a
    where a.account_id=s.credential_id and a.account_version=s.credential_version)
`;

type StoredPage = EventPage & { budget?: { anchor: string; limit: number; maxBytes: number } };

function hashRequest(parts: readonly unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function withNativeLogJournal(
  sql: Sql,
  key: string,
  provider: Provider,
  scope: { id: string; orgId: string; userId: string },
  logError: (message: string) => void = console.error,
) {
  const journalProvider: Provider = {
    ...provider,
    async events(request) {
      const params = [[scope.orgId], scope.userId, scope.id, request.sandboxId];
      const { backward, limit, maxBytes } = eventPageOptions(request, provider.id);
      const coalesce = request.coalesce ?? false;
      const anchor = hashRequest([request.cursor ?? null, request.conversationId ?? null, coalesce]);
      const digest = hashRequest([
        request.cursor ?? null,
        request.direction ?? "forward",
        request.conversationId ?? null,
        limit,
        maxBytes,
        coalesce,
      ]);
      const slot = (backward ? 4 : 0) + (Number.parseInt(digest[0]!, 16) % 4);
      const {
        rows: [target],
      } = await sql.query<{ generation: string; pending: boolean; observed: string }>(
        `select s.lifecycle_generation::text as generation, (${pendingCommand}) is true as pending,
                statement_timestamp()::text as observed
           from public.sandboxes s where ${authorizedSandbox}`,
        params,
      );
      if (!target) throw new VaultError("not_found", "No authorized native log target.");

      const journalParams = [...params, slot, digest];
      const persisted = async () => {
        const { rows } = await sql.query<{ digest: string; page: string }>(
          `select p.request_hash as digest, encode(p.page_enc,'base64') as page
           from public.sandboxes s join armada_logs.native_log_pages p
             on p.sandbox_id=s.id and p.provider_sandbox_id=s.provider_sandbox_id
           where ${authorizedSandbox} and ((p.slot=$5 and p.request_hash=$6) or ($7::boolean and p.slot>=4))
           order by (p.request_hash=$6) desc, p.observed_at desc, p.slot`,
          [...journalParams, backward],
        );
        for (const saved of rows) {
          const { budget, ...page }: StoredPage = JSON.parse(
            await decryptSecret(Uint8Array.from(Buffer.from(saved.page, "base64")), key),
          );
          if (saved.digest !== digest) {
            if (budget?.anchor !== anchor) continue;
            const rawCount = coalesce ? budget.limit : page.events.length;
            const bytes = coalesce ? budget.maxBytes : Buffer.byteLength(JSON.stringify(page.events));
            if (rawCount > limit || (bytes > maxBytes && (coalesce || rawCount !== 1))) continue;
          }
          pausedNativePages.add(page);
          return page;
        }
        return undefined;
      };
      request.signal?.throwIfAborted();
      if (target.pending) {
        const saved = await persisted();
        if (saved) return saved;
      }

      let page: EventPage;
      try {
        page = await provider.events(request);
      } catch (error) {
        if (error instanceof NativeOutputPending) {
          const saved = target.pending ? undefined : await persisted();
          if (saved) return saved;
          if (backward && request.cursor) {
            request.signal?.throwIfAborted();
            const pausedPage: EventPage = {
              events: [],
              cursor: request.cursor,
              olderCursor: request.cursor,
              hasMore: true,
            };
            pausedNativePages.add(pausedPage);
            return pausedPage;
          }
        }
        throw error;
      }
      if (page.events.length > 0) {
        const stored: StoredPage = backward ? { ...page, budget: { anchor, limit, maxBytes } } : page;
        const body = JSON.stringify(stored);
        if (Buffer.byteLength(body) <= 1_310_720) {
          try {
            const sealed = await encryptSecret(body, key);
            await sql.query(
              `insert into armada_logs.native_log_pages (sandbox_id,provider_sandbox_id,slot,request_hash,observed_at,page_enc)
             select s.id,s.provider_sandbox_id,$5,$6,$8::timestamptz,decode($9,'base64')
             from public.sandboxes s where ${authorizedSandbox} and s.lifecycle_generation=$7::bigint
               and (${pendingCommand}) is not true
             on conflict (sandbox_id,slot) do update
             set provider_sandbox_id=excluded.provider_sandbox_id,request_hash=excluded.request_hash,
                 observed_at=excluded.observed_at,page_enc=excluded.page_enc
             where native_log_pages.observed_at<=excluded.observed_at`,
              [...journalParams, target.generation, target.observed, Buffer.from(sealed).toString("base64")],
            );
          } catch {
            logError("Could not persist a redacted native log page.");
          }
        }
      }
      return page;
    },
  };
  return journalProvider;
}
