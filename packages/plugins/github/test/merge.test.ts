import assert from "node:assert/strict";
import { test } from "node:test";
import type { ForgeProvider, PluginContext } from "@armada/plugin-api";
import { activate } from "../src/index.ts";
import { githubToken } from "../src/keychain.ts";

test("merge pins the requested head and reports only confirmed GitHub merges", async (t) => {
  let provider: ForgeProvider | undefined;
  activate({
    config: { forge: { github: { projects: { orchard: { repository: "example/orchard" } } } } },
    secrets: {
      get: async (name: string) => {
        assert.equal(name, "GITHUB_TOKEN");
        return "synthetic-key";
      },
    },
    register: {
      forge: (_kind: string, value: ForgeProvider) => {
        provider = value;
      },
    },
  } as unknown as PluginContext);
  assert.ok(provider);
  const head = "0123456789abcdef0123456789abcdef01234567";
  let calls = 0;
  let merged = true;
  let statusOverride: number | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, "https://api.github.com/repos/example/orchard/pulls/17/merge");
    assert.equal(init.method, "PUT");
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic-key");
    assert.deepEqual(JSON.parse(String(init.body)), { sha: head, merge_method: "squash" });
    return Response.json({ merged }, { status: statusOverride ?? (merged ? 200 : 409) });
  });
  assert.deepEqual(await provider.merge({ project: "orchard", number: 17, head }), { merged: true });
  merged = false;
  assert.deepEqual(await provider.merge({ project: "orchard", number: 17, head }), { merged: false });
  assert.equal(calls, 2);
  await assert.rejects(provider.merge({ project: "orchard", number: 17, head: "" }), /GitHub merge failed/);
  assert.equal(calls, 2);
  statusOverride = 503;
  await assert.rejects(provider.merge({ project: "orchard", number: 17, head }), /GitHub merge failed/);
  assert.equal(calls, 3, "an uncertain server response is never converted to a safe-to-retry refusal");
});

test("merge exposes a valid squash commit SHA while preserving the legacy result without one", async (t) => {
  let provider: ForgeProvider | undefined;
  activate({
    config: { forge: { github: { projects: { orchard: { repository: "example/orchard" } } } } },
    secrets: { get: async () => "synthetic-key" },
    register: {
      forge: (_kind: string, value: ForgeProvider) => {
        provider = value;
      },
    },
  } as unknown as PluginContext);
  assert.ok(provider);
  const head = "0".repeat(40);
  const mergeCommit = "f".repeat(40);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ merged: true, sha: mergeCommit });
  });
  assert.deepEqual(await provider.merge({ project: "orchard", number: 17, head }), {
    merged: true,
    mergeCommit,
  });
  await assert.rejects(
    provider.merge({
      project: "orchard",
      number: 17,
      head,
      beforeWrite: () => {
        throw new Error("closed");
      },
    }),
    /GitHub merge failed/,
  );
  assert.equal(calls, 1);
});

test("inspect returns fresh merge evidence from GitHub and paginates review threads", async (t) => {
  let provider: ForgeProvider | undefined;
  activate({
    config: { forge: { github: { projects: { orchard: { repository: "example/orchard" } } } } },
    secrets: { get: async () => "synthetic-key" },
    register: {
      forge: (_kind: string, value: ForgeProvider) => {
        provider = value;
      },
    },
  } as unknown as PluginContext);
  assert.ok(provider?.inspect);
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const requests: string[] = [];
  let compareBody: unknown = { behind_by: 3, base_commit: { sha: base }, head_commit: { sha: head } };
  let protectionBody: unknown = { required_status_checks: { contexts: ["verify"], checks: [{ context: "lint" }] } };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push(url);
    if (url.endsWith("/graphql")) {
      const body = JSON.parse(String(init.body)) as { query: string };
      if (body.query.includes("query ReviewThreads"))
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  totalCount: 2,
                  nodes: [{ isResolved: false }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              number: 17,
              title: "feat(boats): keep afloat",
              url: "https://github.com/example/orchard/pull/17",
              state: "OPEN",
              isDraft: false,
              mergeable: String(JSON.parse(String(init.body)).query).includes("mergeable") ? "MERGEABLE" : undefined,
              mergeStateStatus: "CLEAN",
              headRefName: "feature/boats",
              headRefOid: head,
              reviewDecision: "APPROVED",
              baseRef: { name: "main", target: { oid: base } },
              mergeCommit: null,
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: head,
                      checkSuites: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                      statusCheckRollup: {
                        state: "SUCCESS",
                        contexts: {
                          nodes: [
                            {
                              __typename: "CheckRun",
                              name: "verify",
                              status: "COMPLETED",
                              conclusion: "SUCCESS",
                              checkSuite: null,
                            },
                          ],
                          pageInfo: { hasNextPage: false, endCursor: null },
                        },
                      },
                    },
                  },
                ],
              },
              reviewThreads: {
                totalCount: 2,
                nodes: [{ isResolved: true }],
                pageInfo: { hasNextPage: true, endCursor: "thread-1" },
              },
            },
          },
        },
      });
    }
    if (url.includes("/compare/")) return Response.json(compareBody);
    assert.equal(url, "https://api.github.com/repos/example/orchard/branches/main/protection");
    return Response.json(protectionBody);
  });
  const result = await provider.inspect({ project: "orchard", number: 17 });
  assert.equal(result.number, 17);
  assert.deepEqual(
    {
      head: result.head,
      base: result.base,
      baseRef: result.baseRef,
      state: result.state,
      title: result.title,
      draft: result.draft,
      mergeState: result.mergeState,
      mergeCommit: result.mergeCommit,
      behindBy: result.behindBy,
      checksComplete: result.checksComplete,
      checks: result.checks,
      requiredChecks: result.requiredChecks,
      reviewThreads: result.reviewThreads,
    },
    {
      head,
      base,
      baseRef: "main",
      state: "open",
      title: "feat(boats): keep afloat",
      draft: false,
      mergeState: "CLEAN",
      mergeCommit: null,
      behindBy: 3,
      checksComplete: true,
      checks: [{ name: "verify", state: "success" }],
      requiredChecks: ["lint", "verify"],
      reviewThreads: { complete: true, total: 2, read: 2, unresolved: 1 },
    },
  );
  assert.deepEqual(requests, [
    "https://api.github.com/graphql",
    "https://api.github.com/graphql",
    `https://api.github.com/repos/example/orchard/compare/${base}...${head}`,
    "https://api.github.com/repos/example/orchard/branches/main/protection",
  ]);
  compareBody = { behind_by: 3 };
  await assert.rejects(provider.inspect({ project: "orchard", number: 17 }), /GitHub inspection failed/);
  compareBody = { behind_by: 3, base_commit: { sha: base } };
  for (const malformed of [{}, { required_status_checks: {} }]) {
    protectionBody = malformed;
    await assert.rejects(provider.inspect({ project: "orchard", number: 17 }), /GitHub inspection failed/);
  }
  protectionBody = { url: "https://api.github.com/repos/example/orchard/branches/main/protection" };
  const withoutRequiredChecks = await provider.inspect({ project: "orchard", number: 17 });
  assert.deepEqual(withoutRequiredChecks.requiredChecks, []);
  protectionBody = { contexts: ["verify"], checks: [{ context: "lint" }] };
  const focusedProtection = await provider.inspect({ project: "orchard", number: 17 });
  assert.deepEqual(focusedProtection.requiredChecks, ["lint", "verify"]);
});

