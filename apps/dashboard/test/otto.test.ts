import { expect, test } from "bun:test";
import type { OttoResource } from "@armada/core";
import {
  countLabel,
  MAX_PAGES,
  orphansOfDay,
  ottoTree,
  ownerLook,
  pullRequestUrl,
  readOtto,
  reasonText,
  taskObservedAt,
  unknownLabel,
} from "../src/lib/otto.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const ORG = "11111111-1111-4111-8111-111111111111";
const pr = (number: number, task: number | null, overrides: Partial<OttoResource> = {}): OttoResource => ({
  kind: "pr",
  externalId: String(number),
  taskIssue: task,
  owner: { state: "unknown", userId: null },
  reason: "current_worker_branch_not_observed",
  observedAt: "2026-11-12T11:55:00Z",
  evidence: { title: `PR ${number}`, head: { repo: "example/web", ref: `codex/${task}-x`, sha: "a".repeat(40) } },
  ...overrides,
});

test("an unknown value says when it was last observed, and a missing count is unknown, never zero", () => {
  expect(unknownLabel("2026-11-12T11:55:00Z", NOW)).toBe("Unknown · last observed 5 min ago");
  expect(unknownLabel(null, NOW)).toBe("Unknown · never observed");
  expect(unknownLabel("garbage", NOW)).toBe("Unknown · never observed");
  expect(countLabel(null)).toBe("Unknown");
  expect(countLabel(undefined)).toBe("Unknown");
  expect(countLabel(0)).toBe("0");
});

test("the tree orders tasks by issue and never attaches a resource to a task the list does not hold", () => {
  const tasks = [
    { issueNumber: 20, title: "B", state: "unknown" as const, factId: "f2" },
    { issueNumber: 3, title: "A", state: "open" as const, factId: "f1" },
  ];
  const sandbox: OttoResource = {
    ...pr(0, null),
    kind: "sandbox",
    externalId: "s-1",
    owner: { state: "owned", userId: "me" },
    observedAt: null,
  };
  const { nodes, unlinked } = ottoTree(tasks, [pr(12, 20), pr(4, 3), pr(10, 20), pr(9, 99), sandbox]);
  expect(nodes.map((node) => [node.task.issueNumber, node.resources.map((r) => r.externalId)])).toEqual([
    [3, ["4"]],
    [20, ["10", "12"]],
  ]);
  expect(unlinked.map((r) => r.externalId)).toEqual(["9", "s-1"]);
  // A task's last observation is its newest linked evidence, else the repository listing.
  const [first] = nodes;
  if (!first) throw new Error("missing node");
  expect(taskObservedAt(first, "2026-11-12T10:00:00Z")).toBe("2026-11-12T11:55:00Z");
  expect(taskObservedAt({ task: first.task, resources: [] }, null)).toBeNull();
});

test("ownership reads as the server reports it; an unknown owner carries its observation time", () => {
  expect(ownerLook(pr(1, 1), "me")).toEqual({ tone: "neutral", label: "Owner unknown" });
  expect(ownerLook(pr(1, 1, { owner: { state: "owned", userId: "me" } }), "me").label).toBe("Owned by you");
  expect(ownerLook(pr(1, 1, { owner: { state: "owned", userId: "x" } }), "me").label).toBe("Owned by a member");
  expect(ownerLook(pr(1, 1, { owner: { state: "orphan", userId: null } }), "me")).toEqual({
    tone: "warning",
    label: "Orphan",
  });
  expect(reasonText("something_new")).toBe("Reported reason: something_new");
  const { confirmed, candidates, day } = orphansOfDay([
    { resource: pr(1, 1), state: "unknown", reason: "r", day: "2026-11-12" },
    { resource: pr(2, 2), state: "orphan", reason: "r", day: "2026-11-12" },
  ]);
  expect([confirmed.length, candidates.length, day]).toEqual([1, 1, "2026-11-12"]);
  expect(pullRequestUrl("example/web", pr(17, 17))).toBe("https://github.com/example/web/pull/17");
  expect(pullRequestUrl(null, pr(17, 17))).toBeNull();
  expect(pullRequestUrl("example/web", pr(0, 1, { externalId: "../x" }))).toBeNull();
});

type Reply = { status?: number; body: unknown };
function server(route: (view: string, params: URLSearchParams) => Reply) {
  const calls: string[] = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname.slice("/api/v1/otto/".length)}?${url.searchParams}`);
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
    const reply = route(url.pathname.slice("/api/v1/otto/".length), url.searchParams);
    return Response.json(reply.body, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetcher };
}
const page = (items: unknown[], nextCursor: string | null = null) => ({
  items,
  observedAt: "2026-11-12T11:55:00Z",
  completeness: "unknown",
  githubCompleteness: "partial",
  nextCursor,
});

test("the page reads every view as the member, scoped to the selected organization, following bounded cursors", async () => {
  const { calls, fetcher } = server((view, params) => {
    expect(params.get("org_id")).toBe(ORG);
    if (view === "summary")
      return { body: page([{ openPrCount: null, orphanCount: null, limitations: ["L"], fleetCoverage: "x" }]) };
    if (view === "facts") return { body: page([{ repository: "example/web" }]) };
    if (view === "resources") return { body: params.get("cursor") ? page([pr(2, null)]) : page([pr(1, 1)], "pr:1") };
    if (view === "tasks") return { body: page([{ issueNumber: 1, title: "T", state: "open", factId: "f" }]) };
    // A list that never ends is cut, and said to be cut.
    return { body: page([{ resource: pr(1, 1), state: "unknown", reason: "r", day: "2026-11-12" }], "more") };
  });
  const read = await readOtto({ serverUrl: "https://armada.example/mcp", token: "token", orgId: ORG, fetch: fetcher });
  if (read.state !== "ready") throw new Error(read.state);
  expect(read.snapshot.repository).toBe("example/web");
  expect(read.snapshot.summary?.openPrCount).toBeNull();
  expect(read.snapshot.githubCompleteness).toBe("partial");
  expect(read.snapshot.resources.map((r) => r.externalId)).toEqual(["1", "2"]);
  expect(read.snapshot.orphans).toHaveLength(MAX_PAGES);
  expect(read.snapshot.truncated).toBe(true);
  expect(calls).toContain(`resources?org_id=${ORG}&limit=100&cursor=pr%3A1`);
});

test("a server without Otto for this organization, a refused session or a malformed answer is a state, not a guess", async () => {
  const read = (reply: Reply) =>
    readOtto({ serverUrl: "https://armada.example", token: "token", orgId: ORG, fetch: server(() => reply).fetcher });
  expect((await read({ status: 404, body: { error: "not_found" } })).state).toBe("not-observed");
  expect((await read({ status: 401, body: { error: "unauthorized" } })).state).toBe("unauthorized");
  expect((await read({ status: 503, body: { error: "observation_unavailable" } })).state).toBe("unavailable");
  expect((await read({ body: page([{ kind: "pr" }]) })).state).toBe("malformed");
  expect((await read({ body: { items: "no" } })).state).toBe("malformed");
  expect((await readOtto({ serverUrl: "not a url", token: "token", orgId: ORG })).state).toBe("unreachable");
});
