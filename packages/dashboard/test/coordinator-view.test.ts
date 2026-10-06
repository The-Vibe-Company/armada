import { describe, expect, test } from "bun:test";
import type { FleetRow, MergedTicket, OwnerValidation, ProjectOverview } from "@armada/core/read";
import {
  checksOf,
  groupItems,
  mergedToday,
  overviewHeadline,
  overviewHref,
  overviewItems,
  ownerChecks,
  parseOverviewView,
  projectSummaries,
  sessionState,
  sessionStep,
} from "../lib/coordinator-view.ts";
import { demoOverview } from "../lib/demo/overview.ts";

// The overview's states (THE-1020): synthetic fleet, invented tickets and people.

const at = (m: number) => new Date(Date.UTC(2026, 9, 2, 12, m)).toISOString();
const NOW = Date.UTC(2026, 9, 2, 13, 0);
const row = (id: string, over: Partial<FleetRow> = {}) =>
  ({
    id,
    title: `Ticket ${id}`,
    project: "widgets",
    phase: "implementing",
    step: "implementing",
    pr: null,
    silent: false,
    question: null,
    flags: [],
    lastReport: at(50),
    statusLine: null,
    session: null,
    ...over,
  }) as FleetRow;
const pr = (number: number, over: Partial<NonNullable<FleetRow["pr"]>> = {}) =>
  ({
    number,
    url: `https://example.test/pull/${number}`,
    ci: "pending",
    mergeable: "MERGEABLE",
    ...over,
  }) as FleetRow["pr"];
const merged = (id: string, minutesAgo: number, number: number): MergedTicket =>
  ({
    id,
    title: `Ticket ${id}`,
    mergedAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
    pr: { number, url: `https://example.test/pull/${number}` },
  }) as MergedTicket;
const project = (slug: string, over: Partial<ProjectOverview> = {}) =>
  ({ slug, name: slug, merged: [], coordinator: { state: "active" }, ...over }) as ProjectOverview;
const validation = (id: number, ticket: string, over: Partial<OwnerValidation> = {}) =>
  ({
    id,
    project: "widgets",
    ticket,
    kind: "validation",
    what: "Two directions for the card\nPick one",
    createdAt: at(id),
    decision: null,
    pr: null,
    ...over,
  }) as OwnerValidation;

const state = (r: FleetRow, checks: OwnerValidation[] = [], decided: OwnerValidation[] = []) =>
  sessionState(r, checks, decided);

describe("the owner's checks", () => {
  test("are the open validations of a session, oldest first; a decided one, another ticket's or project's are not", () => {
    const validations = [
      validation(5, "WID-1"),
      validation(1, "WID-1", { kind: "merge" }),
      validation(3, "WID-3", {
        decision: { outcome: "approved", by: "Ada", at: at(9) } as OwnerValidation["decision"],
      }),
      validation(4, "WID-1", { project: "gadgets" }),
    ];
    const checks = ownerChecks({ validations });
    expect(checksOf(checks, row("WID-1")).map((v) => v.id)).toEqual([1, 5]);
    expect(checksOf(checks, row("WID-3"))).toEqual([]);
    expect(checksOf(checks, row("WID-1", { project: "gadgets" })).map((v) => v.id)).toEqual([4]);
    expect(checksOf(ownerChecks({}), row("WID-1"))).toEqual([]);
  });
});