test("inspect marks truncated head checks and review threads incomplete instead of claiming readiness", async (t) => {
  let provider: ForgeProvider | undefined;
  activate({
    config: { forge: { github: { projects: { orchard: { repository: "example/orchard" } } } } },
    secrets: { get: async () => "synthetic-key" },
    register: {
      forge: (_kind: string, value: ForgeProvider) => {
        provider = value;
      },
    },
  } as unknown as PluginContext);
  assert.ok(provider?.inspect);
  const head = "c".repeat(40);
  const base = "d".repeat(40);
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/graphql"))
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              number: 17,
              title: "fix(boats): check evidence",
              url: "https://github.com/example/orchard/pull/17",
              state: "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              headRefName: "feature/boats",
              headRefOid: head,
              reviewDecision: null,
              baseRef: { name: "main", target: { oid: base } },
              mergeCommit: null,
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: head,
                      checkSuites: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "checks-1" } },
                      statusCheckRollup: {
                        state: "SUCCESS",
                        contexts: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                      },
                    },
                  },
                ],
              },
              reviewThreads: {
                totalCount: 2,
                nodes: [{ isResolved: true }],
                pageInfo: { hasNextPage: true, endCursor: null },
              },
            },
          },
        },
      });
    if (url.includes("/compare/")) return Response.json({ behind_by: 0, base_commit: { sha: base } });
    return Response.json({ required_status_checks: null });
  });
  const result = await provider.inspect({ project: "orchard", number: 17 });
  assert.equal(result.checksComplete, false);
  assert.deepEqual(result.reviewThreads, { complete: false, total: 2, read: 1, unresolved: 0 });
});

test("the declared token wins; missing or locked secrets fall back to gh without leaking errors", async () => {
  const calls: string[] = [];
  const command = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args].join(" "));
    return "synthetic-gh-token\n";
  };
  assert.equal(
    await githubToken({ keychain: { read: async () => "synthetic-declared-token" }, command }),
    "synthetic-declared-token",
  );
  assert.deepEqual(calls, []);
  const privateValue = "synthetic-private-token";
  for (const locked of [false, true]) {
    calls.length = 0;
    assert.equal(
      await githubToken({
        keychain: {
          read: async () => {
            if (locked) throw new Error(privateValue);
            return null;
          },
        },
        command,
      }),
      "synthetic-gh-token",
    );
    assert.deepEqual(calls, ["gh auth token"]);
  }
  await assert.rejects(
    githubToken({
      keychain: {
        read: async () => {
          throw new Error(privateValue);
        },
      },
      command: async () => {
        throw new Error(privateValue);
      },
    }),
    (error: Error) => error.message === "GitHub credentials unavailable" && !error.message.includes(privateValue),
  );
  const stopped = new AbortController();
  stopped.abort();
  calls.length = 0;
  let secretReads = 0;
  await assert.rejects(
    githubToken({
      signal: stopped.signal,
      keychain: {
        read: async () => {
          secretReads++;
          return "synthetic-declared-token";
        },
      },
      command,
    }),
    /GitHub credentials unavailable/,
  );
  assert.equal(secretReads, 0);
  assert.deepEqual(calls, []);
});
