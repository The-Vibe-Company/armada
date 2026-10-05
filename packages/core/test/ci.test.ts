import { expect, test } from "bun:test";
import { explainChecks, type FailedCheck } from "../src/ci.ts";
import { parseConfig } from "../src/config.ts";
import { fetchFailedChecks, fetchJobLog, fetchRunAttempt } from "../src/github.ts";
import { DEMO_TOML, recordedFetch } from "./support.ts";

const sha = "a".repeat(40);
const check = (over: Partial<FailedCheck> = {}): FailedCheck => ({
  id: 11,
  name: "Tests (linux)",
  conclusion: "FAILURE",
  url: "https://github.com/acme/widgets/actions/runs/7/job/11",
  app: "github-actions",
  runId: 7,
  headSha: sha,
  summary: null,
  annotations: [],
  ...over,
});

test("bun failure names tests and first error; disk-full is a runner problem", () => {
  const result = explainChecks(
    [check(), check({ id: 12, name: "Tests (mac)" })],
    new Map([
      [
        11,
        {
          lines: [
            "expect(received).toBe(expected)",
            "Expected: 2",
            "Received: 1",
            "(fail) widgets > saves a draft [1.00ms]",
            "##[error]Process completed with exit code 1.",
          ],
          warnings: [],
        },
      ],
      [12, { lines: ["##[error]No space left on device"], warnings: [] }],
    ]),
  );
  expect(result[0]?.tests).toEqual(["widgets > saves a draft"]);
  expect(result[0]?.error).toContain("Expected: 2");
  expect(result.map((r) => r.class)).toEqual(["failure", "runner"]);
});

test.each([
  ["✕ saves a draft (5 ms)", "saves a draft"],
  ["× saves a draft", "saves a draft"],
  ["FAIL test/widgets.test.ts", "test/widgets.test.ts"],
  ["FAILED test_widgets.py::test_save - AssertionError", "test_widgets.py::test_save"],
  ["--- FAIL: TestSave (0.00s)", "TestSave"],
  ["test widgets::save ... FAILED", "widgets::save"],
  ["  1 failing\n  1) widgets saves a draft:", "widgets saves a draft"],
])("extracts common runner-neutral output: %s", (line, name) => {
  expect(explainChecks([check()], new Map([[11, { lines: line.split("\n"), warnings: [] }]]))[0]?.tests).toEqual([
    name,
  ]);
});

test("annotations come first, project patterns work, and output is bounded", () => {
  const config = parseConfig(`${DEMO_TOML}\n[ci]\nfailure_patterns = ['BROKEN: (.+)']`);
  const result = explainChecks(
    [
      check({
        annotations: [{ title: "BROKEN: annotated test", message: "Expected true", path: "test/a.ts", line: 4 }],
      }),
    ],
    new Map([
      [
        11,
        {
          lines: Array.from({ length: 100 }, (_, i) => `BROKEN: test ${i}`),
          warnings: [],
        },
      ],
    ]),
    config.ci,
  )[0];
  expect(result?.tests[0]).toBe("annotated test");
  expect(result?.tests).toHaveLength(20);
  expect(result?.error).toHaveLength(40);
  for (const p of ["[", "no capture", "(one)(two)"])
    expect(() => parseConfig(`${DEMO_TOML}\n[ci]\nfailure_patterns = ['${p}']`)).toThrow("ci.failure_patterns");
  expect(() => parseConfig(`${DEMO_TOML}\n[ci]\nfailures = []`)).toThrow('unknown key "ci.failures"');
});

test("external checks show summaries; unavailable logs use annotations; superseded cancellation is informational", () => {
  const result = explainChecks(
    [
      check({ id: null, app: "quality-app", summary: "Quality threshold failed" }),
      check({ annotations: [{ title: "(fail) saves a draft", message: "Expected true", path: "test/a.ts", line: 4 }] }),
      check({ conclusion: "CANCELLED", superseded: true }),
    ],
    new Map(),
  );
  expect(result[0]).toMatchObject({ class: "external", error: ["Quality threshold failed"], url: check().url });
  expect(result[1]?.tests).toEqual(["saves a draft"]);
  expect(result[1]?.error).toContain("Expected true");
  expect(result[2]).toMatchObject({ superseded: true, error: ["superseded by a newer head"] });
});

test.each([
  "The runner has received a shutdown signal",
  "lost communication with the server",
  "The hosted runner encountered an error",
  "The job was not acquired by Runner of type hosted even after multiple attempts",
  "Killed\nProcess completed with exit code 137.",
])("runner signature: %s", (line) => {
  expect(explainChecks([check()], new Map([[11, { lines: line.split("\n"), warnings: [] }]]))[0]?.class).toBe("runner");
});

