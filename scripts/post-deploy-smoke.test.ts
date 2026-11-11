import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postDeploySmoke } from "./post-deploy-smoke.ts";

const selected = {
  provider: "boat",
  harness: "codex",
  org: "org",
  golden: "smoke-golden",
  goldenId: "golden-id",
  model: "model",
  modelAccountId: "account",
  repo: "/home/user/repo",
};
const env = {
  ARMADA_URL: "https://smoke.invalid",
  ARMADA_TOKEN: "secret-token",
  ARMADA_SMOKE: "create_real_compute",
  ARMADA_SMOKE_CASES: JSON.stringify([selected]),
};
const json = (body: unknown, status = 200) => Response.json(body, { status });
type Call = { path: string; body: Record<string, unknown>; init: RequestInit };
function fixture(handler?: (call: Call) => Response | undefined | Promise<Response | undefined>) {
  const calls: Call[] = [];
  const lines: string[] = [];
  let clock = 0;
  let stopping = false;
  const io = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    out: (line: string) => {
      lines.push(line);
    },
    fetch: async (address: string, init: RequestInit) => {
      const url = new URL(address);
      expect(url.origin).toBe("https://smoke.invalid");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-token");
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const call = {
        path: url.pathname.slice("/api/v1/".length) + url.search,
        body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        init,
      };
      calls.push(call);
      if (call.path === "sandbox/launch") stopping = false;
      if (call.path === "sandbox/stop") stopping = true;
      const override = await handler?.(call);
      if (override) return override;
      switch (call.path) {
        case "sandbox/launch":
          return json({ sandbox: { id: "sandbox-id", provider: call.body.provider } });
        case "sandbox/send":
          return json({ promptId: "prompt-id" });
        case "sandbox/wait":
          return json({ prompt: { promptId: "prompt-id", state: "finished" } });
        case "sandbox/exec":
          return json({ exitCode: 0, timedOut: false, stdout: "secret-output", stderr: "secret-error" });
        case "sandbox/stop":
          return json({ status: "stopped" });
        case "sandbox/status":
          return json({ status: stopping ? "stopped" : "ready", providerState: stopping ? "archived" : "active" });
        default:
          throw new Error("Unexpected fake API call");
      }
    },
  };
  return {
    io,
    calls,
    lines,
    receipts: () => lines.map((line) => JSON.parse(line)),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("requires explicit compute opt-in, HTTPS origin, token and bounded valid cases before any API call", async () => {
  for (const override of [
    { ARMADA_SMOKE: "" },
    { ARMADA_URL: "" },
    { ARMADA_TOKEN: "" },
    { ARMADA_URL: "http://smoke.invalid" },
    { ARMADA_URL: "https://secret@smoke.invalid" },
    { ARMADA_URL: "https://smoke.invalid/api" },
    { ARMADA_SMOKE_CASES: "not-json" },
    { ARMADA_SMOKE_CASES: "[]" },
    { ARMADA_SMOKE_CASES: JSON.stringify(Array(9).fill(selected)) },
    { ARMADA_SMOKE_CASES: JSON.stringify([{ ...selected, repo: "relative" }]) },
    { ARMADA_SMOKE_CASES: JSON.stringify([{ ...selected, harness: "unknown" }]) },
  ]) {
    const fake = fixture();
    expect(await postDeploySmoke({ ...env, ...override }, [], fake.io)).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(fake.receipts()[0]).toMatchObject({ step: "configure", pass: false });
    expect(fake.lines.join("")).not.toContain("secret");
  }
});

test("smokes each configured provider/harness through the real API wire contract, including git and provider stop confirmation", async () => {
  const cases = ["boat", "modal"].flatMap((provider) =>
    ["claude", "codex"].map((harness) => ({ ...selected, provider, harness })),
  );
  let provider = "boat";
  let waited = false;
  const fake = fixture((call) => {
    if (call.path === "sandbox/launch") {
      provider = String(call.body.provider);
      waited = false;
    }
    if (call.path === "sandbox/wait" && !waited) {
      waited = true;
      return json({ prompt: { promptId: "prompt-id", state: "running" } });
    }
    if (
      call.path === "sandbox/status" &&
      fake.calls.some(
        (entry) =>
          entry.path === "sandbox/stop" &&
          fake.calls.lastIndexOf(entry) > fake.calls.findLastIndex((entry) => entry.path === "sandbox/launch"),
      )
    )
      return json({ status: "stopped", providerState: provider === "boat" ? "archived" : "stopped" });
  });
  expect(await postDeploySmoke({ ...env, ARMADA_SMOKE_CASES: JSON.stringify(cases) }, [], fake.io)).toBe(true);
  const launches = fake.calls.filter((call) => call.path === "sandbox/launch");
  expect(launches.map((call) => call.body)).toEqual(
    cases.map((item) => ({
      org: item.org,
      golden: item.golden,
      provider: item.provider,
      harness: item.harness,
      model: item.model,
      credentialId: item.modelAccountId,
      connections: [],
      ttlSeconds: 1800,
    })),
  );
  const waits = fake.calls.filter((call) => call.path === "sandbox/wait");
  expect(waits[0]?.body).toEqual({ org: "org", id: "sandbox-id", prompt_id: "prompt-id", timeout_seconds: 0 });
  expect(
    fake.calls.filter((call) => call.path === "sandbox/exec").map((call) => [call.body.command, call.body.cwd]),
  ).toEqual(
    cases.flatMap(() => [
      ["git status -sb", selected.repo],
      ["git ls-remote origin HEAD", selected.repo],
    ]),
  );
  expect(fake.receipts().filter((line) => line.step === "stop" && line.pass)).toHaveLength(4);
  expect(fake.lines.join("")).not.toContain("secret");
});

test("failure paths retain cleanup handles and never emit remote bodies, arbitrary codes or errors", async () => {
  const failures = [
    {
      path: "sandbox/launch",
      response: () => json({ sandbox: { id: "sandbox-id", provider: "unexpected" } }),
      code: "invalid_response",
    },
    {
      path: "sandbox/send",
      response: () => json({ error: { code: "secret_untrusted_code", message: "secret" } }, 500),
      code: "api_failed",
    },
    {
      path: "sandbox/send",
      response: () => json({ error: { code: "forbidden", message: "secret" } }, 403),
      code: "forbidden",
    },
    {
      path: "sandbox/wait",
      response: () => json({ prompt: { promptId: "prompt-id", state: "failed", reason: "secret" } }),
      code: "turn_failed",
      retainedFailure: true,
    },
    {
      path: "sandbox/exec",
      response: () => json({ exitCode: 128, timedOut: false, stderr: "secret" }),
      code: "exec_failed",
    },
    {
      path: "sandbox/exec",
      response: () => {
        throw new Error("secret");
      },
      code: "request_failed",
    },
  ];
  for (const failure of failures) {
    const fake = fixture((call) => {
      if (
        "retainedFailure" in failure &&
        call.path === "sandbox/status" &&
        fake.calls.some((entry) => entry.path === "sandbox/stop")
      )
        return json({ status: "failed", providerState: "archived" });
      return call.path === failure.path ? failure.response() : undefined;
    });
    expect(await postDeploySmoke(env, [], fake.io)).toBe(false);
    expect(fake.calls.some((call) => call.path === "sandbox/stop")).toBe(true);
    expect(fake.calls.at(-1)?.path).toBe("sandbox/status");
    expect(fake.receipts()).toContainEqual(expect.objectContaining({ pass: false, code: failure.code }));
    expect(fake.receipts()).toContainEqual({ case: 0, step: "cleanup_sandbox", pass: true });
    expect(fake.lines.join("")).not.toContain("secret");
  }
});

test("pending turns terminate after bounded polling and cleanup errors remain visible without hiding the first failure", async () => {
  const fake = fixture((call) => {
    if (call.path === "sandbox/wait") return json({ prompt: { promptId: "prompt-id", state: "running" } });
    if (call.path === "sandbox/stop") return json({ error: { code: "unavailable", message: "secret" } }, 503);
  });
  expect(await postDeploySmoke(env, [], fake.io)).toBe(false);
  expect(fake.calls.filter((call) => call.path === "sandbox/wait")).toHaveLength(120);
  expect(fake.receipts().slice(-2)).toEqual([
    { case: 0, step: "wait", pass: false, code: "poll_limit_exceeded" },
    { case: 0, step: "cleanup_sandbox", pass: false, code: "unavailable" },
  ]);
});

test("reserves cleanup time after the overall deadline and rejects a stopped DB row without provider confirmation", async () => {
  for (const [deadline, status] of [
    [true, "stopped"],
    [false, "stopped"],
    [false, "failed"],
  ] as const) {
    const fake = fixture((call) => {
      if (deadline && call.path === "sandbox/send") fake.advance(35 * 60_000);
      if (!deadline && call.path === "sandbox/status" && fake.calls.some((entry) => entry.path === "sandbox/stop"))
        return json({ status, providerState: "active" });
    });
    expect(await postDeploySmoke(env, [], fake.io)).toBe(false);
    expect(fake.calls.some((call) => call.path === "sandbox/stop")).toBe(true);
    expect(fake.receipts()).toContainEqual(
      expect.objectContaining({ pass: false, code: deadline ? "poll_limit_exceeded" : "provider_not_stopped" }),
    );
  }
});

function orchestratorFixture(failure?: "resume" | "create_response" | "turn" | "disabled" | "continuity") {
  let revision = 0;
  let state = "ready";
  let createdName = "";
  const operations: { version: number; id: string; orchestratorId: string; state: string }[] = [];
  const fake = fixture((call) => {
    if (call.path === "sandbox/status" && fake.calls.some((entry) => entry.path === "sandbox/stop"))
      return json({ status: "stopped", providerState: "stopped" });
    if (call.path === "orchestrators/capabilities")
      return json({
        version: 1,
        enabled: failure !== "disabled",
        ...(failure === "disabled"
          ? { reason: "native_conformance_required" }
          : { pairs: [{ provider: "modal", harness: "codex", enabled: true }] }),
      });
    if (call.path.startsWith("orchestrators?") && call.init.method === "GET") {
      const cursor = new URL(`https://smoke.invalid/${call.path}`).searchParams.get("cursor");
      if (!cursor)
        return json({
          version: 1,
          items: [{ id: "old-stopped-id", configuration: { name: "old-smoke" } }],
          cursor: "opaque-next-page",
        });
      expect(cursor).toBe("opaque-next-page");
      return json({
        version: 1,
        items: [{ id: "orchestrator-id", configuration: { name: createdName } }],
        cursor: null,
      });
    }
    if (call.path.startsWith("orchestrators/orchestrator-id/events?"))
      return json({
        version: 1,
        cursor: "cursor",
        hasMore: false,
        events: [
          {
            kind: "agent",
            event: { kind: "prompt", status: failure === "turn" ? "failed" : "finished", reason: "secret" },
          },
        ],
      });
    if (call.path.startsWith("orchestrators/orchestrator-id?"))
      return json({
        version: 1,
        orchestrator: {
          revision,
          state,
          conversationId: "conversation",
          sandboxId: failure === "continuity" && revision >= 4 ? "changed-sandbox" : "orchestrator-sandbox",
          continuity: "native",
        },
        operations,
      });
    if (call.path === "orchestrators" || /^orchestrators\/orchestrator-id\/(message|stop|resume)$/.test(call.path)) {
      if (call.path === "orchestrators") {
        expect(call.body).toMatchObject({
          version: 1,
          orgId: "org",
          goldenId: "golden-id",
          modelAccountId: "account",
          provider: "modal",
          harness: "codex",
        });
        createdName = String(call.body.name);
      } else {
        expect(call.body.orgId).toBe("org");
        expect(call.body.expectedRevision).toBe(revision);
      }
      expect(new Headers(call.init.headers).get("idempotency-key")).toBeTruthy();
      revision++;
      state = call.path.endsWith("/stop") ? "stopped" : "ready";
      const operation = {
        version: 1,
        id: `operation-${revision}`,
        orchestratorId: "orchestrator-id",
        state: "succeeded",
      };
      operations.push(operation);
      if (
        (failure === "resume" && call.path.endsWith("/resume")) ||
        (failure === "create_response" && call.path === "orchestrators")
      )
        throw new Error("secret lost mutation response");
      return json(operation);
    }
  });
  return fake;
}
const orchestratorEnv = { ...env, ARMADA_SMOKE_CASES: JSON.stringify([{ ...selected, provider: "modal" }]) };

test("optional orchestrator lifecycle uses capabilities, CAS fences, idempotency keys, turn outcome and native continuity", async () => {
  const fake = orchestratorFixture();
  expect(await postDeploySmoke(orchestratorEnv, ["--orchestrator"], fake.io)).toBe(true);
  const mutations = fake.calls.filter((call) => call.path.startsWith("orchestrators") && call.init.method === "POST");
  expect(mutations.map((call) => call.path)).toEqual([
    "orchestrators",
    "orchestrators/orchestrator-id/message",
    "orchestrators/orchestrator-id/stop",
    "orchestrators/orchestrator-id/resume",
    "orchestrators/orchestrator-id/stop",
  ]);
  expect(new Set(mutations.map((call) => new Headers(call.init.headers).get("idempotency-key"))).size).toBe(5);
  expect(fake.receipts().at(-1)).toEqual({ case: 0, step: "orchestrator_stop_final", pass: true });
  expect(fake.lines.join("")).not.toContain("secret");
});

test("orchestrator failures clean up after uncertain resume, lost create response and native turn failure without retrying compute mutations", async () => {
  for (const failure of ["resume", "create_response", "turn", "continuity"] as const) {
    const fake = orchestratorFixture(failure);
    expect(await postDeploySmoke(orchestratorEnv, ["--orchestrator"], fake.io)).toBe(false);
    expect(fake.calls.filter((call) => call.path === "orchestrators")).toHaveLength(1);
    if (failure === "create_response")
      expect(fake.calls.filter((call) => call.path.startsWith("orchestrators?"))).toHaveLength(2);
    expect(fake.calls.filter((call) => call.path.endsWith("/resume"))).toHaveLength(
      failure === "resume" || failure === "continuity" ? 1 : 0,
    );
    expect(fake.calls.filter((call) => call.path.endsWith("/stop"))).toHaveLength(
      failure === "resume" || failure === "continuity" ? 3 : 2,
    ); // includes worker stop
    expect(fake.receipts().at(-1)).toEqual({ case: 0, step: "cleanup_orchestrator", pass: true });
    expect(fake.lines.join("")).not.toContain("secret");
  }
});

test("disabled orchestrator service reports a distinct cause before allocating compute", async () => {
  const fake = orchestratorFixture("disabled");
  expect(await postDeploySmoke(orchestratorEnv, ["--orchestrator"], fake.io)).toBe(false);
  expect(fake.calls.map((call) => call.path)).toEqual(["orchestrators/capabilities"]);
  expect(fake.receipts().at(-1)).toEqual({
    case: 0,
    step: "orchestrator_capabilities",
    pass: false,
    code: "orchestrator_disabled",
  });
});

test.each([
  {
    name: "later pair absent",
    capabilities: { version: 1, enabled: true, pairs: [{ provider: "modal", harness: "codex", enabled: true }] },
    code: "pair_disabled",
    index: 1,
  },
  {
    name: "pair enabled flag is not boolean true",
    capabilities: { version: 1, enabled: true, pairs: [{ provider: "modal", harness: "codex", enabled: "true" }] },
    code: "pair_disabled",
    index: 0,
  },
  {
    name: "unsupported version",
    capabilities: { version: 2, enabled: true, pairs: [] },
    code: "invalid_response",
    index: 0,
  },
  {
    name: "pairs is not an array",
    capabilities: { version: 1, enabled: true, pairs: null },
    code: "invalid_response",
    index: 0,
  },
])("preflights $name before allocating any compute", async ({ capabilities, code, index }) => {
  const fake = fixture((call) => (call.path === "orchestrators/capabilities" ? json(capabilities) : undefined));
  expect(
    await postDeploySmoke(
      {
        ...env,
        ARMADA_SMOKE_CASES: JSON.stringify([{ ...selected, provider: "modal" }, selected]),
      },
      ["--orchestrator"],
      fake.io,
    ),
  ).toBe(false);
  expect(fake.calls.map((call) => call.path)).toEqual(["orchestrators/capabilities"]);
  expect(fake.receipts().at(-1)).toEqual({
    case: index,
    pass: false,
    step: "orchestrator_capabilities",
    code,
  });
});

test("capability API failures fail closed without exposing remote bodies", async () => {
  const fake = fixture((call) =>
    call.path === "orchestrators/capabilities"
      ? json({ error: { code: "forbidden", message: "secret" } }, 403)
      : undefined,
  );
  expect(await postDeploySmoke(orchestratorEnv, ["--orchestrator"], fake.io)).toBe(false);
  expect(fake.calls).toHaveLength(1);
  expect(fake.receipts()).toEqual([{ case: 0, step: "orchestrator_capabilities", pass: false, code: "forbidden" }]);
  expect(fake.lines.join("")).not.toContain("secret");
});

test("waits for readiness and retries only rejected sends with bounded injected backoff", async () => {
  let reads = 0;
  let sends = 0;
  const fake = fixture((call) => {
    if (call.path === "sandbox/status" && !sends) return json({ status: ++reads < 3 ? "starting" : "ready" });
    if (call.path === "sandbox/send" && ++sends < 3)
      return json({ error: { code: "sandbox_not_ready", message: "secret" } }, 409);
  });
  expect(await postDeploySmoke(env, [], fake.io)).toBe(true);
  expect(reads).toBe(3);
  expect(sends).toBe(3);
  expect(fake.io.now()).toBe(4000);
  expect(fake.receipts()).toContainEqual({ case: 0, step: "send", pass: true });
});

test("bounds readiness and send rejection polling and still cleans up", async () => {
  for (const phase of ["ready", "send"] as const) {
    const fake = fixture((call) => {
      if (
        phase === "ready" &&
        call.path === "sandbox/status" &&
        !fake.calls.some((entry) => entry.path === "sandbox/stop")
      )
        return json({ status: "starting" });
      if (phase === "send" && call.path === "sandbox/send") return json({ error: { code: "sandbox_not_ready" } }, 409);
    });
    expect(await postDeploySmoke(env, [], fake.io)).toBe(false);
    expect(fake.receipts()).toContainEqual({ case: 0, step: phase, pass: false, code: "poll_limit_exceeded" });
    expect(fake.receipts().at(-1)).toEqual({ case: 0, step: "cleanup_sandbox", pass: true });
    expect(fake.io.now()).toBe(119000);
  }
});

test("reports closed server errors without retrying ambiguous sends", async () => {
  for (const code of ["outcome_unknown", "credential_refused", "provider_unavailable", "dependency_unavailable"]) {
    const fake = fixture((call) =>
      call.path === "sandbox/send" ? json({ error: { code, message: "secret" } }, 503) : undefined,
    );
    expect(await postDeploySmoke(env, [], fake.io)).toBe(false);
    expect(fake.calls.filter((call) => call.path === "sandbox/send")).toHaveLength(1);
    expect(fake.receipts()).toContainEqual({ case: 0, step: "send", pass: false, code });
    expect(fake.lines.join("")).not.toContain("secret");
  }
});

test("unknown stop outcomes are observed once, including Modal checkpoint fallback warnings", async () => {
  for (const unknown of [false, true]) {
    let stopping = false;
    let reads = 0;
    const fake = fixture((call) => {
      if (call.path === "sandbox/stop") {
        stopping = true;
        return unknown
          ? json({ error: { code: "outcome_unknown", message: "secret" } }, 503)
          : json({ status: "stopping", preservationNote: "checkpoint_failed_disk_not_retained" });
      }
      if (call.path === "sandbox/status" && stopping)
        return json({
          status: ++reads < 3 ? "stopping" : "stopped",
          providerState: reads < 3 ? "active" : "stopped",
          preservationNote: unknown ? "checkpoint_failed_disk_not_retained" : null,
        });
    });
    expect(await postDeploySmoke(orchestratorEnv, [], fake.io)).toBe(true);
    expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(1);
    expect(reads).toBe(3);
    expect(fake.receipts()).toContainEqual({
      case: 0,
      step: "stop_warning",
      warning: "checkpoint_failed_disk_not_retained",
    });
    expect(fake.lines.join("")).not.toContain("secret");
  }
});

test("unknown cleanup stops poll failed terminal states and bound unsettled stops", async () => {
  for (const terminal of [true, false]) {
    let stopping = false;
    const fake = fixture((call) => {
      if (call.path === "sandbox/send") return json({ error: { code: "forbidden" } }, 403);
      if (call.path === "sandbox/stop") {
        stopping = true;
        return json({ error: { code: "outcome_unknown" } }, 503);
      }
      if (call.path === "sandbox/status" && stopping)
        return json({ status: terminal ? "failed" : "stopping", providerState: terminal ? "stopped" : "active" });
    });
    expect(await postDeploySmoke(orchestratorEnv, [], fake.io)).toBe(false);
    expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(1);
    expect(fake.receipts().at(-1)).toEqual({
      case: 0,
      step: "cleanup_sandbox",
      pass: terminal,
      ...(terminal ? {} : { code: "poll_limit_exceeded" }),
    });
  }
});

test("exhausted unknown stops reserve cleanup for observation rather than redispatch", async () => {
  let stopping = false;
  const fake = fixture((call) => {
    if (call.path === "sandbox/stop") {
      stopping = true;
      return json({ error: { code: "outcome_unknown" } }, 503);
    }
    if (call.path === "sandbox/status" && stopping) return json({ status: "stopping", providerState: "active" });
  });
  expect(await postDeploySmoke(env, [], fake.io)).toBe(false);
  expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(1);
  expect(fake.receipts()).toContainEqual({ case: 0, step: "stop", pass: false, code: "poll_limit_exceeded" });
  expect(fake.receipts().at(-1)).toEqual({
    case: 0,
    step: "cleanup_sandbox",
    pass: false,
    code: "poll_limit_exceeded",
  });
});

// This is the GitHub Actions scheduling contract, not a simulation of its queue.
test("only eligible smoke jobs compete for staging compute", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(new URL("../.github/workflows/post-deploy-smoke.yml", import.meta.url), "utf8"),
  ) as {
    concurrency?: unknown;
    jobs: { smoke: { if: string; concurrency: { group: string; "cancel-in-progress": boolean } } };
  };
  expect(workflow.concurrency).toBeUndefined();
  expect(workflow.jobs.smoke.if).toContain("github.event.deployment_status.state == 'success'");
  expect(workflow.jobs.smoke.concurrency).toEqual({
    group: "post-deploy-smoke-staging",
    "cancel-in-progress": false,
  });
});

