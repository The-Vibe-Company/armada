import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_GRAPHQL } from "../../core/src/github.ts";
import { machinePaths, updateWatchState } from "../../core/src/machine.ts";
import { DEMO_TOML, recordedFetch } from "../../core/test/support.ts";
import { type Io, run } from "../src/cli.ts";

const sha = "a".repeat(40);
function fixture({ cancelled = false, push = false, empty = false, permission = false, transient = false } = {}) {
  const out: string[] = [],
    err: string[] = [],
    calls: string[] = [];
  let reads = 0;
  let logReads = 0;
  let attemptReads = 0;
  const waits: number[] = [];
  const io: Io = {
    cwd: "/project",
    env: { GITHUB_TOKEN: "synthetic" },
    readFile: async (p) => (p === "/project/armada.toml" ? DEMO_TOML : null),
    ghToken: () => null,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    sleep: async (ms) => {
      waits.push(ms);
    },
    fetch: async (url, init) => {
      calls.push(url);
      if (url === GITHUB_GRAPHQL) {
        const { query } = JSON.parse(String(init.body));
        if (/query (Pull|CiBranch)\(/.test(query)) {
          reads++;
          const current = reads > 1 && push ? "b".repeat(40) : sha;
          if (query.includes("CiBranch"))
            return Response.json({ data: { repository: { ref: { target: { oid: current } } } } });
          return recordedFetch({
            github: {
              data: {
                repository: {
                  pullRequest: {
                    number: 9,
                    title: "Synthetic",
                    url: "https://github.com/acme/widgets/pull/9",
                    state: "OPEN",
                    isDraft: false,
                    mergeable: "MERGEABLE",
                    headRefName: "feature/demo-9",
                    headRefOid: current,
                    createdAt: "2026-03-04T10:00:00Z",
                    updatedAt: "2026-03-04T10:00:00Z",
                    mergedAt: null,
                    commits: { nodes: [] },
                  },
                },
              },
            },
          }).fetch(url, init);
        }
        expect(query).toContain("query FailedChecks");
        return Response.json({
          data: {
            repository: {
              object: {
                oid: sha,
                status: null,
                checkSuites: {
                  nodes: empty
                    ? []
                    : [
                        {
                          app: { slug: "github-actions" },
                          commit: { oid: sha },
                          workflowRun: { databaseId: 7 },
                          checkRuns: {
                            nodes: [
                              {
                                databaseId: 11,
                                name: "Tests (linux)",
                                conclusion: cancelled ? "CANCELLED" : "FAILURE",
                                detailsUrl: "https://github.com/acme/widgets/actions/runs/7/job/11",
                                summary: "##[error]Expected true",
                                annotations: { nodes: [] },
                              },
                            ],
                          },
                        },
                      ],
                },
              },
            },
          },
        });
      }
      if (url.endsWith("/logs")) {
        if (transient && ++logReads === 1) return new Response(null, { status: 503 });
        return permission
          ? new Response(null, { status: 403 })
          : new Response(
              "Expected: true\nReceived: false\n(fail) widgets > saves a draft [1.00ms]\n##[error]Process completed with exit code 1.\n" +
                "context\n".repeat(50),
            );
      }
      if (url.endsWith("/runs/7")) {
        if (transient && ++attemptReads === 1) return new Response(null, { status: 502 });
        return Response.json({ run_attempt: 2 });
      }
      throw new Error("unexpected non-GitHub read");
    },
  };
  return { io, out: () => out.join(""), err: () => err.join(""), calls, waits };
}

test("ci why retries temporary Actions failures through injected waits and stderr notices", async () => {
  const f = fixture({ transient: true });
  expect(await run(["ci", "why", "9"], f.io)).toBe(0);
  expect(f.out()).toContain("widgets > saves a draft");
  expect(f.out()).toContain("workflow attempt 2");
  expect(f.err()).toContain("GitHub answered 503; trying again");
  expect(f.err()).toContain("GitHub answered 502; trying again");
  expect(f.err()).not.toContain("unavailable");
  expect(f.waits).toHaveLength(2);
});

test.each(
  [["9"], ["https://github.com/acme/widgets/pull/9"], ["--sha", sha], ["--branch", "main"]].map((selector) => ({
    selector,
  })),
)("ci why accepts %s with only GitHub credentials", async ({ selector }) => {
  const f = fixture();
  expect(await run(["ci", "why", ...selector], f.io)).toBe(0);
  expect(f.out()).toContain("Tests (linux): failure (failure, workflow attempt 2)");
  expect(f.out()).toContain("widgets > saves a draft");
  expect(f.out()).toContain("Expected: true");
  expect(f.out().split("\n").length).toBeLessThan(60);
  expect(f.err()).toBe("");
});

test.each(
  [
    ["why"],
    ["why", "9", "--sha", sha],
    ["why", "--sha", "bad"],
    ["why", "--branch", ""],
    ["why", "https://github.com/other/repo/pull/9"],
    ["why", "9", "extra"],
    ["oops", "9"],
  ].map((args) => ({ args })),
)("ci why rejects invalid selection %s", async ({ args }) => {
  const f = fixture();
  expect(await run(["ci", ...args], f.io)).toBe(2);
  expect(f.calls).toEqual([]);
});

test("JSON includes warnings, annotations fallback and the pinned SHA", async () => {
  const f = fixture({ permission: true });
  expect(await run(["ci", "why", "--sha", sha, "--json"], f.io)).toBe(0);
  const report = JSON.parse(f.out());
  expect(report.sha).toBe(sha);
  expect(report.explanations[0].error).toEqual(["##[error]Expected true"]);
  expect(report.warnings.join(" ")).toContain("Actions repository permission (read)");
});

test("newer push marks a cancelled head superseded and avoids Actions log reads", async () => {
  const f = fixture({ cancelled: true, push: true });
  expect(await run(["ci", "why", "9", "--json"], f.io)).toBe(0);
  expect(JSON.parse(f.out()).explanations[0]).toMatchObject({ superseded: true, conclusion: "CANCELLED" });
  expect(f.calls.every((url) => url === GITHUB_GRAPHQL)).toBe(true);
  const current = fixture({ cancelled: true });
  expect(await run(["ci", "why", "9", "--json"], current.io)).toBe(0);
  expect(JSON.parse(current.out()).explanations[0].superseded).toBeUndefined();
});

test("no failures reports no failing checks without claiming green CI", async () => {
  const f = fixture({ empty: true });
  expect(await run(["ci", "why", "--branch", "main"], f.io)).toBe(0);
  expect(f.out()).toContain("No failing checks reported on this head");
});

test("CI project selection uses the watched repository outside its checkout with GitHub credentials alone", async () => {
  const machineDir = await mkdtemp(join(tmpdir(), "armada-ci-project-"));
  try {
    const paths = machinePaths({ XDG_CONFIG_HOME: machineDir });
    if (!paths) throw new Error("temporary machine store missing");
    await updateWatchState(paths, "widgets", { root: "/selected" });
    for (const cwd of ["/outside", "/other"]) {
      const f = fixture();
      f.io.cwd = cwd;
      f.io.env.XDG_CONFIG_HOME = machineDir;
      f.io.readFile = async (p) =>
        p === "/selected/armada.toml"
          ? DEMO_TOML
          : p === "/other/armada.toml"
            ? DEMO_TOML.replace("acme/widgets", "acme/other")
            : null;
      const fetch = f.io.fetch;
      if (!fetch) throw new Error("fixture fetch missing");
      f.io.fetch = async (url, init) => {
        if (url === GITHUB_GRAPHQL)
          expect(JSON.parse(String(init.body)).variables).toMatchObject({ owner: "acme", name: "widgets" });
        return fetch(url, init);
      };
      expect(await run(["ci", "why", "9", "--project", "widgets", "--json"], f.io)).toBe(0);
      expect(JSON.parse(f.out()).explanations[0].tests).toContain("widgets > saves a draft");
      expect(f.err()).toBe("");
    }
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
