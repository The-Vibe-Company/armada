// The demo world's overview, built without a database (THE-887): what the
// dashboard shows once `bun run demo:seed` filled one, from the same pieces
// (the Linear program and pull requests, the coordinator's inbox and its
// reads), through core's buildOverview. The landing's replica of the fleet
// is drawn from it at build time.
import { buildOverview, buildStatus, configTemplate, type FleetOverview, parseConfig } from "@armada/core/read";
import {
  DEMO_COORDINATOR_SEEN,
  DEMO_INBOX,
  DEMO_PROJECTS,
  demoCoordinatorFacts,
  demoInboxReads,
  demoSnapshot,
  type Scenario,
} from "./world";

export function demoOverview(now: Date, scenario: Scenario = "fleet"): FleetOverview {
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  return buildOverview({
    projects: DEMO_PROJECTS.map((p) => {
      const config = parseConfig(configTemplate(p));
      const { program, forge } = demoSnapshot(p, scenario, now);
      const seen = DEMO_COORDINATOR_SEEN[p.slug];
      const facts = demoCoordinatorFacts(p.slug);
      const reads = demoInboxReads(p.slug);
      return {
        slug: p.slug,
        name: p.name,
        repository: p.repository,
        report: buildStatus({ config, program, forge, now }),
        error: null,
        live: {
          // Hand-backs wait in the overview from their phase; ids are the inbox's, one series for every project.
          inbox: DEMO_INBOX.flatMap((i, k) =>
            i.project === p.slug && i.kind !== "hand-back" ? [{ ...i, id: k + 1 }] : [],
          ).map((i) => ({
            id: i.id,
            project: i.project,
            ticket: i.ticket,
            kind: i.kind,
            recipient: "coordinator",
            author: i.author,
            body: i.body,
            createdAt: ago(i.ago),
          })),
          coordinatorSeenAt: seen === undefined ? null : ago(seen),
          coordinator:
            facts && seen !== undefined
              ? {
                  ...facts,
                  startedAt: ago(Math.max(...reads, seen)),
                  seenAt: ago(seen),
                  inboxSeenAt: ago(seen),
                }
              : null,
          inboxReads: reads.map((m, k) => ({ id: k + 1, at: ago(m), handle: facts?.handle ?? null })),
        },
        history: { comments: program.comments, events: [] },
      };
    }),
    live: { state: "ok", error: null },
    now,
  });
}