test("GitHub runtime slice requires staging assertions and disposable repository before compute", async () => {
  const valid = {
    ...env,
    ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
    ARMADA_SMOKE_GITHUB_GATE: "true",
    ARMADA_SMOKE_SERVER_REVISION: "a".repeat(40),
    ARMADA_SMOKE_RUNTIME_REVISION: "b".repeat(40),
    ARMADA_SMOKE_CASES: JSON.stringify(
      ["boat", "modal"].flatMap((provider) =>
        ["claude", "codex"].map((harness) => ({
          ...selected,
          provider,
          harness,
          disposableRepository: "https://github.com/smoke/disposable.git",
        })),
      ),
    ),
  };
  for (const overrides of [
    { ARMADA_URL: "https://production.invalid" },
    { ARMADA_SMOKE_GITHUB_GATE: "false" },
    { ARMADA_SMOKE_SERVER_REVISION: "invalid" },
    { ARMADA_SMOKE_RUNTIME_REVISION: "invalid" },
    {
      ARMADA_SMOKE_CASES: JSON.stringify([
        { ...selected, disposableRepository: "https://github.com/smoke/disposable.git" },
      ]),
    },
    {
      ARMADA_SMOKE_CASES: JSON.stringify(
        Array(4).fill({ ...selected, disposableRepository: "https://github.com/smoke/disposable.git" }),
      ),
    },
    { ARMADA_SMOKE_CASES: valid.ARMADA_SMOKE_CASES.replaceAll("https://github.com/", "https://secret@github.com/") },
  ]) {
    const fake = fixture();
    const io = {
      ...fake.io,
      fetch: (url: string, init: RequestInit) => fake.io.fetch(url.replace(valid.ARMADA_URL, env.ARMADA_URL), init),
    };
    expect(await postDeploySmoke({ ...valid, ...overrides }, ["--github-runtime"], io)).toBe(false);
    expect(fake.calls).toHaveLength(0);
  }
});

