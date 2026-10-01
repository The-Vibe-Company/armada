import { describe, expect, test } from "bun:test";
import type { FleetOverview, StatusSources } from "@armada/core/read";
import { issue } from "../../core/test/support.ts";
import { STRINGS } from "../lib/i18n.ts";
import {
  flatten,
  indexOfReading,
  pushRecent,
  RECENT_MAX,
  type SearchContext,
  type SearchIndex,
  search,
  searchItems,
  ticketIdOf,
} from "../lib/search.ts";

// ⌘K over everything (THE-895): synthetic fleet, invented tickets and people.

const NOW = new Date("2026-10-01T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 24 * 3_600_000).toISOString();
const ctx: SearchContext = { t: STRINGS.en, lang: "en", density: "compact", organization: false, live: true };

const row = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  title,
  project: "widgets",
  url: `https://linear.app/acme/issue/${id}`,
  phase: "implementing",
  pr: null,
  silent: false,
  question: null,
  flags: [],
  runtime: "Conductor",
  profile: "opus",
  since: ago(2),
  lastUpdate: ago(1),
  lastReport: ago(1),
  session: { branch: `feature/${id.toLowerCase()}-work`, handle: "ws/1", profile: "opus" },
  ...over,
});

const overview = {
  projects: [
    {
      slug: "widgets",
      name: "Widgets",
      repository: "acme/widgets",
      programRoot: { id: "WID-1", title: "Widgets roadmap", url: "" },
      coordinator: { state: "active", harness: "conductor-cloud", handle: "coord-ws/2" },
      pullRequests: [
        {
          number: 41,
          title: "Sign in with a magic link",
          url: "https://github.com/acme/widgets/pull/41",
          branch: "feature/wid-15-magic-link",
          ticket: { id: "WID-15", phase: "shipping" },
          updatedAt: ago(0.1),
        },
      ],
      profiles: [],
    },
  ],
  rows: [
    row("WID-15", "Sign in with a magic link"),
    row("WID-16", "Export the invoices as CSV", { lastReport: ago(3) }),
  ],
  ready: [
    {
      id: "WID-150",
      title: "Let users change their email address",
      project: "widgets",
      readyForAgent: true,
      launch: null,
      route: { profile: "sonnet", why: "" },
      labels: ["api"],
    },
    {
      id: "WID-151",
      title: "Draft the pricing page",
      project: "widgets",
      readyForAgent: true,
      launch: null,
      route: null,
      labels: [],
    },
  ],
  waiting: [
    {
      kind: "question",
      project: "widgets",
      ticket: "WID-16",
      title: "Export the invoices as CSV",
      since: ago(0.5),
      item: 7,
      answer: null,
    },
    {
      kind: "approval",
      project: "widgets",
      ticket: "WID-15",
      title: "Sign in with a magic link",
      since: ago(0.2),
      item: 9,
      answer: null,
    },
  ],
  validations: [
    {
      id: 3,
      project: "widgets",
      ticket: "WID-15",
      what: "Check the sign-in email",
      reason: null,
      title: "Sign in with a magic link",
      decision: null,
      createdAt: ago(0.3),
      gallery: [{ caption: "The email on a phone" }],
    },
  ],
} as unknown as Pick<FleetOverview, "rows" | "projects" | "ready" | "waiting" | "validations">;

const index: SearchIndex = {
  tickets: [
    {
      project: "widgets",
      id: "WID-7",
      title: "Ship the onboarding checklist",
      url: "https://linear.app/acme/issue/WID-7",
      status: "Done",
      statusType: "completed",
      updatedAt: ago(5),
      branch: "feature/wid-7-onboarding",
    },
    {
      project: "widgets",
      id: "WID-15",
      title: "Sign in with a magic link",
      url: "",
      status: "In Progress",
      statusType: "started",
      updatedAt: ago(1),
      branch: null,
    },
    {
      project: "widgets",
      id: "WID-30",
      title: "Onboarding emails",
      url: "https://linear.app/acme/issue/WID-30",
      status: "Todo",
      statusType: "unstarted",
      updatedAt: ago(2),
      branch: null,
    },
  ],
  prs: [
    {
      project: "widgets",
      number: 41,
      title: "Sign in with a magic link",
      url: "",
      branch: "feature/wid-15-magic-link",
      state: "open",
      ticket: "WID-15",
      updatedAt: ago(0.1),
    },
    {
      project: "widgets",
      number: 12,
      title: "Onboarding checklist",
      url: "https://github.com/acme/widgets/pull/12",
      branch: "feature/wid-7-onboarding",
      state: "merged",
      ticket: "WID-7",
      updatedAt: ago(5),
    },
  ],
  attachments: [
    {
      project: "widgets",
      id: "att-1",
      ticket: "WID-15",
      caption: "Magic link email in dark mode",
      kind: "image",
      url: null,
      createdAt: ago(1),
    },
  ],
};