test("recorded failed-check read follows log redirect without sharing authorization", async () => {
  const raw = {
    data: {
      repository: {
        object: {
          oid: sha,
          status: {
            contexts: [
              {
                context: "quality",
                state: "ERROR",
                description: "Policy failed",
                targetUrl: "https://quality.example.test/9",
              },
            ],
          },
          checkSuites: {
            nodes: [
              {
                app: { slug: "github-actions" },
                commit: { oid: sha },
                workflowRun: { databaseId: 7 },
                checkRuns: {
                  nodes: [
                    {
                      databaseId: 11,
                      name: "Tests (linux)",
                      conclusion: "FAILURE",
                      detailsUrl: check().url,
                      summary: null,
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
  };
  const recording = recordedFetch({ github: raw });
  const fetch = async (url: string, init: RequestInit) => {
    if (url.endsWith("/graphql")) return recording.fetch(url, init);
    if (url.endsWith("/logs")) {
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic-token");
      expect(init.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { Location: "https://logs.example.test/job" } });
    }
    if (url.endsWith("/runs/7")) return Response.json({ run_attempt: 2 });
    expect(url).toBe("https://logs.example.test/job");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    return new Response("(fail) saves a draft [1.00ms]\n##[error]exit code 1");
  };
  const opts = { token: "synthetic-token", repository: "acme/widgets", fetch };
  const failed = await fetchFailedChecks({ ...opts, sha });
  expect(failed.checks.map((c) => c.name)).toEqual(["Tests (linux)", "quality"]);
  const log = await fetchJobLog({ ...opts, jobId: 11 });
  expect(explainChecks(failed.checks, new Map([[11, log]]))[0]?.tests).toEqual(["saves a draft"]);
  expect(await fetchRunAttempt({ ...opts, runId: 7 })).toBe(2);
  expect(recording.calls[0]?.variables).toMatchObject({ sha });
});

test("logs keep their last 3000 lines, stop at 5 MB and warn on Actions read or expired logs", async () => {
  const opts = { token: "synthetic", repository: "acme/widgets", jobId: 11 };
  const tail = await fetchJobLog({
    ...opts,
    fetch: async () => new Response(Array.from({ length: 3100 }, (_, i) => `line ${i}`).join("\n")),
  });
  expect(tail.lines).toHaveLength(3000);
  expect(tail.lines[0]).toBe("line 100");
  const big = await fetchJobLog({ ...opts, fetch: async () => new Response("x".repeat(6 * 1024 * 1024)) });
  expect(big.warnings.join(" ")).toContain("5 MB");
  expect(big.lines.join("\n").length).toBeLessThanOrEqual(5 * 1024 * 1024);
  for (const status of [403, 404, 410]) {
    const log = await fetchJobLog({ ...opts, fetch: async () => new Response(null, { status }) });
    expect(log.lines).toEqual([]);
    expect(log.warnings.join(" ")).toMatch(/Actions.*read|expired/);
  }
});

test("historical cancellation uses the suite branch head, and each matrix leg is retained once", async () => {
  const run = {
    databaseId: 11,
    name: "Tests (linux)",
    conclusion: "CANCELLED",
    detailsUrl: check().url,
    summary: null,
    annotations: { nodes: [] },
  };
  const payload = {
    data: {
      repository: {
        object: {
          oid: sha,
          status: null,
          checkSuites: {
            nodes: [
              {
                app: { slug: "github-actions" },
                commit: { oid: sha },
                branch: { target: { oid: "b".repeat(40) } },
                workflowRun: { databaseId: 7 },
                checkRuns: {
                  nodes: [run, run, { ...run, databaseId: 12, name: "Tests (mac)", conclusion: "FAILURE" }],
                },
              },
            ],
          },
        },
      },
    },
  };
  const result = await fetchFailedChecks({
    token: "synthetic",
    repository: "acme/widgets",
    sha,
    fetch: recordedFetch({ github: payload }).fetch,
  });
  expect(result.checks.map((c) => [c.id, c.superseded ?? false])).toEqual([
    [11, true],
    [12, false],
  ]);
});

test("a final exit-code annotation cannot hide an earlier causal test error", () => {
  const lines = [
    "running tests",
    "error: expect(received).toBe(expected)",
    "Expected: true",
    "Received: false",
    "(fail) widgets > saves a draft [1.00ms]",
    ...Array(80).fill("unrelated successful output"),
    "##[error]Process completed with exit code 1.",
  ];
  const result = explainChecks([check()], new Map([[11, { lines, warnings: [] }]]))[0];
  expect(result?.error).toContain("error: expect(received).toBe(expected)");
  expect(result?.error).toContain("Expected: true");
  expect(result?.tests).toEqual(["widgets > saves a draft"]);
  expect(result?.error.length).toBeLessThanOrEqual(40);
});