test("GitHub slice validates native receipts twice and cleans scratch before sandbox even on failure", async () => {
  for (const failReceipt of [false, true]) {
    let provider = "boat";
    let stopping = false;
    const fake = fixture((call) => {
      if (call.path === "sandbox/launch") {
        provider = String(call.body.provider);
        stopping = false;
      }
      if (call.path === "sandbox/stop") stopping = true;
      if (call.path === "sandbox/status")
        return json({
          status: stopping ? "stopped" : "ready",
          providerState: stopping ? (provider === "boat" ? "archived" : "stopped") : "active",
        });
      if (call.path === "sandbox/exec" && String(call.body.command).startsWith("head -c 64 --"))
        return json({ exitCode: 0, timedOut: false, stdout: failReceipt ? "0 128 0" : "0 0 0" });
      return undefined;
    });
    const staging = {
      ...env,
      ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
      ARMADA_SMOKE_GITHUB_GATE: "true",
      ARMADA_SMOKE_SERVER_REVISION: "a".repeat(40),
      ARMADA_SMOKE_RUNTIME_REVISION: "b".repeat(40),
      ARMADA_SMOKE_CASES: JSON.stringify(
        ["boat", "modal"].flatMap((provider) =>
          ["claude", "codex"].map((harness) => ({
            ...selected,
            provider,
            harness,
            repo: "/home/user/it's a repo",
            disposableRepository: "https://github.com/smoke/disposable.git",
          })),
        ),
      ),
    };
    const io = {
      ...fake.io,
      fetch: (url: string, init: RequestInit) => fake.io.fetch(url.replace(staging.ARMADA_URL, env.ARMADA_URL), init),
    };
    expect(await postDeploySmoke(staging, ["--github-runtime"], io)).toBe(!failReceipt);
    const sends = fake.calls.filter((call) => call.path === "sandbox/send");
    expect(sends).toHaveLength(failReceipt ? 4 : 8);
    expect(String(sends[0]?.body.prompt)).toContain("push origin HEAD:refs/heads/armada-runtime-smoke-");
    expect(fake.calls.filter((call) => String(call.body.command).startsWith("head -c 64 --"))).toHaveLength(
      failReceipt ? 4 : 8,
    );
    if (!failReceipt)
      for (const turn of [1, 3, 5, 7]) {
        expect(String(sends[turn]?.body.prompt)).not.toContain("push origin");
        expect(String(sends[turn]?.body.prompt)).toContain("ls-remote origin HEAD");
        expect(String(sends[turn]?.body.prompt)).toContain("git -C '/home/user/it'\\''s a repo'");
      }
    const cleanup = fake.calls.findIndex((call) =>
      String(call.body.command).includes("push origin --delete armada-runtime-smoke-"),
    );
    expect(cleanup).toBeGreaterThan(0);
    expect(fake.calls.findIndex((call) => call.path === "sandbox/stop")).toBeGreaterThan(cleanup);
    expect(fake.lines.join("")).not.toContain("secret");
    expect(fake.receipts()).toContainEqual(
      expect.objectContaining({ step: "native_git_exit_statuses", status: 0, remote: failReceipt ? 128 : 0, push: 0 }),
    );
    expect(fake.receipts()).toContainEqual(
      expect.objectContaining({ step: "scratch_branch_cleanup", outcome: "deleted" }),
    );
    if (!failReceipt)
      expect(fake.receipts()).toContainEqual(
        expect.objectContaining({ step: "enablement", complete: false, renewal: "manual_required" }),
      );
  }
});