const items = searchItems(overview, index, ctx);
const top = (q: string, recent: string[] = []) => flatten(search(items, q, { recent }))[0];
const keys = (q: string) => flatten(search(items, q)).map((i) => i.key);

describe("⌘K's index", () => {
  test("reaches agents, tickets (done ones too), pull requests, validations, projects, captions, actions and pages", () => {
    const kinds = new Set(items.map((i) => i.kind));
    expect([...kinds].sort()).toEqual([
      "action",
      "agent",
      "attachment",
      "page",
      "pr",
      "project",
      "ticket",
      "validation",
    ]);
    // A ticket in flight is its agent, once; the index's copy is left out.
    expect(items.filter((i) => i.id === "wid-15").map((i) => i.kind)).toEqual(["agent"]);
    // Pull request #41 comes from the overview and the index: once, opening its agent's files.
    expect(items.filter((i) => i.key === "pr:widgets:41").map((i) => i.href)).toEqual(["/agents/WID-15?tab=files"]);
  });

  test("a project's reading gives every ticket but those done over 30 days ago or canceled, and its pull requests' tickets", () => {
    const sources = {
      program: {
        rootId: "WID-1",
        fetchedAt: NOW.toISOString(),
        issues: [
          issue("WID-1"),
          issue("WID-2", {
            statusType: "completed",
            completedAt: ago(10),
            prs: [{ number: 5, url: "", repo: "acme/widgets", title: "x" }],
          }),
          issue("WID-3", { statusType: "completed", completedAt: ago(40) }),
          issue("WID-4", { statusType: "canceled", canceledAt: ago(1) }),
          issue("WID-5", { statusType: "started" }),
        ],
        comments: [],
        warnings: [],
      },
      forge: {
        repo: "acme/widgets",
        fetchedAt: NOW.toISOString(),
        prs: [
          { number: 5, url: "", repo: "acme/widgets", title: "Two", headRef: "feature/wid-2-two", state: "merged" },
          { number: 6, url: "", repo: "acme/widgets", title: "Five", headRef: "feature/wid-5-five", state: "open" },
          { number: 8, url: "", repo: "acme/widgets", title: "Chore", headRef: "chore/deps", state: "open" },
        ],
        warnings: [],
      },
    } as unknown as StatusSources;
    const part = indexOfReading("widgets", sources, NOW);
    expect(part.tickets.map((t) => t.id)).toEqual(["WID-1", "WID-2", "WID-5"]);
    expect(part.tickets.find((t) => t.id === "WID-2")?.branch).toBe("feature/wid-2-two");
    // Linked on the ticket, named in the branch, or neither.
    expect(part.prs.map((p) => [p.number, p.ticket, p.state])).toEqual([
      [5, "WID-2", "merged"],
      [6, "WID-5", "open"],
      [8, null, "open"],
    ]);
  });
});

