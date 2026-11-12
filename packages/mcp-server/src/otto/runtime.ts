import type { Sql } from "@armada/core/server";
import type { Route } from "../http.ts";
import { createOttoObserver, type OttoScope } from "./observation.ts";

/** Opt-in, one repository binding; credentials never leave the server process. */
export function createOttoRuntime(sql: Sql, env: Record<string, string | undefined>) {
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
        if (!env.ARMADA_OTTO_GITHUB_TOKEN || Date.now() < nextAt) return false;
        nextAt = Date.now() + 300_000;
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
