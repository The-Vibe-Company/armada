import { readBoundedText } from "@armada/auth";
import { type Sql, VaultError } from "@armada/core/server";
import type { Route } from "./http.ts";
import { createRuntimeEnrolments, RuntimeEnrolmentDenied } from "./runtime-enrolment.ts";
import { runtimeHttpFailure } from "./runtime-http-failure.ts";
import type { createSubscriptionBroker } from "./subscription-broker.ts";

class InvalidRequest extends Error {}
/** Access-only subscription material, bound to a live runtime epoch, never a stable guest capability. */
export function createRuntimeModelAccess(
  sql: Sql,
  key: string,
  broker: Pick<ReturnType<typeof createSubscriptionBroker>, "access"> | undefined,
): Route {
  const authority = createRuntimeEnrolments(sql, key);
  return async (request) => {
    if (new URL(request.url).pathname !== "/api/runtime/model-access") return null;
    const headers = { "cache-control": "no-store" };
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, allow: "POST" } });
    try {
      if (request.headers.has("origin")) throw new InvalidRequest();
      const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? "";
      const epoch = request.headers.get("x-armada-runtime-epoch") ?? "";
      let body: unknown;
      try {
        body = JSON.parse(await readBoundedText(request, 1024));
      } catch {
        throw new InvalidRequest();
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new InvalidRequest();
      const input = body as Record<string, unknown>;
      if (
        Object.keys(input).some((k) => k !== "previousRevision") ||
        (input.previousRevision !== undefined &&
          (!Number.isSafeInteger(input.previousRevision) || (input.previousRevision as number) < 0))
      )
        throw new InvalidRequest();
      const binding = await authority.withSession(token, epoch, async (tx, scope) => {
        const row = (
          await tx.query<{ owner_id: string; org_id: string; credential_id: string; credential_version: number }>(
            `select s.owner_id,s.org_id,s.credential_id,s.credential_version from public.sandboxes s
           join public.credentials c on c.id=s.credential_id and c.version=s.credential_version
           join public.model_auth_state a on a.account_id=c.id and a.account_version=c.version
           where s.id=$1 and s.harness='codex' and c.kind='codex_auth' and c.status='active'
           and (c.expires_at is null or c.expires_at>now()) and a.source_generation like 'server:%'`,
            [scope.sandboxId],
          )
        ).rows[0];
        if (!row) throw new RuntimeEnrolmentDenied();
        return { ...row, sandboxId: scope.sandboxId };
      });
      if (!broker || !sql.transaction) throw Error("runtime_model_access_unavailable");
      const actor = { userId: binding.owner_id, orgId: binding.org_id, role: "member" as const };
      // Refresh owns credential/state locks. Never hold sandbox/epoch locks across it.
      const access = await broker.access(
        actor,
        binding.credential_id,
        binding.credential_version,
        input.previousRevision as number | undefined,
      );
      return await sql.transaction(async (tx) => {
        // Match native publication: all source actors precede credential/source locks.
        const members = await authority.lockSourceMembers(tx, binding.sandboxId, actor.userId);
        const credential = await tx.query(
          `select id from public.credentials where id=$1 and version=$2 and kind='codex_auth' and status='active'
           and (expires_at is null or expires_at>now()) and ((scope='user' and owner_id=$3) or (scope='org' and owner_id=$4)) for share`,
          [binding.credential_id, binding.credential_version, actor.userId, actor.orgId],
        );
        if (!credential.rows.length) throw new RuntimeEnrolmentDenied();
        const scoped: Sql = { query: (q, v) => tx.query(q, v), transaction: (work) => work(tx) };
        return createRuntimeEnrolments(scoped, key).withSession(
          token,
          epoch,
          async (locked, scope) => {
            const current = await locked.query(
              `select id from public.sandboxes where id=$1 and owner_id=$2 and org_id=$3 and harness='codex'
             and credential_id=$4 and credential_version=$5
             and exists(select 1 from public.model_auth_state a where a.account_id=$4 and a.account_version=$5 and a.source_generation like 'server:%')`,
              [scope.sandboxId, actor.userId, actor.orgId, binding.credential_id, binding.credential_version],
            );
            if (scope.sandboxId !== binding.sandboxId || !current.rows.length) throw new RuntimeEnrolmentDenied();
            // Explicit projection: never return refresh tokens or extra broker metadata.
            return Response.json(
              {
                epoch: scope.epoch,
                access: {
                  accessToken: access.accessToken,
                  chatgptAccountId: access.chatgptAccountId,
                  chatgptPlanType: access.chatgptPlanType,
                  revision: access.revision,
                },
              },
              { headers },
            );
          },
          members,
        );
      });
    } catch (error) {
      const status =
        error instanceof RuntimeEnrolmentDenied
          ? 401
          : error instanceof InvalidRequest
            ? 400
            : error instanceof VaultError && ["credential_refused", "forbidden", "not_found"].includes(error.code)
              ? 403
              : 503;
      return runtimeHttpFailure(status, "runtime_model_access_unavailable");
    }
  };
}
