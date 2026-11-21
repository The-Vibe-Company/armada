import { createHash } from "node:crypto";
import { decryptSecret, type EventPage, encryptSecret, type Provider, type Sql, VaultError } from "@armada/core/server";
import { NativeOutputPending, persistedNativePages } from "./event-pagination.ts";

const authorizedSandbox = `
  s.id=$1::uuid and s.org_id=$2::uuid and s.provider_sandbox_id=$3
  and s.provider='boat' and not s.boat_runtime and s.runtime_transport is null
  and s.deleted_at is null and s.status<>'deleted'
  and exists(select 1 from public.members m where m.org_id=s.org_id and m.user_id=$4::uuid)
  and (coalesce(s.visibility,(select g.visibility from public.goldens g where g.id=s.golden_id))='org'
       or s.owner_id=$4::uuid)
`;

const pendingCommand = `
  s.activity_lease_id is not null and s.activity_until>now()
  and exists(select 1 from public.model_auth_state a
    where a.account_id=s.credential_id and a.account_version=s.credential_version)
`;

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
      const params = [scope.id, scope.orgId, request.sandboxId, scope.userId];
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            request.cursor ?? null,
            request.direction ?? "forward",
            request.conversationId ?? null,
            request.limit ?? 100,
            request.maxBytes ?? 262144,
            request.coalesce ?? false,
          ]),
        )
        .digest("hex");
      const slot = (request.direction === "backward" ? 4 : 0) + (Number.parseInt(digest[0]!, 16) % 4);
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
        const {
          rows: [saved],
        } = await sql.query<{ page: string }>(
          `select encode(p.page_enc,'base64') as page
           from public.sandboxes s join armada_logs.native_log_pages p
             on p.sandbox_id=s.id and p.provider_sandbox_id=s.provider_sandbox_id
           where ${authorizedSandbox} and p.slot=$5 and p.request_hash=$6`,
          journalParams,
        );
        if (!saved) return undefined;
        const page: EventPage = JSON.parse(
          await decryptSecret(Uint8Array.from(Buffer.from(saved.page, "base64")), key),
        );
        persistedNativePages.add(page);
        return page;
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
        if (error instanceof NativeOutputPending && !target.pending) {
          const saved = await persisted();
          if (saved) return saved;
        }
        throw error;
      }
      if (page.events.length > 0) {
        const body = JSON.stringify(page);
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