test("GitHub failures retain numeric evidence, reject arbitrary receipts, and clean absent scratch after rejected send", async () => {
  for (const scenario of ["send_rejected", "invalid_receipt", "exec_failed"] as const) {
    let provider = "boat";
    let stopping = false;
    const fake = fixture((call) => {
      if (call.path === "sandbox/launch") {
        provider = String(call.body.provider);
        stopping = false;
      }
      if (call.path === "sandbox/stop") stopping = true;
      if (call.path === "sandbox/status")
        return json({
          status: stopping ? "stopped" : "ready",
          providerState: stopping ? (provider === "boat" ? "archived" : "stopped") : "active",
        });
      if (scenario === "send_rejected" && call.path === "sandbox/send")
        return json({ error: { code: "forbidden" } }, 403);
      if (call.path === "sandbox/exec") {
        const command = String(call.body.command);
        if (command.includes("ls-remote --exit-code origin refs/heads/")) return json({ exitCode: 2, timedOut: false });
        if (command.startsWith("head -c 64 --"))
          return json({
            exitCode: 0,
            timedOut: false,
            stdout: scenario === "invalid_receipt" ? "secret-response" : "0 0 0",
          });
        if (scenario === "exec_failed" && command === "git ls-remote origin HEAD")
          return json({ exitCode: 128, timedOut: false, stdout: "secret-response" });
      }
    });
    const staging = {
      ...env,
      ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
      ARMADA_SMOKE_GITHUB_GATE: "true",
      ARMADA_SMOKE_SERVER_REVISION: "a".repeat(40),
      ARMADA_SMOKE_RUNTIME_REVISION: "b".repeat(40),
      ARMADA_SMOKE_CASES: JSON.stringify(
        ["boat", "modal"].flatMap((provider) =>
          ["claude", "codex"].map((harness) => ({
            ...selected,
            provider,
            harness,
            disposableRepository: "https://github.com/smoke/disposable.git",
          })),
        ),
      ),
    };
    const io = {
      ...fake.io,
      fetch: (url: string, init: RequestInit) => fake.io.fetch(url.replace(staging.ARMADA_URL, env.ARMADA_URL), init),
    };
    expect(await postDeploySmoke(staging, ["--github-runtime"], io)).toBe(false);
    expect(fake.calls.some((call) => String(call.body.command).includes("push origin --delete"))).toBe(false);
    expect(fake.receipts().filter((entry) => entry.step === "scratch_branch_cleanup")).toEqual(
      Array.from({ length: 4 }, (_, index) => ({ case: index, step: "scratch_branch_cleanup", outcome: "absent" })),
    );
    expect(fake.receipts().filter((entry) => entry.step === "cleanup_sandbox" && entry.pass)).toHaveLength(4);
    if (scenario === "invalid_receipt")
      expect(fake.receipts()).toContainEqual(expect.objectContaining({ code: "invalid_receipt", pass: false }));
    if (scenario === "exec_failed")
      expect(fake.receipts()).toContainEqual(
        expect.objectContaining({
          step: "exec_git_exit_status",
          operation: "git_remote",
          exitCode: 128,
          timedOut: false,
        }),
      );
    expect(fake.lines.join("")).not.toContain("secret");
  }
});

