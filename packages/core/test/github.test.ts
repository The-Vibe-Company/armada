import { describe, expect, test } from "bun:test";
import { fetchBranchRules, fetchForge, fetchMainHealth, ticketIdFromBranch } from "../src/github.ts";
import { NOW, recordedFetch } from "./support.ts";

describe("fetchBranchRules", () => {
  const repo = { default_branch: "release/trunk", allow_squash_merge: true, delete_branch_on_merge: false };
  const rules = [
    {
      type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "test" }], strict_required_status_checks_policy: true },
    },
    { type: "pull_request", parameters: { required_approving_review_count: 1 } },
    { type: "merge_queue" },
    { type: "required_signatures" },
    { type: "required_linear_history" },
  ];
  const opts = (
    classicStatus = 200,
    active: unknown = rules,
    protection: unknown = {
      required_status_checks: { contexts: ["test", "lint"], checks: [{ context: "deploy" }] },
      required_pull_request_reviews: { required_approving_review_count: 2 },
    },
  ) => {
    const urls: string[] = [];
    const recorded = recordedFetch();
    return {
      urls,
      token: "synthetic-token",
      repository: "acme/widgets",
      fetch: async (url: string, init: RequestInit) => {
        urls.push(url);
        expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic-token");
        if (url.endsWith("/repos/acme/widgets")) return Response.json(repo);
        if (url.includes("/rules/branches/")) return Response.json(active);
        if (url.endsWith("/protection")) return Response.json(protection, { status: classicStatus });
        return recorded.fetch(url, init);
      },
    };
  };

  test("combines classic and active requirements without duplicate checks or weakening approvals", async () => {
    const o = opts();
    expect(await fetchBranchRules(o)).toEqual({
      defaultBranch: "release/trunk",
      allowSquashMerge: true,
      deleteBranchOnMerge: false,
      requiredChecks: ["deploy", "lint", "test"],
      requiredApprovals: 2,
      requiredCodeOwnerReview: false,
      requiredLastPushApproval: false,
      mergeQueue: true,
      requiredSignatures: true,
      requiredLinearHistory: true,
      strictChecks: true,
      classicProtection: "read",
    });
    expect(o.urls).toEqual([
      "https://api.github.com/repos/acme/widgets",
      "https://api.github.com/repos/acme/widgets/rules/branches/release%2Ftrunk?per_page=100&page=1",
      "https://api.github.com/repos/acme/widgets/branches/release%2Ftrunk/protection",
    ]);
  });

  for (const status of [403, 404])
    test(`classic ${status} falls back to active rules`, async () => {
      expect(await fetchBranchRules(opts(status))).toMatchObject({
        requiredChecks: ["test"],
        requiredApprovals: 1,
        mergeQueue: true,
        classicProtection: "unavailable",
      });
    });

  test("empty active rules still retain classic-only requirements", async () => {
    expect(await fetchBranchRules(opts(200, []))).toMatchObject({
      requiredChecks: ["deploy", "lint", "test"],
      requiredApprovals: 2,
    });
  });

  test("reads paginated rules and respects a ruleset's allowed squash method", async () => {
    const o = opts(404);
    const fetch = o.fetch;
    o.fetch = async (url, init) => {
      if (url.includes("/rules/branches/"))
        return Response.json(
          url.endsWith("page=1")
            ? Array.from({ length: 100 }, () => ({ type: "required_linear_history" }))
            : [
                {
                  type: "pull_request",
                  parameters: { required_approving_review_count: 3, allowed_merge_methods: ["rebase"] },
                },
              ],
        );
      return fetch(url, init);
    };
    expect(await fetchBranchRules(o)).toMatchObject({
      allowSquashMerge: false,
      requiredApprovals: 3,
      requiredLinearHistory: true,
    });
  });

  test("unreadable active rules fail rather than claiming compatibility", async () => {
    const o = opts();
    const fetch = o.fetch;
    o.fetch = async (url, init) =>
      url.includes("/rules/branches/") ? new Response("denied", { status: 403 }) : fetch(url, init);
    await expect(fetchBranchRules(o)).rejects.toThrow("HTTP 403");
  });

  test("ruleset and classic independent approval flags survive a zero review count", async () => {
    const o = opts(
      200,
      [{ type: "pull_request", parameters: { required_approving_review_count: 0, require_code_owner_review: true } }],
      {
        required_status_checks: { contexts: [], checks: [] },
        required_pull_request_reviews: { required_approving_review_count: 0, require_last_push_approval: true },
      },
    );
    expect(await fetchBranchRules(o)).toMatchObject({
      requiredApprovals: 0,
      requiredCodeOwnerReview: true,
      requiredLastPushApproval: true,
    });
  });
});

