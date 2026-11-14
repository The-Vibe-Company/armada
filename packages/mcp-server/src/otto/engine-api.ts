import { isHarness, isRecord, type OttoEngine } from "@armada/core";
import { type CredentialReader, listConnectionModels, type Sql } from "@armada/core/server";
import type { CallerResult } from "../caller.ts";
import type { Route } from "../http.ts";
import { preflightOttoEngine } from "./engine-preflight.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Preferences do not create attempts or launch anything; auth and account visibility are checked anew. */
export function createOttoEngineApi(
  sql: Sql,
  reader: CredentialReader,
  encryptionKey: string | undefined,
  authenticate: (request: Request) => Promise<CallerResult>,
): Route {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/v1/otto/engine") return null;
    const reply = (body: unknown, status = 200) =>
      Response.json(body, { status, headers: { "cache-control": "no-store" } });
    try {
      const auth = await authenticate(request);
      if (!auth.ok) return reply({ error: "unauthorized" }, 401);
      const orgId = url.searchParams.get("org_id");
      if (!orgId || !auth.caller.orgs.some((org) => org.orgId === orgId)) return reply({ error: "not_found" }, 404);
      const userId = auth.caller.userId;
      if (request.method === "GET") {
        const engine =
          (
            await sql.query<OttoEngine>(
              'select harness,model,credential_id as "credentialId" from public.otto_engine_preferences where org_id=$1 and user_id=$2',
              [orgId, userId],
            )
          ).rows[0] ?? null;
        const accounts = (
          await sql.query<{ id: string; name: string; kind: string; status: string }>(
            "select id,name,kind,status from public.credentials where kind in ('claude_oauth','anthropic','openai','codex_auth','opencode') and ((scope='user' and owner_id=$1) or (scope='org' and owner_id=$2))",
            [userId, orgId],
          )
        ).rows;
        const connections = await listConnectionModels(reader, encryptionKey, { userId, orgId });
        return reply({
          engine,
          accounts: accounts.map((account) => ({
            ...account,
            models: connections.find((a) => a.id === account.id)?.models.map((m) => m.model),
          })),
          preflight: engine ? await preflightOttoEngine(reader, encryptionKey, { userId, orgId }, engine) : null,
        });
      }
      if (request.method !== "PUT") return reply({ error: "method_not_allowed" }, 405);
      const body = await request.json().catch(() => null);
      if (
        !isRecord(body) ||
        !isHarness(body.harness) ||
        typeof body.model !== "string" ||
        body.model.length > 200 ||
        typeof body.credentialId !== "string" ||
        !uuid.test(body.credentialId)
      )
        return reply({ error: "invalid_engine" }, 400);
      const engine: OttoEngine = { harness: body.harness, model: body.model, credentialId: body.credentialId };
      const preflight = await preflightOttoEngine(reader, encryptionKey, { userId, orgId }, engine);
      if (!preflight.ready) return reply({ preflight }, 422);
      await sql.query(
        "insert into public.otto_engine_preferences(org_id,user_id,harness,model,credential_id) values($1,$2,$3,$4,$5) on conflict(org_id,user_id) do update set harness=excluded.harness,model=excluded.model,credential_id=excluded.credential_id",
        [orgId, userId, engine.harness, engine.model, engine.credentialId],
      );
      return reply({ engine, preflight });
    } catch {
      return reply({ error: "engine_unavailable" }, 503);
    }
  };
}
