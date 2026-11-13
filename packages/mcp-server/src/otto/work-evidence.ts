import type { Sql } from "@armada/core/server";
import type { OttoScope } from "./observation.ts";

type Value = "true" | "false" | "unknown";
type Fact = (
  subject: string,
  kind: string,
  value: string,
  source: string,
  sourceId: string,
  completeness: string,
  evidence: unknown,
  observedAt?: Date,
) => Promise<void>;
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const array = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);
/** Select metadata before persistence: no PR bodies, messages, outputs or credentials. */
export async function observeWork(
  sql: Sql,
  scope: OttoScope,
  pulls: { number: number; head?: { sha: string } }[],
  token: string,
  run: string,
  fact: Fact,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  async function get(
    path: string,
    select: (body: Record<string, unknown>, response: Response) => Record<string, unknown>,
  ) {
    const cached = (
      await sql.query<{ etag: string | null; items: Record<string, unknown>[] }>(
        "select etag,items from public.otto_github_pages where org_id=$1 and repository=$2 and path=$3",
        [scope.orgId, scope.repository, path],
      )
    ).rows[0];
    const response = await fetcher(`https://api.github.com/repos/${scope.repository}${path}`, {
      signal,
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
      },
    });
    if (response.status === 304) {
      if (!cached?.items[0]) throw Error("uncached_work_observation");
      return cached.items[0];
    }
    if (!response.ok) throw Error("work_observation_unavailable");
    const payload: unknown = await response.json();
    const body = select(Array.isArray(payload) ? { rules: payload } : obj(payload), response);
    await sql.query(
      `insert into public.otto_github_pages(org_id,repository,path,etag,items,next_path) values($1,$2,$3,$4,$5::jsonb,null)
    on conflict(org_id,repository,path) do update set etag=excluded.etag,items=excluded.items,next_path=null`,
      [scope.orgId, scope.repository, path, response.headers.get("etag"), JSON.stringify([body])],
    );
    return body;
  }
  const policies = new Map<string, Promise<Record<string, unknown>>>();
  for (const pr of pulls) {
    if (signal.aborted) break;
    const headSha = pr.head?.sha;
    if (!headSha || !/^[a-f0-9]{40}$/i.test(headSha)) continue;
    const record = (kind: string, value: Value, evidence: unknown) =>
      fact(
        `pr:${pr.number}`,
        `pr.work.${kind}`,
        value,
        "github.reconcile",
        run,
        value === "unknown" ? "partial" : "complete",
        { headSha, ...obj(evidence) },
      );
    let detail: Record<string, unknown>;
    try {
      detail = await get(`/pulls/${pr.number}`, (v) => ({
        headSha: obj(v.head).sha,
        baseRef: obj(v.base).ref,
        mergeable: typeof v.mergeable === "boolean" ? v.mergeable : null,
      }));
      if (detail.headSha !== headSha) throw Error("head_changed_during_observation");
      await record("conflict", detail.mergeable === false ? "true" : detail.mergeable === true ? "false" : "unknown", {
        mergeable: detail.mergeable,
      });
    } catch {
      await record("conflict", "unknown", {});
      await record("required_check", "unknown", {});
      continue;
    }
    let policy: Record<string, unknown> | undefined;
    if (typeof detail.baseRef === "string") {
      let pending = policies.get(detail.baseRef);
      if (!pending) {
        const classic = get(
          `/branches/${encodeURIComponent(detail.baseRef)}/protection/required_status_checks`,
          (v) => ({
            requirements: array(v.checks).length
              ? array(v.checks).map((c) => ({ context: c.context, appId: c.app_id ?? null }))
              : Array.isArray(v.contexts)
                ? v.contexts.map((context) => ({ context, appId: null }))
                : [],
          }),
        ).catch(() => undefined);
        const rules = get(`/rules/branches/${encodeURIComponent(detail.baseRef)}`, (v) => ({
          requirements: array(v.rules)
            .filter((rule) => rule.type === "required_status_checks")
            .flatMap((rule) =>
              array(obj(rule.parameters).required_status_checks).map((check) => ({
                context: check.context,
                appId: check.integration_id ?? null,
              })),
            ),
        })).catch(() => undefined);
        pending = Promise.all([classic, rules]).then((parts) => {
          if (!parts.some(Boolean)) throw Error("required_check_policy_unavailable");
          return {
            requirements: parts.flatMap((part, index) =>
              array(part?.requirements).map((rule) => ({
                ...rule,
                policySource: index === 0 ? "classic" : "active_rules",
              })),
            ),
          };
        });
        policies.set(detail.baseRef, pending);
      }
      try {
        policy = await pending;
      } catch {
        /* Missing policy is not permission to call any failure required. */
      }
    }
    try {
      const checks = await get(`/commits/${headSha}/check-runs?filter=latest&per_page=100`, (v, r) => ({
        complete:
          !r.headers.get("link")?.includes('rel="next"') && Number(v.total_count) === array(v.check_runs).length,
        checks: array(v.check_runs).map((c) => ({
          name: c.name,
          appId: obj(c.app).id,
          headSha: c.head_sha,
          status: c.status,
          conclusion: c.conclusion,
        })),
      }));
      const statuses = await get(`/commits/${headSha}/status?per_page=100`, (v, r) => ({
        headSha: v.sha,
        complete: !r.headers.get("link")?.includes('rel="next"') && Number(v.total_count) === array(v.statuses).length,
        statuses: array(v.statuses).map((c) => ({ name: c.context, state: c.state })),
      }));
      if (statuses.headSha !== headSha || array(checks.checks).some((c) => c.headSha !== headSha))
        throw Error("status_head_mismatch");
      const requirements = array(policy?.requirements).filter(
        (r) =>
          typeof r.context === "string" &&
          r.context.length > 0 &&
          (r.appId === null || (Number.isSafeInteger(r.appId) && Number(r.appId) > 0)),
      );
      if (
        array(checks.checks).some(
          (c) =>
            typeof c.name !== "string" ||
            !["queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(String(c.status)) ||
            (c.status === "completed" &&
              ![
                "failure",
                "success",
                "neutral",
                "skipped",
                "cancelled",
                "timed_out",
                "action_required",
                "stale",
              ].includes(String(c.conclusion))),
        ) ||
        array(statuses.statuses).some(
          (c) => typeof c.name !== "string" || !["failure", "error", "pending", "success"].includes(String(c.state)),
        )
      )
        throw Error("invalid_check_observation");
      const failedCheck = array(checks.checks).find(
        (c) =>
          c.headSha === headSha &&
          c.status === "completed" &&
          c.conclusion === "failure" &&
          requirements.some(
            (required) => required.context === c.name && (required.appId === null || required.appId === c.appId),
          ),
      );
      const failedStatus = array(statuses.statuses).find(
        (c) =>
          c.state === "failure" &&
          requirements.some((required) => required.context === c.name && required.appId === null),
      );
      const anyFailure =
        array(checks.checks).some(
          (c) => c.status === "completed" && !["success", "neutral", "skipped"].includes(String(c.conclusion)),
        ) || array(statuses.statuses).some((c) => c.state === "failure" || c.state === "error");
      // A positive required failure needs policy + producer identity. A negative needs the whole check universe.
      const value: Value =
        failedCheck || failedStatus
          ? "true"
          : checks.complete === true && statuses.complete === true && !anyFailure
            ? "false"
            : "unknown";
      const witness = requirements.find(
        (rule) =>
          rule.context === (failedCheck?.name ?? failedStatus?.name) &&
          (rule.appId === null || rule.appId === failedCheck?.appId),
      );
      await record("required_check", value, {
        baseRef: detail.baseRef,
        observedAppId: failedCheck?.appId ?? null,
        requiredAppId: witness?.appId ?? null,
        policySource: witness?.policySource ?? null,
        context: failedCheck?.name ?? failedStatus?.name ?? null,
        policyObserved: !!policy,
        checksComplete: checks.complete === true && statuses.complete === true,
      });
    } catch {
      await record("required_check", "unknown", {});
    }
  }
}

