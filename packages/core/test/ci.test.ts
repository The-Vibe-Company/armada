import { expect, test } from "bun:test";
import { type Explanation, explainChecks, type FailedCheck, rerunDecision } from "../src/ci.ts";
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

test("failed-step excerpts ignore checkout noise and prioritize the test failure before trailing output", async () => {
  const config = parseConfig(`${DEMO_TOML}
[[ci.known_failure]]
check = "Tests (linux)"
pattern = "checkout noise"
ticket = "DEMO-42"
`);
  const step = "##[group]Run bun test";
  const lines = [
    "##[group]Run actions/checkout@v4",
    "error: checkout noise",
    "##[endgroup]",
    step,
    "##[endgroup]",
    "error: expected size budget",
    "Expected: <= 20000",
    "Received: 20113",
    "(fail) suite > case [1.00ms]",
    ...Array(3500).fill("(pass) unrelated successful output"),
    "##[error]Process completed with exit code 1.",
  ];
  const log = await fetchJobLog({
    token: "synthetic",
    repository: "acme/widgets",
    jobId: 11,
    fetch: async () => new Response(lines.join("\n")),
  });
  const result = explainChecks([check()], new Map([[11, log]]), config.ci)[0];
  expect(result).toMatchObject({
    step: "Run bun test",
    class: "failure",
    tests: ["suite > case"],
    knownFailureDrafts: [{ check: "Tests (linux)", pattern: "^suite > case$" }],
  });
  expect(result?.error[0]).toBe(step);
  expect(result?.error).toContain("Expected: <= 20000");
  expect(result?.error.join("\n")).not.toContain("checkout noise");
  if (!result) throw new Error("missing diagnosis");
  expect(rerunDecision([result], 1).allowed).toBe(false);

  const noisy = [
    step,
    ...Array(50).fill("error: incidental authentication noise"),
    "Expected: true",
    "Received: false",
    ...Array(25).fill("    at test runner (test/example.test.ts:12:3)"),
    "(fail) suite > late case",
    "##[error]exit code 1",
  ];
  const late = explainChecks([check()], new Map([[11, { lines: noisy, warnings: [] }]]))[0];
  expect(late?.error).toContain("(fail) suite > late case");
  expect(late?.error).toContain("Expected: true");
  // Logs without an Actions error annotation retain the original first-error fallback.
  const fallback = explainChecks(
    [check()],
    new Map([
      [
        11,
        {
          lines: noisy.slice(0, -1),
          warnings: [],
        },
      ],
    ]),
  )[0];
  expect(fallback?.step).toBeUndefined();
  expect(fallback?.error[0]).toBe(step);
});

