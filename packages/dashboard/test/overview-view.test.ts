import { describe, expect, test } from "bun:test";
import type {
  FleetOverview,
  FleetRow,
  InboxItem,
  OwnerValidation,
  ProjectOverview,
  ReadyTicket,
  WaitingItem,
} from "@armada/core/read";
import {
  coordinatorAlerts,
  decisionCards,
  excerpt,
  handBackPr,
  orderOptions,
  pendingValidations,
  sentRequest,
  splitValidations,
} from "../lib/overview-view.ts";

// A synthetic fleet: two projects, every state the overview shows.
const at = (minutesAgo: number) => new Date(Date.parse("2026-10-01T12:00:00Z") - minutesAgo * 60_000).toISOString();

const pr = (number: number, ci: "success" | "failure" | "pending", mergeable = "MERGEABLE") => ({
  number,
  url: `https://github.com/acme/widgets/pull/${number}`,
  title: "x",
  draft: false,
  ci,
  mergeable,
});

const row = (id: string, over: Partial<FleetRow> = {}): FleetRow =>
  ({
    id,
    title: `Title of ${id}`,
    url: `https://linear.app/acme/issue/${id}`,
    project: "widgets",
    phase: "implementing",
    runtime: "Conductor",
    pr: null,
    silent: false,
    question: null,
    flags: [],
    since: at(30),
    lastUpdate: at(5),
    lastReport: at(5),
    statusLine: null,
    ...over,
  }) as FleetRow;

const wait = (kind: WaitingItem["kind"], ticket: string, minutesAgo: number, over: Partial<WaitingItem> = {}) =>
  ({
    kind,
    project: "widgets",
    ticket,
    title: `Title of ${ticket}`,
    url: null,
    detail: null,
    author: null,
    since: at(minutesAgo),
    item: null,
    answer: null,
    coordinatorSince: null,
    ...over,
  }) as WaitingItem;

const project = (slug: string, over: Partial<ProjectOverview> = {}): ProjectOverview =>
  ({
    slug,
    name: slug,
    repository: `acme/${slug}`,
    progress: { done: 7, total: 12 },
    health: "watch",
    pullRequests: [],
    requests: [],
    coordinator: {
      state: "active",
      seenAt: at(2),
      cliVersion: null,
      updateAvailable: false,
    },
    ...over,
  }) as ProjectOverview;

const rows = [
  row("WID-1", { question: { id: 1, body: "?", at: at(12), author: null, answer: null } }),
  row("WID-2", { phase: "awaiting-approval" }),
  row("WID-3", { phase: "shipping", pr: { ...pr(41, "failure"), failingChecks: ["test"] } }),
  row("WID-4", { phase: "shipping", pr: pr(12, "pending", "CONFLICTING"), since: at(25) }),
  row("WID-5", { silent: true, lastReport: at(42), runtime: "Claude Code" }),
  row("WID-6", { phase: "ready-to-merge", pr: pr(44, "success") }),
  row("GAD-1", { project: "gadgets", runtime: "Codex", lastReport: at(1) }),
];

const overview = {
  rows,
  waiting: [
    wait("question", "WID-1", 12, { item: 1 }),
    wait("approval", "WID-2", 18, { item: 2 }),
    wait("hand-back", "WID-6", 6),
    wait("silent", "WID-5", 42),
    wait("not-started", "GAD-9", 20, { project: "gadgets", detail: "launched, never claimed" }),
  ],
  projects: [
    project("widgets", {
      pullRequests: [
        { ...pr(41, "failure"), failingChecks: ["Lint, typecheck and test"], ticket: { id: "WID-3", phase: null } },
        { ...pr(44, "success"), failingChecks: [], ticket: { id: "WID-6", phase: null } },
        { ...pr(50, "success"), failingChecks: [], ticket: { id: "WID-7", phase: null } },
      ] as ProjectOverview["pullRequests"],
    }),
    project("gadgets", {
      pullRequests: null,
      progress: { done: 0, total: 0 },
      coordinator: {
        state: "idle",
        seenAt: at(30),
        cliVersion: null,
        updateAvailable: false,
      },
    }),
  ],
  ready: [
    { id: "WID-20", project: "widgets", readyForAgent: true, launch: null },
    { id: "WID-21", project: "widgets", readyForAgent: false, launch: null },
    {
      id: "WID-22",
      project: "widgets",
      readyForAgent: false,
      launch: { id: 9, author: null, at: at(1), profile: null },
    },
  ] as ReadyTicket[],
} satisfies Pick<FleetOverview, "rows" | "waiting" | "projects" | "ready">;

/** What the owner validates (THE-885): open unless `decided` minutes ago. */
const validation = (id: number, ticket: string, minutesAgo: number, decided?: number): OwnerValidation => ({
  id,
  project: "widgets",
  ticket,
  kind: "merge",
  what: `Merge ${ticket}`,
  reason: "touches the front end",
  choices: null,
  pr: null,
  attachments: [],
  author: "coordinator",
  createdAt: at(minutesAgo),
  decision:
    decided === undefined ? null : { outcome: "approved", answer: null, note: null, by: "Ada", at: at(decided) },
  title: null,
  url: null,
  gallery: [],
});