describe("⌘K's ranking", () => {
  test("a ticket id typed whole is the first result, whatever its case, kind or spacing", () => {
    expect(ticketIdOf(" wid-15 ")).toBe("WID-15");
    expect(ticketIdOf("wid 15")).toBeNull();
    expect(top("wid-15")?.key).toBe("agent:widgets:WID-15");
    // Not WID-15 (a prefix of WID-150 is not WID-150).
    expect(top("WID-150")?.key).toBe("ticket:widgets:WID-150");
    // A done ticket opens on Linear.
    expect(top("wid-7")).toMatchObject({
      key: "ticket:widgets:WID-7",
      href: "https://linear.app/acme/issue/WID-7",
      external: true,
    });
  });

  test("a pull request by its number, with or without #, and by its branch", () => {
    expect(top("#12")?.key).toBe("pr:widgets:12");
    expect(top("12")?.key).toBe("pr:widgets:12");
    expect(keys("wid-15-magic").slice(0, 1)).toEqual(["pr:widgets:41"]);
  });

  test("an id or name starting with the query beats a word, a word beats a substring, a substring beats letters in order", () => {
    // "export": WID-16's title starts with it.
    expect(top("export")?.key).toBe("agent:widgets:WID-16");
    // "onboarding": WID-30's title starts with it (open), WID-7's has it as a word (done, and lower).
    const onboarding = keys("onboarding");
    expect(onboarding.indexOf("ticket:widgets:WID-30")).toBeLessThan(onboarding.indexOf("ticket:widgets:WID-7"));
    // Letters in order: "mglnk" finds the magic link.
    expect(keys("mglnk")).toContain("agent:widgets:WID-15");
    expect(keys("zzzz")).toEqual([]);
  });

  test("a caption, a validation's screenshot and a page are found by their words, in both languages", () => {
    expect(top("dark mode")?.key).toBe("attachment:att-1");
    expect(keys("email on a phone")).toContain("validation:widgets:3");
    expect(top("insights")?.href).toBe("/insights");
    const fr = searchItems(overview, index, { ...ctx, t: STRINGS.fr, lang: "fr" });
    expect(flatten(search(fr, "tendances"))[0]?.href).toBe("/insights");
  });

  test("results come grouped, the group of the best match first; near ties go to the recent picks", () => {
    // "sign in" starts the agent's title and its pull request's: the agent wins, and its group leads.
    const groups = search(items, "sign in");
    expect(groups.map((g) => g.key).slice(0, 2)).toEqual(["agent", "pr"]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
    // The pull request answers "sign in" as well as its agent: once picked lately, it comes first.
    expect(top("sign in")?.key).toBe("agent:widgets:WID-15");
    expect(top("sign in", ["pr:widgets:41"])?.key).toBe("pr:widgets:41");
    // A recent pick never beats an id typed whole.
    expect(top("wid-15", ["pr:widgets:41"])?.key).toBe("agent:widgets:WID-15");
  });

  test("without a query: the recent picks, then the oldest decision, launches and settings, then the pages", () => {
    const groups = search(items, "", { recent: ["pr:widgets:12", "gone:key"] });
    expect(groups.map((g) => g.key)).toEqual(["recent", "action", "page"]);
    expect(groups[0]?.items.map((i) => i.key)).toEqual(["pr:widgets:12"]);
    expect(groups[1]?.items[0]?.key).toBe("action:answer");
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(
      pushRecent(
        Array.from({ length: 20 }, (_, k) => `k${k}`),
        "new",
      ),
    ).toHaveLength(RECENT_MAX);
  });
});

describe("⌘K's actions", () => {
  const actions = items.filter((i) => i.kind === "action");
  test("answer the oldest open decision, launch what is ready, open the coordinator, copy a branch, switch language or density", () => {
    expect(actions.find((a) => a.key === "action:answer")?.action).toEqual({
      kind: "answer",
      project: "widgets",
      item: 7,
    });
    expect(actions.find((a) => a.key === "action:launch:widgets:WID-150")?.action).toEqual({
      kind: "launch",
      project: "widgets",
      ticket: "WID-150",
      profile: "sonnet",
    });
    expect(actions.find((a) => a.key === "action:coordinator:widgets")).toMatchObject({
      href: "conductor://workspace?id=coord-ws",
      external: true,
    });
    expect(actions.find((a) => a.key === "action:copy:widgets:WID-15")?.action).toEqual({
      kind: "copy",
      text: "feature/wid-15-work",
    });
    expect(actions.find((a) => a.key === "action:copy:widgets:WID-7")?.action).toEqual({
      kind: "copy",
      text: "feature/wid-7-onboarding",
    });
    expect(
      actions.filter((a) => a.action?.kind === "language" || a.action?.kind === "density").map((a) => a.action),
    ).toEqual([
      { kind: "language", to: "fr" },
      { kind: "density", to: "airy" },
    ]);
  });

  test("no launch or answer while the live data is down: the request could not be written", () => {
    const down = searchItems(overview, index, { ...ctx, live: false });
    expect(down.filter((i) => i.action?.kind === "launch" || i.action?.kind === "answer")).toEqual([]);
  });
});

test("a query over 5 000 items answers well under 50 ms", () => {
  const many = searchItems(
    {
      ...overview,
      rows: Array.from({ length: 300 }, (_, k) => row(`BIG-${k}`, `Session number ${k} on the billing service`)),
    } as unknown as typeof overview,
    {
      tickets: Array.from({ length: 4000 }, (_, k) => ({
        project: "widgets",
        id: `OLD-${k}`,
        title: `Ticket ${k}: refine the ${k % 7 ? "invoice" : "onboarding"} flow for team ${k % 13}`,
        url: "",
        status: "Done",
        statusType: "completed" as const,
        updatedAt: ago(k % 30),
        branch: `feature/old-${k}`,
      })),
      prs: Array.from({ length: 700 }, (_, k) => ({
        project: "widgets",
        number: k + 100,
        title: `Change ${k}`,
        url: "",
        branch: `feature/old-${k}`,
        state: "merged" as const,
        ticket: null,
        updatedAt: ago(k % 30),
      })),
      attachments: [],
    },
    ctx,
  );
  expect(many.length).toBeGreaterThan(5000);
  for (const q of ["o", "onb", "old-12", "refine invoice", "rfnvc"]) search(many, q);
  const runs = ["onboarding", "old-1234", "team 7", "rfn flw", "#512"].map((q) => {
    const start = performance.now();
    search(many, q);
    return performance.now() - start;
  });
  expect(Math.max(...runs)).toBeLessThan(50);
});
