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

function rerunFixture({
  attempt = 1,
  status = "completed",
  known = true,
  mixed = false,
  external = false,
  incomplete = false,
  writeFails = false,
  empty = false,
  race = false,
  attemptUnavailable = false,
  greenRun = false,
  newFailure = false,
} = {}) {
  const f = fixture({ empty });
  const writes: unknown[] = [];
  let attemptReads = 0;
  let failureReads = 0;
  const fetch = f.io.fetch;
  if (!fetch) throw new Error("fixture needs fetch");
  f.io.readFile = async (p) =>
    p === "/project/armada.toml"
      ? DEMO_TOML +
        (known
          ? '\n[[ci.known_failure]]\ncheck = "Tests (linux)"\npattern = "widgets > saves a draft"\nticket = "DEMO-42"\n'
          : "")
      : null;
  f.io.fetch = async (url, init) => {
    if (url.endsWith("/runs/8")) return Response.json({ run_attempt: 1, status: "completed" });
    if (url.endsWith("/runs/7") && attemptUnavailable) return Response.json({ status: "completed" });
    if (url.endsWith("/runs/7"))
      return Response.json({ run_attempt: race && ++attemptReads > 1 ? 2 : attempt, status });
    if (url.endsWith("/jobs/12/logs")) return new Response("(fail) widgets > unknown failure");
    const response = await fetch(url, init);
    if (url !== GITHUB_GRAPHQL || !String(init.body).includes("FailedChecks")) return response;
    const body = (await response.json()) as {
      data: {
        repository: {
          object: {
            status: unknown;
            checkSuites: {
              pageInfo?: { hasNextPage: boolean };
              nodes: {
                app: { slug: string };
                commit: { oid: string };
                workflowRun: { databaseId: number };
                checkRuns: { nodes: { databaseId: number; name: string }[] };
              }[];
            };
          };
        };
      };
    };
    const commit = body.data.repository.object;
    if (empty)
      commit.checkSuites.nodes = [
        {
          app: { slug: "github-actions" },
          commit: { oid: sha },
          workflowRun: { databaseId: 7 },
          checkRuns: { nodes: [] },
        },
      ];
    if (greenRun)
      commit.checkSuites.nodes.push({
        app: { slug: "github-actions" },
        commit: { oid: sha },
        workflowRun: { databaseId: 8 },
        checkRuns: { nodes: [] },
      });
    if (incomplete) commit.checkSuites.pageInfo = { hasNextPage: true };
    if (mixed || (newFailure && ++failureReads > 1)) {
      const suite = commit.checkSuites.nodes[0];
      const first = suite?.checkRuns.nodes[0];
      if (!suite || !first) throw new Error("mixed fixture needs one failed check");
      suite.checkRuns.nodes.push({ ...first, databaseId: 12, name: "Tests (mac)" });
    }
    if (external)
      commit.status = {
        contexts: [
          {
            context: "quality",
            state: "ERROR",
            description: "Policy failed",
            targetUrl: "https://quality.example.test/9",
          },
        ],
      };
    return Response.json(body);
  };
  f.io.exec = async (...args) => {
    writes.push(args);
    return { code: writeFails ? 1 : 0, stdout: "", stderr: writeFails ? "synthetic secret must not be exposed" : "" };
  };
  return { ...f, writes };
}

test("ci why --rerun names the root-cause ticket and writes once, scoped to the configured repository", async () => {
  const f = rerunFixture();
  expect(await run(["ci", "why", "9", "--rerun"], f.io)).toBe(0);
  expect(f.out()).toContain("DEMO-42");
  expect(f.out()).toContain("Rerun requested");
  expect(f.writes).toEqual([["gh", ["run", "rerun", "7", "--failed", "--repo", "acme/widgets"], { cwd: "/project" }]]);
});