// Exercises the smoke's verdict, not the product collector (covered in core).
test("preservation checks both providers and rejects missing, wrong or overwritten recovery without leaking material", async () => {
  const directory = mkdtempSync(join(tmpdir(), "armada-smoke-fixture-"));
  function git(...args: string[]) {
    const result = Bun.spawnSync(["git", "-C", directory, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Smoke",
        GIT_AUTHOR_EMAIL: "smoke@example.invalid",
        GIT_COMMITTER_NAME: "Smoke",
        GIT_COMMITTER_EMAIL: "smoke@example.invalid",
      },
    });
    if (result.exitCode !== 0) throw new Error("Fixture Git failed");
    return result.stdout;
  }
  let commit: string;
  let bundle: Buffer;
  try {
    git("init", "--quiet");
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD").toString().trim();
    git("-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "unpushed");
    commit = git("rev-parse", "HEAD").toString().trim();
    bundle = git("bundle", "create", "-", "HEAD", `^${base}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  function archive(head: string, corruptPack = false) {
    const files = {
      "manifest.json": Buffer.from(
        JSON.stringify({
          version: 2,
          repositories: [{ path: selected.repo, directory: "repo-0", head, bundle: true }],
        }),
      ),
      "repo-0/commits.bundle": corruptPack ? bundle.subarray(0, bundle.length - 12) : bundle,
    };
    return Buffer.concat(
      Object.entries(files)
        .flatMap(([name, value]) => {
          const header = Buffer.alloc(512);
          header.write(name);
          header.write(Buffer.byteLength(value).toString(8).padStart(11, "0"), 124);
          return [header, Buffer.from(value), Buffer.alloc((512 - (Buffer.byteLength(value) % 512)) % 512)];
        })
        .concat([Buffer.alloc(1024)]),
    ).toString("base64");
  }
  for (const provider of ["boat", "modal"]) {
    for (const fault of [
      "none",
      "missing",
      "wrong",
      "corrupt",
      "corrupt_pack",
      "clean_note",
      "clean_archive",
      "overwritten",
    ] as const) {
      let launches = 0;
      let stopping = false;
      const fake = fixture((call) => {
        if (call.path === "sandbox/launch") {
          launches++;
          stopping = false;
        }
        if (call.path === "sandbox/stop") stopping = true;
        if (call.path === "sandbox/status")
          return json({
            status: stopping ? "stopped" : "ready",
            providerState: stopping ? (provider === "boat" ? "archived" : "stopped") : "active",
            ...(stopping && launches === 2
              ? {
                  preservationNote:
                    fault === "overwritten"
                      ? "secret-failure"
                      : "unpushed work preserved at work_recovery:sandbox/recovery",
                }
              : {}),
            ...(stopping && fault === "clean_note" && launches === 1 ? { preservationNote: "secret-failure" } : {}),
          });
        if (call.path === "sandbox/exec" && String(call.body.command).includes("commit --allow-empty"))
          return json({ exitCode: 0, timedOut: false, stdout: `${commit}\n` });
        if (call.path === "sandbox/recovery")
          return json({
            archive:
              launches === 1
                ? fault === "clean_archive"
                  ? archive(commit)
                  : null
                : fault === "missing"
                  ? null
                  : fault === "corrupt"
                    ? Buffer.from("secret-invalid").toString("base64")
                    : archive(fault === "wrong" ? "b".repeat(40) : commit, fault === "corrupt_pack"),
          });
      });
      const staging = "https://armada-mcp-staging.up.railway.app";
      const result = await postDeploySmoke(
        {
          ...env,
          ARMADA_URL: staging,
          ARMADA_SMOKE_CASES: JSON.stringify([{ ...selected, provider }]),
        },
        ["--work-preservation"],
        {
          ...fake.io,
          fetch: (url, init) => fake.io.fetch(url.replace(staging, env.ARMADA_URL), init),
        },
      );
      expect(result).toBe(fault === "none");
      expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(2);
      expect(fake.lines.join("")).not.toContain(commit);
      expect(fake.lines.join("")).not.toContain("secret");
      if (fault !== "none")
        expect(fake.receipts()).toContainEqual(expect.objectContaining({ pass: false, code: "preservation_failed" }));
    }
  }
});

test("preservation refuses non-staging origins before requests", async () => {
  const fake = fixture();
  expect(await postDeploySmoke(env, ["--work-preservation"], fake.io)).toBe(false);
  expect(fake.calls).toHaveLength(0);
});
