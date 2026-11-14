import { createHmac, timingSafeEqual } from "node:crypto";
import { readBoundedText } from "@armada/auth";
import type { Sql } from "@armada/core/server";
import type { Route } from "../http.ts";
import { createOttoObserver, type OttoScope } from "./observation.ts";
import { recordOrphanDays } from "./orphan-days.ts";
import { readOttoModel } from "./read-model.ts";

/** Opt-in, one repository binding; credentials never leave the server process. */
function createRepositoryRuntime(sql: Sql, env: Record<string, string | undefined>) {
  const orgId = env.ARMADA_OTTO_ORG_ID,
    repository = env.ARMADA_OTTO_REPOSITORY;
  if (!orgId && !repository) return undefined;
  if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId) || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw Error("Invalid Otto repository binding");
  const scope: OttoScope = { orgId, repository };
  const observer = createOttoObserver(sql, scope);
  let nextAt = 0;
  const runtime = {
    scope,
    route: observer.webhook(env.ARMADA_OTTO_WEBHOOK_SECRET, env.ARMADA_OTTO_MAIN_BRANCH ?? "main") as Route,
    lane: {
      async reconcileOne(signal: AbortSignal) {
        if (Date.now() < nextAt) return false;
        nextAt = Date.now() + 60_000;
        try {
          const members = (
            await sql.query<{ user_id: string; role: "admin" | "member" }>(
              "select user_id,role from public.members where org_id=$1",
              [orgId],
            )
          ).rows;
          for (const member of members) {
            const caller = { userId: member.user_id, orgs: [{ orgId, role: member.role }], via: "service" as const };
            const now = new Date();
            const model = await readOttoModel(sql, scope, caller, now, env.ARMADA_ENCRYPTION_KEY);
            await recordOrphanDays(sql, scope, caller, model.resources, now);
          }
        } catch {
          console.warn("Otto history observation unavailable");
        }
        if (!env.ARMADA_OTTO_GITHUB_TOKEN) return false;
        if (!sql.transaction) throw Error("Otto reconciliation requires transactions");
        await sql.transaction(async (tx) => {
          const lock = (
            await tx.query<{ locked: boolean }>("select pg_try_advisory_xact_lock(hashtext($1)) as locked", [
              `otto:${orgId}:${repository}`,
            ])
          ).rows[0];
          if (!lock?.locked) return;
          const recent = (
            await tx.query(
              `select id from public.otto_facts where org_id=$1 and repository=$2 and kind='repository.open_prs' and observed_at > now()-interval '5 minutes' limit 1`,
              [orgId, repository],
            )
          ).rows[0];
          if (!recent) await createOttoObserver(tx, scope).reconcile(env.ARMADA_OTTO_GITHUB_TOKEN!, signal);
        });
        return false;
      },
      async drain() {},
    },
  };
  return {
    ...runtime,
    start() {
      const shutdown = new AbortController();
      const done = (async () => {
        while (!shutdown.signal.aborted) {
          try {
            await runtime.lane.reconcileOne(AbortSignal.any([shutdown.signal, AbortSignal.timeout(30_000)]));
          } catch {
            /* The journal/read API remains unknown; never log credentials. */
          }
          if (!shutdown.signal.aborted)
            await new Promise<void>((resolve) => {
              const wake = () => {
                clearTimeout(timer);
                shutdown.signal.removeEventListener("abort", wake);
                resolve();
              };
              const timer = setTimeout(wake, 60_000);
              timer.unref();
              shutdown.signal.addEventListener("abort", wake, { once: true });
            });
        }
      })();
      return { done, stop: () => shutdown.abort() };
    },
  };
}

/** Explicit repository allowlist; each repository retains its own lock, cache and failure boundary. */
export function createOttoRuntime(sql: Sql, env: Record<string, string | undefined>) {
  const repositories =
    env.ARMADA_OTTO_REPOSITORIES?.split(",").map((value) => value.trim()) ??
    (env.ARMADA_OTTO_REPOSITORY ? [env.ARMADA_OTTO_REPOSITORY] : []);
  if (!repositories.length) {
    if (env.ARMADA_OTTO_ORG_ID) throw Error("Invalid Otto repository binding");
    return undefined;
  }
  if (repositories.length > 20 || new Set(repositories.map((v) => v.toLowerCase())).size !== repositories.length)
    throw Error("Invalid Otto repository bindings");
  const runtimes = repositories.map(
    (repository) => createRepositoryRuntime(sql, { ...env, ARMADA_OTTO_REPOSITORY: repository })!,
  );
  return {
    scope: runtimes[0]!.scope,
    scopes: runtimes.map((runtime) => runtime.scope),
    route: (async (request) => {
      if (new URL(request.url).pathname !== "/api/v1/otto/github/webhook") return null;
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const secret = env.ARMADA_OTTO_WEBHOOK_SECRET;
      if (!secret) return Response.json({ error: "webhook_not_configured" }, { status: 503 });
      const signature = request.headers.get("x-hub-signature-256") ?? "";
      if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return new Response(null, { status: 401 });
      let raw: string;
      try {
        raw = await readBoundedText(request, 1024 * 1024);
      } catch {
        return new Response(null, { status: 413 });
      }
      const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return new Response(null, { status: 401 });
      let repository: unknown;
      try {
        repository = JSON.parse(raw)?.repository?.full_name;
      } catch {
        return new Response(null, { status: 400 });
      }
      const runtime = runtimes.find((runtime) => runtime.scope.repository === repository);
      if (!runtime) return new Response(null, { status: 403 });
      return runtime.route(new Request(request.url, { method: "POST", headers: request.headers, body: raw }));
    }) as Route,
    start() {
      const workers = runtimes.map((runtime) => runtime.start());
      return {
        done: Promise.all(workers.map((worker) => worker.done)),
        stop: () => {
          for (const worker of workers) worker.stop();
        },
      };
    },
  };
}