test.each([
  [{ newFailure: true }, "failing checks changed"],
  [{ attemptUnavailable: true }, "attempt unavailable"],
  [{ external: true, empty: true }, "external"],
  [{ attempt: 2 }, "already rerun once, attempt 2"],
  [{ mixed: true }, "unknown"],
  [{ known: false }, "unknown"],
  [{ status: "in_progress" }, "in_progress"],
  [{ incomplete: true }, "incomplete"],
  [{ race: true }, "already rerun once, attempt 2"],
  [{ empty: true, attempt: 2, status: "queued" }, "already rerun once, attempt 2"],
] as const)("ci rerun refusal never writes", async (options, reason) => {
  const f = rerunFixture(options);
  expect(await run(["ci", "why", "9", "--rerun"], f.io)).toBe(1);
  expect(f.writes).toEqual([]);
  expect(f.out()).toContain(reason);
  if ("mixed" in options && options.mixed)
    expect(f.out().indexOf("Tests (mac):")).toBeLessThan(f.out().indexOf("Tests (linux):"));
});

test("JSON rerun output remains one document and uncertain writes are never retried or printed", async () => {
  const f = rerunFixture({ writeFails: true });
  expect(await run(["ci", "why", "9", "--rerun", "--json"], f.io)).toBe(1);
  const result = JSON.parse(f.out());
  expect(result.reruns[0]).toMatchObject({ runId: 7, status: "uncertain" });
  expect(f.writes).toHaveLength(1);
  expect(f.out() + f.err()).not.toContain("synthetic secret");
});

test("successful first-attempt workflows do not turn a permitted rerun into a refusal", async () => {
  const f = rerunFixture({ greenRun: true });
  expect(await run(["ci", "why", "9", "--rerun", "--json"], f.io)).toBe(0);
  expect(f.writes).toHaveLength(1);
  expect(JSON.parse(f.out()).reruns).toHaveLength(1);
});

test("two requests on the same GitHub run rerun only its first attempt", async () => {
  const f = rerunFixture();
  let reran = false;
  const fetch = f.io.fetch;
  const exec = f.io.exec;
  if (!fetch || !exec) throw new Error("fixture needs fetch and exec");
  f.io.fetch = async (url, init) =>
    url.endsWith("/runs/7") ? Response.json({ run_attempt: reran ? 2 : 1, status: "completed" }) : fetch(url, init);
  f.io.exec = async (...args) => {
    const result = await exec(...args);
    reran = true;
    return result;
  };
  expect(await run(["ci", "why", "9", "--rerun"], f.io)).toBe(0);
  expect(await run(["ci", "why", "9", "--rerun"], f.io)).toBe(1);
  expect(f.out()).toContain("already rerun once, attempt 2");
  expect(f.writes).toHaveLength(1);
});