describe("yours to decide (THE-885)", () => {
  test("holds only what the owner validates; the workers' questions, plans and hand-backs stay with the coordinator", () => {
    const validations = [validation(3, "WID-2", 30, 20), validation(1, "WID-6", 4), validation(2, "WID-1", 9)];
    expect(pendingValidations({ validations }).map((v) => v.id)).toEqual([1, 2]);
    // An overview from before validations has none.
    expect(pendingValidations({})).toEqual([]);
  });

  test("the Validations page lists what waits oldest first, then what was decided newest first (THE-1021)", () => {
    const decided = (id: number, ticket: string, minutes: number) => ({
      ...validation(id, ticket, minutes + 5),
      decision: { outcome: "approved" as const, answer: null, note: null, by: "Ada", at: at(minutes) },
    });
    const { pending, decided: done } = splitValidations([
      validation(1, "WID-6", 4),
      decided(4, "WID-9", 50),
      validation(2, "WID-1", 9),
      decided(5, "WID-3", 10),
    ]);
    expect(pending.map((v) => v.id)).toEqual([2, 1]);
    expect(done.map((v) => v.id)).toEqual([5, 4]);
  });
});

describe("decisions", () => {
  test("are the questions, plans and hand-backs, oldest first", () => {
    expect(decisionCards(overview).map((d) => d.ticket)).toEqual(["WID-2", "WID-1", "WID-6"]);
  });

  test("show the recommended option first, else the worker's order", () => {
    expect(orderOptions(["30 minutes", "15 minutes (recommended)", "1 hour"])).toEqual([
      "15 minutes (recommended)",
      "30 minutes",
      "1 hour",
    ]);
    expect(orderOptions(["Garder", "Retirer (recommandé)"])).toEqual(["Retirer (recommandé)", "Garder"]);
    expect(orderOptions(["a", "b"])).toEqual(["a", "b"]);
  });

  test("a hand-back merges its row's pull request, else the project's open one for the ticket", () => {
    expect(handBackPr(overview, wait("hand-back", "WID-6", 1))).toBe(44);
    expect(handBackPr(overview, wait("hand-back", "WID-7", 1))).toBe(50);
    expect(handBackPr(overview, wait("hand-back", "WID-8", 1))).toBeNull();
  });

  test("show what the owner already asked, as the server holds it", () => {
    const request = (kind: InboxItem["kind"], request: InboxItem["request"]): InboxItem => ({
      id: 70,
      project: "widgets",
      ticket: null,
      kind,
      recipient: "coordinator",
      author: "Ada",
      body: "sent",
      createdAt: at(1),
      request,
    });
    const asked = {
      projects: [
        project("widgets", {
          requests: [
            request("plan-changes", { question: 2, profile: null }),
            request("merge-request", { question: null, profile: null, pr: 44 }),
          ],
        }),
      ],
    };
    const answered = wait("question", "WID-1", 1, { answer: { id: 3, body: "15 minutes", author: "Ada", at: at(1) } });
    expect(sentRequest(asked, answered, null)?.body).toBe("15 minutes");
    expect(sentRequest(asked, wait("approval", "WID-2", 1, { item: 2 }), null)?.author).toBe("Ada");
    expect(sentRequest(asked, wait("approval", "WID-9", 1, { item: 3 }), null)).toBeNull();
    expect(sentRequest(asked, wait("hand-back", "WID-6", 1), 44)?.body).toBe("sent");
    expect(sentRequest(asked, wait("hand-back", "WID-7", 1), 50)).toBeNull();
  });

  test("a long plan is cut on a word", () => {
    expect(excerpt("Parse  the sheet,\nthen import", 100)).toBe("Parse the sheet, then import");
    expect(excerpt("Parse the sheet, validate every row", 20)).toBe("Parse the sheet,…");
  });
});

describe("a coordinator to bring back", () => {
  test("is one card per project whose coordinator is not active while items wait for it", () => {
    const { coordinator } = project("widgets");
    const late = (ticket: string, since: string | null) => wait("question", ticket, 1, { coordinatorSince: since });
    const o = {
      projects: [
        project("widgets", { coordinator: { ...coordinator, state: "idle", seenAt: at(40) } }),
        project("gadgets", { coordinator: { ...coordinator, state: "unknown", seenAt: null } }),
        project("gizmos", { coordinator: { ...coordinator, state: "active", seenAt: at(1) } }),
      ],
      waiting: [
        { ...late("WID-1", at(25)), project: "widgets" },
        { ...late("WID-2", at(35)), project: "widgets" },
        { ...late("WID-3", null), project: "widgets" },
        { ...late("GAD-1", null), project: "gadgets" },
        { ...late("GIZ-1", at(50)), project: "gizmos" },
      ],
    };
    expect(coordinatorAlerts(o)).toEqual([
      { project: "widgets", state: "idle", seenAt: at(40), waiting: 2, since: at(35) },
    ]);
  });
});
