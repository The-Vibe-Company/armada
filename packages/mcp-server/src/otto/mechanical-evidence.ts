import type { OttoMechanicalEvidence } from "@armada/core";
import type { OwnershipFact } from "./ownership.ts";

/** A negative failure observation is NOT proof that all required checks passed. */
export function mechanicalEvidence(
  repository: string,
  number: number,
  facts: OwnershipFact[],
  now: Date,
): OttoMechanicalEvidence {
  const ordered = facts
    .filter((f) => f.subject === `pr:${number}`)
    .sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at) || b.id.localeCompare(a.id));
  const pr = ordered.find((f) => f.kind === "pr.open");
  const head = pr?.evidence.head as { sha?: string } | undefined;
  const headSha = head?.sha && /^[a-f0-9]{40}$/i.test(head.sha) ? head.sha : null;
  const fresh = (f: OwnershipFact) => {
    const age = now.getTime() - Date.parse(f.observed_at);
    return age >= 0 && age < 600_000;
  };
  const current = headSha && pr && fresh(pr) ? ordered.filter((f) => f.evidence.headSha === headSha && fresh(f)) : [];
  const check = current.find((f) => f.kind === "pr.work.required_check");
  const conflict = current.find((f) => f.kind === "pr.work.conflict");
  const url = `https://github.com/${repository}/pull/${number}`;
  return {
    repository,
    number,
    headSha,
    observedAt: pr ? new Date(pr.observed_at).toISOString() : null,
    requiredChecks:
      check?.completeness === "complete" && check.value === "true" && check.evidence.policyObserved === true
        ? "failure"
        : "unknown",
    mergeState:
      conflict?.completeness === "complete"
        ? conflict.value === "true"
          ? "conflicting"
          : conflict.value === "false"
            ? "mergeable"
            : "unknown"
        : "unknown",
    merged: null,
    checks: [],
    deployment: "unknown",
    evidence: [...(pr ? [pr] : []), ...current.filter((f) => f === check || f === conflict)].map((f) => ({
      factId: f.id,
      kind: f.kind,
      observedAt: new Date(f.observed_at).toISOString(),
      url: f.kind === "pr.work.required_check" ? `${url}/checks` : url,
    })),
    limits: [
      "Required-check success and merged/deployed state are not established by the available observations.",
      "Missing, stale, denied or incomplete evidence stays unknown. A newer head invalidates earlier check evidence.",
      "Mechanical evidence does not establish objective completion or human approval.",
    ],
  };
}

