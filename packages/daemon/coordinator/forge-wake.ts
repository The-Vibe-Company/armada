import type { ProjectTables } from "@armada/protocol";

/** Ticket candidates consumed by the Waker; comments deliberately never enter it. */
export function forgeWakeups(before: ProjectTables | undefined, after: ProjectTables | undefined) {
  const candidates: {
    key: string;
    summary: string;
    facts: { ticket: string; pr: number; head?: string; state: string };
  }[] = [];
  for (const pr of after?.pullRequests ?? []) {
    if (pr.state !== "open" || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(pr.ticket)) continue;
    if (!after?.sessions.some((s) => s.ticket === pr.ticket && !["released", "merged"].includes(s.phase))) continue;
    const prior = before?.pullRequests.find((p) => p.number === pr.number);
    for (const state of ["conflicting", "behind"] as const) {
      if (!pr[state] || (prior?.[state] && prior.head === pr.head && (state !== "behind" || prior.base === pr.base)))
        continue;
      const head = /^[a-f0-9]{40}$/i.test(pr.head) ? pr.head.toLowerCase() : undefined;
      const base = pr.base && /^[a-f0-9]{40}$/i.test(pr.base) ? pr.base.toLowerCase() : "unknown";
      candidates.push({
        key: `forge:${state}:${pr.number}@${head ?? "unknown"}${state === "behind" ? `:${base}` : ""}`,
        summary: `${pr.ticket} #${pr.number} ${state === "conflicting" ? "conflicts with its base" : "is behind its base"}`,
        facts: { ticket: pr.ticket, pr: pr.number, ...(head ? { head } : {}), state },
      });
    }
  }
  return candidates;
}