export async function observeQueue(
  sql: Sql,
  scope: OttoScope,
  number: number,
  headSha: string,
  action: unknown,
  delivery: string,
  fact: Fact,
  observedAt?: Date,
) {
  if (action !== "enqueued" && action !== "dequeued") return;
  const previous = (
    await sql.query<{ source_at: string | null }>(
      `select evidence->>'sourceUpdatedAt' as source_at from public.otto_facts where org_id=$1 and repository=$2 and subject=$3 and kind='pr.work.queue' and evidence->>'headSha'=$4 order by evidence->>'sourceUpdatedAt' desc nulls last limit 1`,
      [scope.orgId, scope.repository, `pr:${number}`, headSha],
    )
  ).rows[0];
  const sourceFresh =
    !!observedAt && Date.now() - observedAt.getTime() >= 0 && Date.now() - observedAt.getTime() < 600_000;
  const ordered = sourceFresh && (!previous?.source_at || Date.parse(previous.source_at) < observedAt!.getTime());
  const entry =
    action === "dequeued" && ordered
      ? (
          await sql.query<{ id: string }>(
            `select id from public.otto_facts where org_id=$1 and repository=$2 and subject=$3 and kind='pr.work.queue' and evidence->>'headSha'=$4 and evidence->>'enqueued'='true' and evidence->>'sourceUpdatedAt'<$5::text order by observed_at desc,id desc limit 1`,
            [scope.orgId, scope.repository, `pr:${number}`, headSha, observedAt?.toISOString() ?? null],
          )
        ).rows[0]
      : undefined;
  const value = !ordered ? "unknown" : action === "enqueued" ? "false" : entry ? "true" : "unknown";
  await fact(
    `pr:${number}`,
    "pr.work.queue",
    value,
    "github.webhook",
    delivery,
    value === "unknown" ? "partial" : "complete",
    {
      headSha,
      enqueued: action === "enqueued",
      entryFactId: entry?.id ?? null,
      sourceUpdatedAt: observedAt?.toISOString() ?? null,
    },
  );
}
