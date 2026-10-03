// The demo world's overview, built without a database (THE-887): what the
// dashboard shows once `bun run demo:seed` filled one, from the same pieces
// (the Linear program and pull requests, the coordinator's inbox and its
// reads, the owner's validations without their screenshots), through core's
// buildOverview. The landing's replica of the fleet is drawn from it at build time.
import {
  buildOverview,
  buildStatus,
  configTemplate,
  type FleetOverview,
  type OwnerValidation,
  parseConfig,
} from "@armada/core/read";
import {
  DEMO_COORDINATOR_SEEN,
  DEMO_INBOX,
  DEMO_PROJECTS,
  DEMO_VALIDATIONS,
  demoCoordinatorFacts,
  demoInboxReads,
  demoSnapshot,
  demoValidationPr,
  type Scenario,
} from "./world";

/** The demo's validations, as the seed records them; ids follow the list, and no gallery without a database. */
export function demoValidations(now: Date): OwnerValidation[] {
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  return DEMO_VALIDATIONS.map((v, k) => ({
    id: k + 1,
    project: v.project,
    ticket: v.ticket,
    kind: v.kind,
    what: v.what,
    reason: v.reason,
    choices: v.choices,
    pr: demoValidationPr(v),
    attachments: [],
    author: v.author,
    createdAt: ago(v.ago),
    decision: v.decided
      ? { outcome: v.decided.outcome, answer: null, note: v.decided.note, by: v.decided.by, at: ago(v.decided.ago) }
      : null,
    title: null,
    url: null,
    gallery: [],
  }));
}

export function demoOverview(now: Date, scenario: Scenario = "fleet"): FleetOverview {
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const validations = demoValidations(now);
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
          validations: validations.filter((v) => v.project === p.slug),
        },
        history: { comments: program.comments, events: [] },
      };
    }),
    live: { state: "ok", error: null },
    now,
  });
}