/** Read-only, bounded GitHub inspection; return selected metadata only. No bodies or credentials. */
export async function inspectMechanicalEvidence(
  repository: string,
  number: number,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<OttoMechanicalEvidence> {
  const signal = AbortSignal.timeout(2500);
  const get = async (path: string, absentClassic = false): Promise<Record<string, any>> => {
    const response = await fetcher(`https://api.github.com/repos/${repository}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      redirect: "error",
      signal,
    });
    if (absentClassic && response.status === 404) return { checks: [] };
    if (!response.ok || response.headers.get("link")?.includes('rel="next"')) throw Error("incomplete_proof");
    return (await response.json()) as Record<string, any>;
  };
  const result = mechanicalEvidence(repository, number, [], new Date());
  const pr = await get(`/pulls/${number}`);
  const head = pr.head?.sha;
  if (typeof head !== "string" || !/^[a-f0-9]{40}$/i.test(head) || typeof pr.base?.ref !== "string") return result;
  result.headSha = head;
  result.observedAt = new Date().toISOString();
  result.merged = typeof pr.merged === "boolean" ? pr.merged : null;
  result.mergeState = pr.mergeable === true ? "mergeable" : pr.mergeable === false ? "conflicting" : "unknown";
  try {
    // Classic 404 means no classic policy; denied reads still fail closed.
    const [classic, rules, checks, statuses] = await Promise.all([
      get(`/branches/${encodeURIComponent(pr.base.ref)}/protection/required_status_checks`, true),
      get(`/rules/branches/${encodeURIComponent(pr.base.ref)}`),
      get(`/commits/${head}/check-runs?filter=latest&per_page=100`),
      get(`/commits/${head}/status?per_page=100`),
    ]);
    if (
      !Array.isArray(rules) ||
      !Array.isArray(checks.check_runs) ||
      !Array.isArray(statuses.statuses) ||
      checks.total_count !== checks.check_runs.length ||
      statuses.total_count !== statuses.statuses.length ||
      statuses.sha !== head ||
      checks.check_runs.some((c: any) => c.head_sha !== head)
    )
      throw Error("incomplete_proof");
    const requirements = [
      ...(Array.isArray(classic.checks) && classic.checks.length
        ? classic.checks.map((c: any) => ({ context: c.context, appId: c.app_id }))
        : Array.isArray(classic.contexts)
          ? classic.contexts.map((context: string) => ({ context, appId: null }))
          : []),
      ...rules
        .filter((r: any) => r.type === "required_status_checks")
        .flatMap((r: any) => {
          if (!Array.isArray(r.parameters?.required_status_checks)) throw Error("incomplete_policy");
          return r.parameters.required_status_checks.map((c: any) => ({ context: c.context, appId: c.integration_id }));
        }),
    ];
    if (!Array.isArray(classic.checks) && !Array.isArray(classic.contexts)) throw Error("incomplete_policy");
    if (!requirements.length) throw Error("no_observed_requirements");
    result.checks = requirements.map((r: any) => {
      if (
        typeof r.context !== "string" ||
        !r.context ||
        (r.appId != null && (!Number.isSafeInteger(r.appId) || r.appId <= 0))
      )
        throw Error("invalid_policy");
      const runs = checks.check_runs.filter(
        (c: any) => c.name === r.context && (r.appId == null || c.app?.id === r.appId),
      );
      const states = r.appId == null ? statuses.statuses.filter((c: any) => c.context === r.context) : [];
      const values = [
        ...runs.map((c: any) =>
          c.status !== "completed"
            ? "pending"
            : ["success", "neutral", "skipped"].includes(c.conclusion)
              ? "success"
              : "failure",
        ),
        ...states.map((c: any) => (c.state === "success" ? "success" : c.state === "pending" ? "pending" : "failure")),
      ];
      return {
        name: r.context,
        state: !values.length
          ? "pending"
          : values.includes("failure")
            ? "failure"
            : values.includes("pending")
              ? "pending"
              : "success",
      };
    });
    // One visible context can be required from several producers; retain the worst state.
    result.checks = [...new Set(result.checks.map((check) => check.name))].map((name) => {
      const states = result.checks.filter((check) => check.name === name).map((check) => check.state);
      return {
        name,
        state: states.includes("failure") ? "failure" : states.includes("pending") ? "pending" : "success",
      };
    });
    result.requiredChecks = result.checks.some((c) => c.state === "failure")
      ? "failure"
      : result.checks.some((c) => c.state === "pending")
        ? "pending"
        : "success";
  } catch {
    result.requiredChecks = "unknown";
    result.checks = [];
  }
  // The PR may have changed while policy/checks were being read.
  const latest = await get(`/pulls/${number}`);
  if (latest.head?.sha !== head || latest.base?.ref !== pr.base.ref)
    return mechanicalEvidence(repository, number, [], new Date());
  const pullUrl = `https://github.com/${repository}/pull/${number}`;
  result.evidence = [
    { factId: "live:head", kind: "Observed PR head and merge state", observedAt: result.observedAt!, url: pullUrl },
    {
      factId: "live:checks",
      kind: "Exact-head checks",
      observedAt: result.observedAt!,
      url: `https://github.com/${repository}/commit/${head}/checks`,
    },
    {
      factId: "live:policy",
      kind: "Repository rules",
      observedAt: result.observedAt!,
      url: `https://github.com/${repository}/rules`,
    },
  ];
  result.limits = [
    "Observed mechanical facts do not establish objective completion or human approval.",
    "Deployment is unknown: no target-environment proof was observed.",
  ];
  return result;
}
