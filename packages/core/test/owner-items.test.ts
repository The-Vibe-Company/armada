import { describe, expect, test } from "bun:test";
import type { InboxItem, MergeHold } from "../src/live.ts";
import type { QueueEntry } from "../src/merge-queue.ts";
import { buildOverview, type ProjectReading } from "../src/overview.ts";
import { coordinatorAlerts, ownerItems, ownerMilestones, pendingValidations } from "../src/owner-items.ts";
import type { FleetOverview, OwnerValidation, ProjectOverview, WaitingItem } from "../src/read.ts";
import type { InFlightTicket } from "../src/status.ts";

import { issue } from "./support.ts";

// A synthetic fleet, for these tests only.
const project = (slug: string, state: "active" | "idle" | "unknown", seenAt: string | null = null) =>
  ({ slug, name: slug.toUpperCase(), coordinator: { state, seenAt } }) as ProjectOverview;

const workerItem = (kind: WaitingItem["kind"], ticket: string, coordinatorSince: string | null = null): WaitingItem =>
  ({
    kind,
    project: "widgets",
    ticket,
    title: `${kind} on ${ticket}`,
    item: 4,
    since: "2026-03-04T09:00:00Z",
    coordinatorSince,
  }) as WaitingItem;

const validation = (id: number, kind: OwnerValidation["kind"], decided = false): OwnerValidation =>
  ({
    id,
    project: "widgets",
    ticket: "WID-1",
    kind,
    title: "The product card",
    what: "Check it",
    decision: decided ? { outcome: "approved" } : null,
  }) as OwnerValidation;

const overview = (o: Partial<FleetOverview>) =>
  ({
    rows: [],
    waiting: [],
    projects: [project("widgets", "active")],
    validations: [],
    ...o,
  }) as unknown as FleetOverview;

describe("owner items", () => {
  test("fire for a validation to decide, a question escalated to the owner and a stopped coordinator with items waiting", () => {
    expect(pendingValidations({})).toEqual([]);
    expect(
      pendingValidations({
        validations: [validation(3, "merge", true), validation(1, "merge"), validation(2, "question")],
      }).map((v) => v.id),
    ).toEqual([1, 2]);
    const at = (minutes: number) => new Date(Date.parse("2026-03-04T10:00:00Z") + minutes * 60_000).toISOString();
    expect(
      coordinatorAlerts({
        projects: [
          project("widgets", "idle", at(40)),
          project("gadgets", "unknown"),
          project("gizmos", "active", at(1)),
        ],
        waiting: [
          workerItem("question", "WID-1", at(25)),
          workerItem("question", "WID-2", at(35)),
          workerItem("question", "WID-3"),
          { ...workerItem("question", "GAD-1"), project: "gadgets" },
          { ...workerItem("question", "GIZ-1", at(50)), project: "gizmos" },
        ],
      }),
    ).toEqual([{ project: "widgets", state: "idle", seenAt: at(40), waiting: 2, since: at(25) }]);
    const items = ownerItems(
      overview({
        validations: [validation(7, "merge"), validation(8, "question"), validation(9, "validation", true)],
        projects: [project("widgets", "idle", "2026-03-04T08:00:00Z")],
        waiting: [workerItem("question", "WID-2", "2026-03-04T09:00:00Z")],
      }),
    );
    expect(items.map((i) => [i.kind, i.href])).toEqual([
      ["validation", "/approve/7"],
      ["question", "/approve/8"],
      ["coordinator", "/projects/widgets"],
    ]);
    expect(items.map((i) => i.key)).toEqual([
      "validation:widgets:7",
      "validation:widgets:8",
      "coordinator:widgets:2026-03-04T08:00:00Z",
    ]);
    const bounced = ownerItems(
      overview({
        projects: [project("widgets", "idle", "2026-03-04T10:00:00Z")],
        waiting: [workerItem("question", "WID-2", "2026-03-04T11:00:00Z")],
      }),
    );
    expect(bounced[0]?.key).toBe("coordinator:widgets:2026-03-04T10:00:00Z");
    expect(
      ownerItems(
        overview({
          waiting: [workerItem("question", "WID-2"), workerItem("approval", "WID-3"), workerItem("hand-back", "WID-4")],
        }),
      ),
    ).toEqual([]);
    expect(ownerItems(overview({ waiting: [workerItem("question", "WID-2", "2026-03-04T09:00:00Z")] }))).toEqual([]);
  });
});