describe("ticketIdFromBranch", () => {
  const known = new Set(["ABC-12", "XY2-7"]);

  test("finds a known ticket id with any team key, in any case and position", () => {
    expect(ticketIdFromBranch("feature/abc-12-add-login", known)).toBe("ABC-12");
    expect(ticketIdFromBranch("XY2-7", known)).toBe("XY2-7");
    expect(ticketIdFromBranch("fix/utf-8-then-abc-12", known)).toBe("ABC-12");
  });

  test("ignores ids that are not in the program or glued to other words", () => {
    expect(ticketIdFromBranch("feature/abc-13-other", known)).toBeNull();
    expect(ticketIdFromBranch("feature/xabc-12", known)).toBeNull();
  });
});

describe("fetchForge", () => {
  test("a timed-out GitHub query retries once with the same request", async () => {
    const recorded = recordedFetch();
    let calls = 0;
    const forge = await fetchForge({
      token: "synthetic-token",
      repository: "acme/widgets",
      fetch: async (url, init) => {
        if (++calls === 1) throw new DOMException("timed out", "TimeoutError");
        return recorded.fetch(url, init);
      },
    });
    expect(calls).toBe(2);
    expect(forge.prs.length).toBeGreaterThan(0);
  });

  test("reads open and recent pull requests with their CI rollup and mergeability", async () => {
    const { fetch, calls } = recordedFetch();
    const forge = await fetchForge({ token: "gh_test", repository: "acme/widgets", fetch, now: () => NOW });
    expect(calls[0]).toMatchObject({ authorization: "Bearer gh_test", variables: { owner: "acme", name: "widgets" } });
    expect(forge.prs.map((p) => [p.number, p.state, p.draft, p.ci, p.mergeable])).toEqual([
      [10, "open", true, "none", "MERGEABLE"],
      [9, "open", false, "success", "MERGEABLE"],
      [8, "open", false, "failure", "MERGEABLE"],
      [7, "open", false, "pending", "UNKNOWN"],
      [6, "merged", false, "success", "MERGEABLE"],
    ]);
  });

  test("an unknown repository is an error, not an empty list", async () => {
    const { fetch } = recordedFetch({ github: { data: { repository: null } } });
    await expect(fetchForge({ token: "t", repository: "acme/nope", fetch })).rejects.toThrow(
      "repository acme/nope not found",
    );
  });
});

test("GitHub reads recover from a temporary HTTP status", async () => {
  let calls = 0;
  const waits: number[] = [];
  const recorded = recordedFetch();
  const forge = await fetchForge({
    token: "synthetic-token",
    repository: "acme/widgets",
    random: () => 0.5,
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: async (url, init) => (++calls === 1 ? new Response("busy", { status: 502 }) : recorded.fetch(url, init)),
  });
  expect(forge.prs.length).toBeGreaterThan(0);
  expect(calls).toBe(2);
  expect(waits).toEqual([1000]);
});

test("reads default-branch history in the forge snapshot and focused health adapter", async () => {
  const sha = "a".repeat(40);
  const github = {
    data: {
      repository: {
        open: { nodes: [] },
        closed: { nodes: [] },
        defaultBranchRef: {
          name: "trunk",
          target: {
            history: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  oid: sha,
                  committedDate: NOW.toISOString(),
                  messageHeadline: "change (#17)",
                  statusCheckRollup: {
                    state: "FAILURE",
                    contexts: {
                      nodes: [
                        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
                        { __typename: "StatusContext", context: "deploy", state: "SUCCESS" },
                      ],
                    },
                  },
                },
                {
                  oid: "b".repeat(40),
                  committedDate: NOW.toISOString(),
                  messageHeadline: "release",
                  statusCheckRollup: null,
                },
              ],
            },
          },
        },
      },
    },
  };
  const recorded = recordedFetch({ github });
  const opts = {
    token: "synthetic-token",
    repository: "acme/widgets",
    fetch: async (url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      expect(query).toMatch(/history\(first: \d+\)/);
      return recorded.fetch(url, init);
    },
  };
  const forge = await fetchForge(opts);
  expect(forge.main).toEqual([
    {
      checksComplete: true,
      branch: "trunk",
      sha,
      at: NOW.toISOString(),
      headline: "change (#17)",
      ci: "failure",
      checks: [
        { name: "test", state: "failure" },
        { name: "deploy", state: "success" },
      ],
    },
    {
      checksComplete: true,
      branch: "trunk",
      sha: "b".repeat(40),
      at: NOW.toISOString(),
      headline: "release",
      ci: "none",
      checks: [],
    },
  ]);
  expect(forge.mainComplete).toBe(true);
  expect(recorded.calls[0]?.operation).toBe("Pulls");
  expect(await fetchMainHealth({ ...opts, requiredChecks: ["test"] })).toMatchObject({
    branch: "trunk",
    head: sha,
    state: "red",
    redSince: { pr: 17 },
    redBeyondWindow: false,
  });
  const empty = recordedFetch({ github: { data: { repository: { defaultBranchRef: null } } } });
  expect(await fetchMainHealth({ ...opts, fetch: empty.fetch })).toBeNull();
});