test("flake drafts escape exact unknown names, cap at three and exclude safe or external checks", () => {
  const config = parseConfig(`${DEMO_TOML}
[[ci.known_failure]]
check = "Tests (linux)"
pattern = "^known case$"
ticket = "DEMO-42"
`);
  const lines = [
    "(fail) known case",
    "(fail) suite > case (a.b) [x] +?",
    "(fail) second",
    "(fail) third",
    "(fail) fourth",
  ];
  const result = explainChecks([check()], new Map([[11, { lines, warnings: [] }]]), config.ci)[0];
  expect(result?.knownFailureDrafts).toHaveLength(3);
  const draft = result?.knownFailureDrafts?.[0];
  if (!draft) throw new Error("missing draft");
  const pattern = new RegExp(draft.pattern);
  expect(pattern.test("suite > case (a.b) [x] +?")).toBe(true);
  expect(pattern.test("suite > case (axb) [x] +?")).toBe(false);
  expect(pattern.test("prefix suite > case (a.b) [x] +?")).toBe(false);
  for (const [c, evidence] of [
    [check(), ["(fail) known case"]],
    [check(), ["##[error]No space left on device"]],
    [check({ app: "quality-app" }), ["(fail) unknown case"]],
    [check(), ["error: compilation failed"]],
    [check({ superseded: true }), ["(fail) old case"]],
  ] as const) {
    const explanation = explainChecks([c], new Map([[11, { lines: [...evidence], warnings: [] }]]), config.ci)[0];
    expect(explanation?.knownFailureDrafts).toBeUndefined();
  }
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

test("logs retain early evidence, stop at 5 MB and warn on Actions read or expired logs", async () => {
  const opts = { token: "synthetic", repository: "acme/widgets", jobId: 11 };
  const tail = await fetchJobLog({
    ...opts,
    fetch: async () => new Response(Array.from({ length: 3100 }, (_, i) => `line ${i}`).join("\n")),
  });
  expect(tail.lines).toHaveLength(3100);
  expect(tail.lines[0]).toBe("line 0");
  expect(tail.warnings).toEqual([]);
  const big = await fetchJobLog({ ...opts, fetch: async () => new Response("x".repeat(6 * 1024 * 1024)) });
  expect(big.warnings.join(" ")).toContain("5 MB");
  expect(big.lines.join("\n").length).toBeLessThanOrEqual(5 * 1024 * 1024);
  for (const status of [403, 404, 410]) {
    const log = await fetchJobLog({ ...opts, fetch: async () => new Response(null, { status }) });
    expect(log.lines).toEqual([]);
    expect(log.warnings.join(" ")).toMatch(/Actions.*read|expired/);
  }
});

test("a redirected log retry discards its error body without buffering it or forwarding authorization", async () => {
  let pulls = 0;
  let cancelled = false;
  let downloads = 0;
  const log = await fetchJobLog({
    token: "synthetic",
    repository: "acme/widgets",
    jobId: 11,
    sleep: async () => {},
    fetch: async (url, init) => {
      if (url.endsWith("/logs"))
        return new Response(null, { status: 302, headers: { Location: "https://logs.example.test/job" } });
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      if (++downloads === 1)
        return new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(64 * 1024));
              if (++pulls === 100) controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 503 },
        );
      return new Response("(fail) saves a draft [1.00ms]");
    },
  });
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThanOrEqual(1);
  expect(downloads).toBe(2);
  expect(log.lines).toEqual(["(fail) saves a draft [1.00ms]"]);
  expect(log.warnings).toEqual([]);
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

test("known failures match exact check names and test names or error blocks, keeping external checks external", () => {
  const config = parseConfig(`${DEMO_TOML}
[[ci.known_failure]]
check = "Tests (linux)"
pattern = "cold start"
ticket = "DEMO-42"
`);
  const logs = new Map([[11, { lines: ["(fail) widgets > cold start [1.00ms]"], warnings: [] }]]);
  const results = explainChecks(
    [check(), check({ name: "Tests (mac)" }), check({ app: "quality-app" })],
    logs,
    config.ci,
  );
  expect(results.map((e) => e.class)).toEqual(["known", "failure", "external"]);
  expect(results[0]?.known).toEqual({ ticket: "DEMO-42", pattern: "cold start" });
  expect(
    explainChecks([check()], new Map([[11, { lines: ["error: cold start"], warnings: [] }]]), config.ci)[0]?.class,
  ).toBe("known");
});

test.each([
  [["known"], 1, true, ""],
  [["runner"], 1, true, ""],
  [["known", "runner"], 1, true, ""],
  [["known", "failure"], 1, false, "unknown"],
  [["external"], 1, false, "external"],
  [["known"], 2, false, "already rerun once, attempt 2"],
  [["known"], null, false, "attempt unavailable"],
  [[], 1, false, "No failing checks"],
] as const)("rerun decision %j at attempt %s", (classes, attempt, allowed, reason) => {
  const explanations = classes.map((c) => ({
    check: "Tests",
    class: c,
    conclusion: "FAILURE",
    url: null,
    attempt,
    tests: [],
    error: [],
    ...(c === "known" ? { known: { ticket: "DEMO-42", pattern: "cold start" } } : {}),
  })) as Explanation[];
  const decision = rerunDecision(explanations, attempt);
  expect(decision.allowed).toBe(allowed);
  if (!allowed) expect(decision.reason).toContain(reason);
  if (allowed && classes.includes("known" as never)) expect(decision.tickets).toEqual(["DEMO-42"]);
});

test("a known test or runner signature cannot hide an unknown failure in the same job, even beyond display limits", () => {
  const config = {
    failurePatterns: [],
    setupSteps: [],
    knownFailures: [{ check: "Tests (linux)", pattern: "cold start", ticket: "DEMO-42" }],
  };
  for (const lines of [
    ["(fail) widgets > cold start", "(fail) widgets > saves a draft"],
    [...Array.from({ length: 20 }, (_, i) => `(fail) cold start ${i}`), "(fail) saves a draft"],
    ["No space left on device", "(fail) saves a draft"],
  ]) {
    const result = explainChecks([check()], new Map([[11, { lines, warnings: [] }]]), config);
    expect(result[0]?.class).toBe("failure");
    expect(result[0]?.tests[0]).toContain("saves a draft");
    expect(rerunDecision(result, 1).allowed).toBe(false);
    expect(result[0]?.tests.length).toBeLessThanOrEqual(20);
  }
});

test("every matched root-cause ticket is included when multiple known failures share a job", () => {
  const config = {
    failurePatterns: [],
    setupSteps: [],
    knownFailures: [
      { check: "Tests (linux)", pattern: "cold start", ticket: "DEMO-42" },
      { check: "Tests (linux)", pattern: "transient disconnect", ticket: "DEMO-43" },
    ],
  };
  const result = explainChecks(
    [check()],
    new Map([[11, { lines: ["(fail) cold start", "(fail) transient disconnect"], warnings: [] }]]),
    config,
  );
  expect(result[0]?.class).toBe("known");
  expect(rerunDecision(result, 1).tickets).toEqual(["DEMO-42", "DEMO-43"]);
});

test("network outages qualify only in setup before user steps execute, never registry 4xx", () => {
  const setup = "Run actions/download-artifact@v4";
  const steps = (name = setup): NonNullable<FailedCheck["steps"]> => [
    { name: "Set up job", conclusion: "success", number: 1 },
    { name: "Run actions/checkout@v4", conclusion: "success", number: 2 },
    { name, conclusion: "failure", number: 3 },
    { name: "Test", conclusion: "skipped", number: 4 },
    { name: "Post actions/checkout@v4", conclusion: "success", number: 5 },
    { name: "Complete job", conclusion: "success", number: 6 },
  ];
  const diagnose = (line: string, evidence = steps(), setupSteps: string[] = []) =>
    explainChecks(
      [check({ steps: evidence })],
      new Map([[11, { lines: [...line.split("\n"), "##[error]exit code 1"], warnings: [] }]]),
      { failurePatterns: [], knownFailures: [], setupSteps },
    )[0];
  const reset = "Unable to download artifact(s): ECONNRESET";
  expect(diagnose(reset)).toMatchObject({ class: "runner", runnerReason: `network, in setup step "${setup}"` });
  expect(rerunDecision([diagnose(reset) as Explanation], 1).allowed).toBe(true);
  expect(diagnose(reset, steps("Test"))).toMatchObject({ class: "failure", networkStep: "Test" });
  expect(diagnose("npm error 404 Not Found")).toMatchObject({ class: "failure" });
  expect(diagnose(reset, steps("Install dependencies"), ["Install *"])?.class).toBe("runner");
  expect(diagnose(reset, steps("Run bun test"))?.class).toBe("failure");
  expect(diagnose(reset, [])).toMatchObject({
    class: "failure",
    networkNote: "network error found, step evidence unavailable",
  });
  expect(
    diagnose(
      reset,
      steps().map((s) => (s.name === "Test" ? { ...s, conclusion: "success" } : s)),
    )?.class,
  ).toBe("failure");
  expect(diagnose(reset, [{ name: "Test", conclusion: "success", number: 1 }, ...steps().slice(1)])?.class).toBe(
    "failure",
  );
  expect(diagnose(reset, steps().reverse())?.class).toBe("runner");
  expect(
    diagnose(
      reset,
      steps().map((s) => (s.name.startsWith("Post ") ? { ...s, name: "Post test" } : s)),
    )?.class,
  ).toBe("failure");
  expect(
    diagnose("##[error]assertion failed\nUnable to download artifact(s): ECONNRESET", steps("Test"))?.networkStep,
  ).toBeUndefined();
  for (const line of [
    "npm error code ETIMEDOUT",
    "npm ERR! code EAI_AGAIN",
    "npm error code ECONNREFUSED",
    "request to https://registry.example.test/tool failed, reason: socket hang up",
    "Unable to make request: ECONNRESET",
    "Failed to GetSignedArtifactURL",
    "net/http: TLS handshake timeout",
    "proxyconnect tcp: i/o timeout",
    "fatal: unable to access 'https://github.com/acme/widgets': Could not resolve host: github.com",
    "fatal: unable to access 'https://github.com/acme/widgets': Failed to connect",
    "fatal: unable to access 'https://github.com/acme/widgets': The requested URL returned error: 503",
    "fatal: unable to access 'https://github.com/acme/widgets': Operation timed out",
    "RPC failed; HTTP 502",
    "Error response from daemon: net/http: request canceled",
    "Error response from daemon: i/o timeout",
    "Error response from daemon: toomanyrequests",
    "ReadTimeoutError: HTTPSConnectionPool",
    "Max retries exceeded with url: /tool",
    "Unexpected HTTP response: 503",
    "status code does not indicate success: 502",
  ])
    expect(diagnose(line)?.class).toBe("runner");
  for (const line of [
    "request to https://registry.example.test/tool failed, reason: 404 Not Found",
    "Failed to GetSignedArtifactURL: 403 Forbidden",
    "npm error 401 Unauthorized",
    "npm error 404 Not Found; ECONNRESET",
    `Unable to download artifact(s): ECONNRESET${" ".repeat(1100)}403 Forbidden`,
    "##[error]assertion failed\nUnable to download artifact(s): ECONNRESET",
  ])
    expect(diagnose(line)?.class).toBe("failure");
});