// Exercise the production overview boundary: late work need not be in flight.
test("alerts on neglected inbox work by owner, with stable keys and merge exclusions", () => {
  const now = new Date("2026-03-04T10:00:00Z");
  const before = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const inbox = (kind: InboxItem["kind"], owner: string | null = "default", minutes = 31): InboxItem => ({
    id: 42,
    project: "widgets",
    ticket: "WID-2",
    kind,
    coordinator: owner,
    recipient: "coordinator",
    author: "Worker",
    body: "Check the work",
    createdAt: before(minutes),
  });
  const active = {
    name: "default",
    seenAt: before(1),
    cliVersion: null,
    harness: null,
    startedAt: before(60),
    inboxSeenAt: null,
    model: null,
    handle: null,
  };
  const stopped = { ...active, name: "back", seenAt: before(40) };
  const reading = (
    items: InboxItem[],
    coordinators = [active],
    extra: Partial<NonNullable<ProjectReading["live"]>> = {},
  ): ProjectReading => ({
    slug: "widgets",
    name: "Widgets",
    repository: "acme/widgets",
    error: null,
    report: {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      project: { name: "Widgets", slug: "widgets", repository: "acme/widgets" },
      programRoot: { id: "WID-1", title: "Widgets", url: "https://example.test" },
      sources: { linear: { fetchedAt: now.toISOString() }, github: { fetchedAt: null, error: null } },
      silentAfterMinutes: 15,
      coordinatorMinutes: 10,
      inFlight: [],
      notStarted: [],
      frontier: [],
      pullRequests: [],
      warnings: [],
    },
    live: { inbox: items, coordinatorSeenAt: coordinators[0]?.seenAt ?? null, coordinators, ...extra },
  });
  const fleet = (p: ProjectReading) => buildOverview({ projects: [p], live: { state: "ok", error: null }, now });
  const plan = fleet(reading([inbox("plan")]));
  expect(ownerItems(plan)).toEqual([
    {
      key: "unattended:widgets:42",
      kind: "unattended",
      project: "widgets",
      ticket: "WID-2",
      title: "WID-2 — plan to approve, waiting 31 min for the coordinator",
      href: "/agents/WID-2",
      waiting: 0,
      reason: "plan to approve",
      minutes: 31,
      workTitle: "WID-2",
    },
  ]);
  expect(ownerItems({ ...plan, generatedAt: new Date(now.getTime() + 60_000).toISOString() })[0]?.key).toBe(
    "unattended:widgets:42",
  );
  expect(ownerItems(fleet(reading([])))).toEqual([]);
  expect(ownerItems({ ...plan, live: { state: "unreachable", error: "offline" } })).toEqual([]);
  for (const kind of [
    "question",
    "hand-back",
    "decision",
    "answer-request",
    "launch-request",
    "merge-request",
    "release-request",
    "plan-changes",
  ] as const) {
    expect(ownerItems(fleet(reading([inbox(kind)])))[0]?.key).toBe("unattended:widgets:42");
    expect(ownerItems(fleet(reading([inbox(kind, "default", 30)])))).toEqual([]);
  }
  const tuned = reading([inbox("plan")]);
  if (tuned.report) tuned.report.coordinatorMinutes = 20;
  expect(ownerItems(fleet(tuned))).toEqual([]);
  for (const kind of ["hand-back", "merge-request"] as const) {
    const queued = {
      id: 1,
      project: "widgets",
      pr: 7,
      ticket: "WID-2",
      headSha: "head",
      attempts: 0,
      mergeCommit: null,
      finishedAt: null,
      noTicket: false,
      keepOpen: false,
      throughHold: null,
      reason: null,
      state: "queued",
      detail: null,
      queuedBy: "Coordinator",
      queuedAt: before(5),
      updatedAt: before(5),
      notBefore: null,
    } satisfies QueueEntry;
    if (kind === "merge-request") {
      const mergeRequest = { ...inbox(kind), request: { question: null, profile: null, pr: 7 } };
      expect(ownerItems(fleet(reading([mergeRequest], [active], { queue: [queued] })))).toEqual([]);
      expect(
        ownerItems(
          fleet(
            reading([{ ...mergeRequest, request: { ...mergeRequest.request, pr: 8 } }], [active], { queue: [queued] }),
          ),
        )[0]?.kind,
      ).toBe("unattended");
    }
    for (const state of ["queued", "merging"] as const)
      expect(ownerItems(fleet(reading([inbox(kind)], [active], { queue: [{ ...queued, state }] })))).toEqual([]);
    expect(
      ownerItems(fleet(reading([inbox(kind)], [active], { queue: [{ ...queued, state: "refused" }] })))[0]?.kind,
    ).toBe("unattended");
    expect(
      ownerItems(
        fleet(
          reading([inbox(kind)], [active], {
            holds: [
              {
                id: 1,
                project: "widgets",
                kind: "manual",
                ref: null,
                reason: "Check the deploy",
                openedBy: "Owner",
                openedAt: before(5),
                clearedAt: null,
                clearedBy: null,
                clearReason: null,
              },
            ],
          }),
        ),
      ),
    ).toEqual([]);
  }
  const named = fleet(reading([inbox("launch-request", "back", 11)], [active, stopped]));
  expect(named.projects[0]?.coordinators?.find((c) => c.name === "back")).toMatchObject({
    late: 1,
    lateSince: before(11),
  });
  expect(ownerItems(named)).toMatchObject([
    { key: `coordinator:widgets:back:${before(40)}`, kind: "coordinator", title: "Widgets · back", waiting: 1 },
  ]);
  const defaultStopped = { ...active, seenAt: before(40) };
  expect(ownerItems(fleet(reading([inbox("launch-request", "default", 11)], [defaultStopped])))[0]?.key).toBe(
    `coordinator:widgets:${before(40)}`,
  );
  const unowned = inbox("deploy", null, 11);
  expect(ownerItems(fleet(reading([unowned], [active, stopped])))).toEqual([]);
  expect(ownerItems(fleet(reading([unowned], [defaultStopped])))).toMatchObject([
    { key: `coordinator:widgets:${before(40)}`, waiting: 1 },
  ]);
  expect(ownerItems(fleet(reading([inbox("plan", null)], [active, stopped])))[0]?.kind).toBe("unattended");
  expect(ownerItems(fleet(reading([inbox("plan", "back")], [active, stopped])))[0]?.kind).toBe("coordinator");
  expect(ownerItems(fleet(reading([{ ...inbox("plan"), recipient: "worker" }])))).toEqual([]);
  expect(ownerItems(fleet(reading([inbox("note")])))).toEqual([]);
  const title = reading([inbox("plan")]);
  if (title.report)
    title.report.inFlight = [
      {
        id: "WID-2",
        title: "Improve the widget",
        url: "https://example.test/WID-2",
        spec: null,
        phaseSource: "label",
        runtime: null,
        handle: null,
        profile: null,
        agent: null,
        statusLine: null,
        pr: null,
        phase: "implementing",
        since: before(60),
        lastUpdate: before(1),
        lastReport: before(1),
        silent: false,
        flags: [],
        openBlockers: [],
      } satisfies InFlightTicket,
    ];
  expect(ownerItems(fleet(title))[0]?.title).toBe(
    "WID-2 · Improve the widget — plan to approve, waiting 31 min for the coordinator",
  );
  expect(ownerItems(fleet(reading([{ ...inbox("launch-request", null), ticket: null }])))[0]?.href).toBe(
    "/projects/widgets",
  );
  expect(ownerItems(fleet(reading([inbox("question"), { ...unowned, id: 43 }], [defaultStopped])))).toMatchObject([
    { key: `coordinator:widgets:${before(40)}`, waiting: 2 },
  ]);
});