test("dependent summary failures rerun with known flakes, but a summary's own failure blocks", async () => {
  for (const scenario of [
    "dependent",
    "skipped user step",
    "own output",
    "own command",
    "another failed step",
    "missing steps",
    "wrong run",
    "unknown dependency",
    "different workflow",
    "second attempt",
    "annotation failure",
    "summary error",
    "runner summary error",
    "known summary error",
    "annotation error",
    "continued gate",
    "missing step number",
  ]) {
    const allowed = scenario === "dependent" || scenario === "skipped user step";
    const f = rerunFixture();
    const fetch = f.io.fetch;
    if (!fetch) throw new Error("fixture needs fetch");
    if (scenario === "known summary error") {
      const readFile = f.io.readFile;
      f.io.readFile = async (path) => {
        const text = await readFile(path);
        return text === null
          ? null
          : text +
              '\n[[ci.known_failure]]\ncheck = "verify"\npattern = "Process completed with exit code 1"\nticket = "DEMO-43"\n';
      };
    }
    f.io.fetch = async (url, init) => {
      if (url.endsWith("/runs/7") && scenario === "second attempt")
        return Response.json({ run_attempt: 2, status: "completed" });
      if (url.endsWith("/jobs/12"))
        return Response.json({
          id: 12,
          run_id: scenario === "wrong run" || scenario === "different workflow" ? 8 : 7,
          head_sha: sha,
          name: "verify",
          status: "completed",
          conclusion: "failure",
          steps:
            scenario === "missing steps"
              ? undefined
              : [
                  { name: "Set up job", conclusion: "success", number: 1 },
                  ...(scenario === "skipped user step"
                    ? [{ name: "Other dependency gate", conclusion: "skipped", number: 3 }]
                    : []),
                  ...(scenario === "another failed step"
                    ? [{ name: "Validate config", conclusion: "failure", number: 4 }]
                    : []),
                  {
                    name: "Check dependencies",
                    conclusion: scenario === "continued gate" ? "success" : "failure",
                    number: scenario === "missing step number" ? undefined : 2,
                  },
                  ...(scenario === "continued gate"
                    ? [{ name: "Validate config", conclusion: "failure", number: 3 }]
                    : []),
                  { name: "Complete job", conclusion: "success", number: 5 },
                ],
        });
      if (url.endsWith("/jobs/12/logs"))
        return new Response(
          [
            '##[group]Run echo "Dependency failed: Tests (linux)"',
            'echo "Dependency failed: Tests (linux)"',
            ...(scenario === "own command" ? ["bun test summary.test.ts"] : []),
            "exit 1",
            "shell: /usr/bin/bash -e {0}",
            "##[endgroup]",
            "Dependency failed: Tests (linux)",
            ...(scenario === "own output" ? ["(fail) summary > rejects invalid configuration", "Expected: valid"] : []),
            "##[error]Process completed with exit code 1.",
          ]
            .join("\n")
            .replaceAll("Tests (linux)", scenario === "unknown dependency" ? "Tests (windows)" : "Tests (linux)"),
        );
      const response = await fetch(url, init);
      if (url !== GITHUB_GRAPHQL || !String(init.body).includes("FailedChecks")) return response;
      const body = (await response.json()) as {
        data: {
          repository: {
            object: {
              checkSuites: {
                nodes: { workflowRun: { databaseId: number }; checkRuns: { nodes: Record<string, unknown>[] } }[];
              };
            };
          };
        };
      };
      const suite = body.data.repository.object.checkSuites.nodes[0];
      if (!suite) throw new Error("fixture needs a failed suite");
      const checks = suite.checkRuns.nodes;
      const summary = {
        ...checks[0],
        databaseId: 12,
        name: "verify",
        summary:
          scenario === "runner summary error"
            ? "No space left on device"
            : scenario === "summary error" || scenario === "known summary error"
              ? "summary command failed"
              : "##[error]Process completed with exit code 1.",
        annotations: {
          nodes:
            scenario === "annotation failure" || scenario === "annotation error"
              ? [
                  {
                    title:
                      scenario === "annotation error"
                        ? "Summary error"
                        : "(fail) summary > rejects invalid configuration",
                    message: scenario === "annotation error" ? "summary command failed" : "Expected: valid",
                    path: "test/summary.ts",
                    location: { start: { line: 1 } },
                  },
                ]
              : [],
        },
      };
      if (scenario === "different workflow")
        body.data.repository.object.checkSuites.nodes.push({
          ...suite,
          checkRuns: { nodes: [summary] },
          workflowRun: { databaseId: 8 },
        });
      else checks.push(summary);
      return Response.json(body);
    };
    expect(await run(["ci", "why", "9", "--rerun"], f.io)).toBe(allowed ? 0 : 1);
    expect(f.out()).toContain("Tests (linux): known flaky test");
    expect(f.out()).toContain("DEMO-42");
    if (!allowed) {
      expect(f.out()).toContain(
        scenario === "second attempt" ? "already rerun once" : "unknown or external failures: verify",
      );
      // Separate known workflows retain their existing independent rerun behavior.
      expect(f.writes).toHaveLength(scenario === "different workflow" ? 1 : 0);
    } else {
      expect(f.out()).toContain("verify: ignored as a dependent summary");
      expect(f.out()).toContain("Rerun requested");
      expect(f.writes).toHaveLength(1);
    }
  }
});