describe("a session's state", () => {
  test("waits for the owner on an open validation, whatever else holds it, with the validation's words", () => {
    expect(state(row("A", { question: { body: "?" } as FleetRow["question"] }), [validation(1, "A")])).toEqual({
      group: "you",
      reason: { kind: "validation", text: "Two directions for the card" },
    });
    expect(state(row("A", { pr: pr(44, { ci: "success" }) }), [validation(1, "A", { kind: "merge" })])).toEqual({
      group: "you",
      reason: { kind: "merge", pr: 44, ci: "success" },
    });
    expect(state(row("A"), [validation(1, "A", { kind: "question", what: "Behind a flag first?" })]).reason).toEqual({
      kind: "owner-question",
      text: "Behind a flag first?",
    });
  });

  test("waits for the owner on a plan to approve", () => {
    expect(state(row("A", { phase: "awaiting-approval" }))).toEqual({ group: "you", reason: { kind: "plan" } });
  });

  test("is blocked on an unanswered question, red CI, a conflict, a blocked phase or a silence, in that order", () => {
    const question = { body: "How long does a link stay valid?\n\nOptions:\n1. 15 minutes\n2. 30 minutes" };
    expect(state(row("A", { phase: "blocked", question } as Partial<FleetRow>)).reason).toEqual({
      kind: "question",
      text: "How long does a link stay valid?",
    });
    expect(state(row("A", { pr: pr(41, { ci: "failure" }), silent: true })).reason).toEqual({ kind: "ci", pr: 41 });
    expect(state(row("A", { pr: pr(12, { ci: "none", mergeable: "CONFLICTING" }) })).reason).toEqual({
      kind: "conflict",
      pr: 12,
    });
    expect(
      state(row("A", { phase: "blocked", statusLine: { summary: "Waiting on a key" } } as Partial<FleetRow>)),
    ).toEqual({ group: "blocked", reason: { kind: "blocked", text: "Waiting on a key" } });
    expect(state(row("A", { silent: true }))).toEqual({ group: "blocked", reason: { kind: "silent", since: at(50) } });
  });

  test("is ready to merge once handed back, with who approved its merge", () => {
    const r = row("A", { phase: "ready-to-merge", pr: pr(317, { ci: "success" }) });
    expect(state(r)).toEqual({ group: "ready", reason: { kind: "ready", pr: 317, ci: "success", by: null } });
    const approved = validation(2, "A", {
      kind: "merge",
      decision: { outcome: "approved", by: "Ada Lovelace", at: at(20) } as OwnerValidation["decision"],
    });
    expect(state(r, [], [approved]).reason).toMatchObject({ by: "Ada Lovelace" });
  });

  test("runs otherwise, with the worker's last report", () => {
    const r = row("A", {
      session: { lastReport: { message: "Streams the rows" } } as FleetRow["session"],
      statusLine: { summary: "older" } as FleetRow["statusLine"],
    });
    expect(state(r)).toEqual({ group: "running", reason: { kind: "working", text: "Streams the rows" } });
  });
});

describe("a session's step", () => {
  test("follows its phase, then its flow step (review and CI are one step)", () => {
    expect(sessionStep(row("A", { phase: "planning", step: "plan" }))).toBe(0);
    expect(sessionStep(row("A", { phase: "awaiting-approval", step: "plan" }))).toBe(1);
    expect(sessionStep(row("A", { phase: "blocked", step: "implementing" }))).toBe(2);
    expect(sessionStep(row("A", { phase: "shipping", step: "review" }))).toBe(3);
    expect(sessionStep(row("A", { phase: "shipping", step: "ci" }))).toBe(3);
    expect(sessionStep(row("A", { phase: "ready-to-merge", step: "ci" }))).toBe(4);
    expect(sessionStep(row("A", { phase: "merged", step: "merged" }))).toBe(6);
  });
});