test("channel milestones select recent completed specs and durable pauses, clearing only recorded pauses", () => {
  const now = new Date("2026-04-06T12:00:00Z");
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
  const spec = issue("WID-10", {
    title: "Spec 2/10 — Search",
    parentId: "WID-1",
    statusType: "completed",
    completedAt: at(-10),
    url: "https://linear.example.test/WID-10",
  });
  const hold: MergeHold = {
    id: 7,
    project: "widgets",
    kind: "manual",
    ref: null,
    reason: "Check production\nDetails",
    openedBy: "Ada",
    openedAt: at(-5),
    clearedAt: null,
    clearedBy: null,
    clearReason: null,
  };
  const input = {
    project: "widgets",
    root: "WID-1",
    issues: [spec],
    holds: [hold],
    now,
    since: at(-60),
    announced: new Set<string>(),
  };
  expect(ownerMilestones(input)).toMatchObject([
    { key: "spec:widgets:WID-10", kind: "spec-closed", title: "Spec 2 · Search", href: spec.url },
    {
      key: "hold:widgets:7",
      kind: "hold-opened",
      title: "widgets",
      reason: "Check production",
      href: "/projects/widgets",
    },
  ]);
  for (const change of [
    { parentId: "WID-9" },
    { title: "Search" },
    { statusType: "started" as const },
    { statusType: "canceled" as const },
    { completedAt: null },
    { completedAt: at(-61) },
    { completedAt: at(1) },
  ])
    expect(ownerMilestones({ ...input, issues: [{ ...spec, ...change }], holds: [] })).toEqual([]);
  expect(ownerMilestones({ ...input, holds: [], since: at(-9) })).toEqual([]);
  expect(ownerMilestones({ ...input, holds: [], now: new Date(at(10)) })[0]?.key).toBe("spec:widgets:WID-10");
  expect(ownerMilestones({ ...input, issues: [], since: at(-4) })).toEqual([]);
  for (const kind of ["manual", "deploy", "main-red"] as const) {
    const pause = { ...hold, kind };
    expect(ownerMilestones({ ...input, issues: [], holds: [pause] })[0]?.key).toBe("hold:widgets:7");
    expect(ownerMilestones({ ...input, issues: [], holds: [{ ...pause, openedAt: at(-4) }] })).toEqual([]);
    expect(ownerMilestones({ ...input, issues: [], holds: [{ ...pause, clearedAt: at(-1) }] })).toEqual([]);
  }
  const cleared = { ...hold, openedAt: at(-1500), clearedAt: at(-1) };
  const announced = new Set(["hold:widgets:7"]);
  expect(ownerMilestones({ ...input, issues: [], holds: [cleared], announced })).toMatchObject([
    { key: "hold-cleared:widgets:7", kind: "hold-cleared", href: "/projects/widgets" },
  ]);
  expect(ownerMilestones({ ...input, issues: [], holds: [{ ...cleared, clearedAt: at(-61) }], announced })).toEqual([]);
  expect(ownerMilestones({ ...input, issues: [], holds: [{ ...cleared, project: "other" }], announced })).toEqual([]);
});