describe("the overview's lines", () => {
  const projects = [
    project("widgets", { merged: [merged("WID-9", 30, 36), merged("WID-8", 5, 35), merged("WID-1", 2, 30)] }),
    project("gadgets", { merged: [merged("GAD-2", 60 * 20, 10)] }),
  ];
  const rows = [
    row("WID-1", { phase: "merged", step: "merged", pr: pr(30) }),
    row("WID-2", { pr: pr(41, { ci: "failure" }) }),
    row("GAD-1", { project: "gadgets", phase: "awaiting-approval" }),
  ];

  test("add the tickets merged on the viewer's day, newest first, once", () => {
    const items = overviewItems({ rows, projects, validations: [] }, { now: NOW, zone: "UTC" });
    expect(items.map((i) => `${i.id}:${i.group}`)).toEqual([
      "WID-2:blocked",
      "GAD-1:you",
      "WID-8:merged",
      "WID-1:merged",
      "WID-9:merged",
    ]);
    // Twenty hours ago is yesterday in UTC, today in Tokyo (UTC+9).
    expect(mergedToday(projects[1] as ProjectOverview, NOW, "UTC")).toEqual([]);
    expect(mergedToday(projects[1] as ProjectOverview, NOW, "Asia/Tokyo").map((m) => m.id)).toEqual(["GAD-2"]);
  });

  test("group by state in its order, or by project with the most urgent first; empty groups are left out", () => {
    const items = overviewItems({ rows, projects, validations: [] }, { now: NOW, zone: "UTC" });
    expect(groupItems(items, "state", projects).map((g) => `${g.key}:${g.items.length}`)).toEqual([
      "blocked:1",
      "you:1",
      "merged:3",
    ]);
    expect(groupItems(items, "project", projects).map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ["widgets", ["WID-2", "WID-8", "WID-1", "WID-9"]],
      ["gadgets", ["GAD-1"]],
    ]);
  });

  test("count each project's sessions and the headline's figures", () => {
    const items = overviewItems({ rows, projects, validations: [] }, { now: NOW, zone: "UTC" });
    expect(projectSummaries(projects, items).map((p) => [p.project.slug, p.blocked, p.you, p.running, p.live])).toEqual(
      [
        ["widgets", 1, 0, 0, 1],
        ["gadgets", 0, 1, 0, 1],
      ],
    );
    expect(overviewHeadline(items, 2)).toMatchObject({ blocked: 1, you: 1, running: 0, merged: 3, live: 2 });
  });
});

describe("the demo world", () => {
  test("shows every state of the design, with the design's sessions in each", () => {
    const o = demoOverview(new Date("2026-10-01T13:42:00Z"));
    const items = overviewItems(o, { now: Date.parse(o.generatedAt), zone: "UTC" });
    const of = (g: string) =>
      items
        .filter((i) => i.group === g)
        .map((i) => i.id)
        .sort();
    expect(of("blocked")).toEqual(["GAD-5", "WID-14", "WID-15", "WID-17"]);
    expect(of("you")).toEqual(["GAD-3", "GAD-9", "THE-862", "WID-18"]);
    expect(of("running")).toEqual(["GAD-6", "WID-12"]);
    expect(of("ready")).toEqual(["THE-858"]);
    expect(of("merged").length).toBeGreaterThan(0);
    const reason = (id: string) => items.find((i) => i.id === id)?.reason.kind;
    expect([reason("WID-15"), reason("WID-14"), reason("GAD-5"), reason("WID-17")]).toEqual([
      "question",
      "ci",
      "conflict",
      "silent",
    ]);
    expect([reason("GAD-3"), reason("GAD-9"), reason("WID-18"), reason("THE-862")]).toEqual([
      "plan",
      "validation",
      "merge",
      "owner-question",
    ]);
  });
});

describe("the overview's address", () => {
  test("reads the project, the grouping, the view and the selection, and ignores the rest", () => {
    const v = parseOverviewView(new URLSearchParams("coordinator=widgets&group=project&view=preview&ticket=WID-15"));
    expect(v).toEqual({ project: "widgets", group: "project", view: "preview", ticket: "WID-15" });
    expect(overviewHref(v)).toBe("/?coordinator=widgets&group=project&view=preview&ticket=WID-15");
    // Links from before: the harness tabs, the state and sort filters land on the overview, unfiltered.
    const old = parseOverviewView(new URLSearchParams("harness=codex&state=error&sort=age&project=gadgets"));
    expect(old).toEqual({ project: "gadgets", group: "state", view: "list", ticket: null });
    expect(overviewHref({ ...old, project: null, ticket: "WID-1" })).toBe("/");
  });
});

test("runtime failures and archived workspaces have distinct overview reasons", () => {
  for (const runtimeState of ["failed", "gone"] as const)
    expect(state(row("WID-7", { runtimeState }))).toEqual({
      group: "blocked",
      reason: { kind: "runtime", state: runtimeState },
    });
});

test("stopped idle sessions are actionable even when their answered phase still says awaiting approval", () => {
  expect(state(row("WID-1", { phase: "implementing", flags: ["stopped"] }))).toEqual({
    group: "blocked",
    reason: { kind: "stopped" },
  });
  expect(state(row("WID-1", { phase: "awaiting-approval", flags: ["stopped"] }))).toEqual({
    group: "blocked",
    reason: { kind: "stopped" },
  });
});
