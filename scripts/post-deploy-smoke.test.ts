import { beforeAll, describe, expect, test } from "bun:test";
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
describe("preservation checks", () => {
  let commit: string;
  let bundle: Buffer;
  beforeAll(() => {
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
  });
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
  const commitCommands = new Set<string>();
  for (const provider of ["boat", "modal"]) {
    for (const fault of [
      "wrong_handle_owner",
      "none",
      "default_policy",
      "default_empty",
      "default_wrong_receipt",
      "default_opt_out_ignored",
      "default_wrong_golden",
      "missing",
      "wrong",
      "corrupt",
      "corrupt_pack",
      "clean_note",
      "clean_archive",
      "overwritten",
      "explicit_missing",
      "selector_ignored",
      "recovery_changes",
      "recovery_wakes",
      "recovery_note_changes",
    ] as const) {
      // Protocol-only negative controls run once; successful reads still cover
      // both providers' distinct physical stopped-state receipts.
      if (
        provider === "modal" &&
        [
          "wrong_handle_owner",
          "default_wrong_receipt",
          "default_opt_out_ignored",
          "default_wrong_golden",
          "explicit_missing",
          "selector_ignored",
          "recovery_changes",
          "recovery_wakes",
          "recovery_note_changes",
        ].includes(fault)
      )
        continue;
      test(`provider=${provider} fault=${fault} validates recovery without leaking material`, async () => {
        const defaults = fault.startsWith("default_");
        const defaultOrg = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const defaultGolden = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const pins = fault === "default_empty" ? [] : ["review@2.0.0", "environment@1.0.0", "notes@3.0.0"];
        const receipts = (values: string[]) =>
          values.map((reference) => ({
            reference,
            version: reference.split("@")[1],
            skillId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            checksum: `sha256:${"a".repeat(64)}`,
            origin: "https://skillpack.app/v1",
          }));
        let launches = 0;
        let stopping = false;
        let sandboxId = "";
        const recoveryId = crypto.randomUUID();
        const otherId = crypto.randomUUID();
        let recoveryReads = 0;
        const fake = fixture((call) => {
          if (call.path === "skills/defaults/get") {
            expect(call.body.org).toBe(defaultOrg);
            if (call.body.scope === "golden") expect(call.body.goldenId).toBe(defaultGolden);
            else expect(call.body).not.toHaveProperty("goldenId");
            const layers: Record<string, string[]> = {
              golden: ["catalog/review@1.0.0", "environment@1.0.0"],
              org: ["review@2.0.0"],
              personal: ["notes@3.0.0"],
            };
            return json({ skills: fault === "default_empty" ? [] : layers[String(call.body.scope)] });
          }
          if (call.path === "sandbox/launch") {
            launches++;
            stopping = false;
            sandboxId = crypto.randomUUID();
            recoveryReads = 0;
            if (defaults) {
              expect(call.body).not.toHaveProperty("skills");
              if (launches === 2) expect(call.body.skipSkillDefaults).toBe(true);
              else expect(call.body).not.toHaveProperty("skipSkillDefaults");
            }
            return json({
              sandbox: {
                id: sandboxId,
                provider,
                ...(defaults
                  ? {
                      skills: receipts(
                        launches === 2 && fault !== "default_opt_out_ignored"
                          ? []
                          : fault === "default_wrong_receipt"
                            ? ["wrong@1.0.0"]
                            : pins,
                      ),
                    }
                  : {}),
              },
              ...(defaults ? { golden: { id: fault === "default_wrong_golden" ? otherId : defaultGolden } } : {}),
            });
          }
          if (call.path === "sandbox/stop") stopping = true;
          if (call.path === "sandbox/status")
            return json({
              status: stopping ? "stopped" : "ready",
              ...(defaults
                ? {
                    skills: receipts(
                      launches === 2 && fault !== "default_opt_out_ignored"
                        ? []
                        : fault === "default_wrong_receipt"
                          ? ["wrong@1.0.0"]
                          : pins,
                    ),
                  }
                : {}),
              providerState: stopping ? (provider === "boat" ? "archived" : "stopped") : "active",
              ...(stopping && launches === 2
                ? {
                    preservationNote:
                      fault === "overwritten"
                        ? "secret-failure"
                        : `unpushed work preserved at work_recovery:${fault === "wrong_handle_owner" ? otherId : sandboxId}/${fault === "recovery_note_changes" && recoveryReads >= 3 ? otherId : recoveryId}`,
                  }
                : {}),
              ...(stopping && fault === "clean_note" && launches === 1 ? { preservationNote: "secret-failure" } : {}),
            });
          if (call.path === "sandbox/exec" && String(call.body.command).includes("commit --allow-empty")) {
            const command = String(call.body.command);
            expect(commitCommands.has(command)).toBe(false);
            commitCommands.add(command);
            return json({ exitCode: 0, timedOut: false, stdout: `${commit}\n` });
          }
          if (call.path === "sandbox/recovery") {
            expect(call.body.id).toBe(sandboxId);
            recoveryReads++;
            if (call.body.recovery_id !== undefined && call.body.recovery_id !== recoveryId)
              return json({ archive: fault === "selector_ignored" ? archive(commit) : null });
            if (fault === "recovery_wakes" && launches === 2 && recoveryReads === 2) stopping = false;
            return json({
              archive:
                launches === 1
                  ? fault === "clean_archive"
                    ? archive(commit)
                    : null
                  : fault === "missing" || (fault === "explicit_missing" && call.body.recovery_id !== undefined)
                    ? null
                    : fault === "corrupt" || (fault === "recovery_changes" && recoveryReads >= 3)
                      ? Buffer.from("secret-invalid").toString("base64")
                      : archive(fault === "wrong" ? "b".repeat(40) : commit, fault === "corrupt_pack"),
            });
          }
        });
        const staging = "https://armada-mcp-staging.up.railway.app";
        const result = await postDeploySmoke(
          {
            ...env,
            ARMADA_URL: staging,
            ARMADA_SMOKE_CASES: JSON.stringify([
              {
                ...selected,
                provider,
                ...(defaults ? { org: defaultOrg.toUpperCase(), goldenId: defaultGolden.toUpperCase() } : {}),
              },
            ]),
          },
          defaults ? ["--work-preservation", "--default-skills"] : ["--work-preservation"],
          {
            ...fake.io,
            fetch: (url, init) => fake.io.fetch(url.replace(staging, env.ARMADA_URL), init),
          },
        );
        const success = ["none", "default_policy", "default_empty"].includes(fault);
        expect(result).toBe(success);
        const stops = fake.calls.filter((call) => call.path === "sandbox/stop").length;
        expect(stops).toBeGreaterThanOrEqual(2);
        expect(stops).toBeLessThanOrEqual(4);
        if (success) {
          expect(stops).toBe(2);
          expect(fake.calls.filter((call) => call.body.recovery_id === recoveryId)).toHaveLength(1);
          expect(fake.calls.filter((call) => call.body.recovery_id !== undefined)).toHaveLength(2);
          expect(fake.receipts()).toContainEqual({ case: 0, step: "preservation_unknown_handle_refused", pass: true });
          expect(fake.receipts()).toContainEqual(
            expect.objectContaining({
              case: 0,
              step: "preservation_cleanup_summary",
              phase: "archive",
              pass: true,
              recoveryId,
              leftoverSandboxIds: [],
              launchOutcomeUnknown: false,
            }),
          );
          expect(fake.receipts()).toContainEqual({ case: 0, step: "preservation_recovery_handle", pass: true });
          expect(
            fake.receipts().filter((line) => line.step === "preservation_recovery_read_only" && line.pass),
          ).toHaveLength(2);
        }
        if (defaults) {
          expect(fake.calls.filter((call) => call.path === "skills/defaults/get")).toHaveLength(3);
          expect(fake.calls.findIndex((call) => call.path === "sandbox/launch")).toBe(3);
          if (success)
            for (const step of ["default_skills_receipts", "default_skills_opt_out_receipts"])
              expect(fake.receipts()).toContainEqual({ case: 0, step, pass: true });
          if (fault === "default_empty")
            expect(fake.receipts()).toContainEqual({
              case: 0,
              step: "default_skills_installation",
              skip: true,
              reason: "no_default_pins_configured",
            });
        }
        expect(fake.lines.join("")).not.toContain(commit);
        expect(fake.lines.join("")).not.toContain("secret");
        if (!success)
          expect(fake.receipts()).toContainEqual(
            expect.objectContaining({
              pass: false,
              code:
                fault === "recovery_wakes"
                  ? "provider_not_stopped"
                  : fault === "default_wrong_golden"
                    ? "invalid_response"
                    : fault.startsWith("default_")
                      ? "invalid_receipt"
                      : "preservation_failed",
            }),
          );
      });
    }
  }
});

test("preservation refuses non-staging origins before requests", async () => {
  const fake = fixture();
  expect(await postDeploySmoke(env, ["--work-preservation"], fake.io)).toBe(false);
  expect(fake.calls).toHaveLength(0);
});

test("template/skill smoke validates the entire staging case configuration before API calls", async () => {
  const valid = { ...selected, publicSkill: "example/public@1.0.0", privateSkill: "private@1.0.0" };
  for (const overrides of [
    { ARMADA_URL: "https://production.invalid", ARMADA_SMOKE_CASES: JSON.stringify([valid]) },
    ...[
      { goldenId: undefined },
      { publicSkill: "public@1.0.0" },
      { publicSkill: "example/public@latest" },
      { privateSkill: "" },
      { privateSkill: "example/private@1.0.0" },
    ].map((invalid) => ({
      ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
      ARMADA_SMOKE_CASES: JSON.stringify([valid, { ...valid, ...invalid }]),
    })),
  ]) {
    const fake = fixture();
    expect(await postDeploySmoke({ ...env, ...overrides }, ["--templates-skills"], fake.io)).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(fake.receipts()).toEqual([{ case: 0, step: "configure", pass: false, code: "invalid_configuration" }]);
  }
});

test.each(["configured", "no_pins", "refused"])(
  "template transport %s cleans workers and reports closed verdicts",
  async (mode) => {
    let value = "";
    let stopped = false;
    const receipt = {
      reference: "example/public@1.0.0",
      version: "1.0.0",
      skillId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      checksum: `sha256:${"a".repeat(64)}`,
      origin: "https://skillpack.app/v1",
    };
    const fake = fixture((call) => {
      switch (call.path) {
        case "creds/list":
          return json({
            user: [{ id: selected.modelAccountId, version: 1, kind: "openai" }],
            orgs: [{ id: selected.org, credentials: [] }],
          });
        case "skillpack/connection":
          return json({ user: [], orgs: [{ id: selected.org, credentials: [] }] });
        case "variables/set":
          value = String(call.body.value);
          return json({ item: { id: "variable-id", version: 1 } });
        case "templates/create":
          return json({ item: { id: "template-id", currentRevision: 1 } });
        case "templates/launch":
          expect(String(call.body.prompt)).not.toContain(value);
          if (mode === "refused")
            return json({
              state: "failed",
              id: "sandbox-id",
              reason: "skillpack_registry_unavailable",
              manifest: { value: "secret-unreported" },
            });
          return json({
            state: "succeeded",
            id: "sandbox-id",
            provider: "boat",
            promptId: "prompt-id",
            manifest: { skillReceipts: [receipt] },
          });
        case "logs/read":
          return json({
            events: [
              {
                id: "answer",
                kind: "message",
                promptId: "prompt-id",
                text: value,
                partial: false,
                responseKind: "assistant",
              },
            ],
            cursor: null,
            hasMore: false,
          });
        case "sandbox/status":
          return json({
            status: stopped ? "stopped" : "ready",
            providerState: stopped ? "archived" : "active",
            skills: [receipt],
          });
        case "sandbox/stop":
          stopped = true;
          return json({ status: "stopping" });
        case "templates/delete":
        case "variables/delete":
          return json({ item: { status: "deleted" } });
      }
    });
    const staging = "https://armada-mcp-staging.up.railway.app";
    expect(
      await postDeploySmoke(
        {
          ...env,
          ARMADA_URL: staging,
          ARMADA_SMOKE_CASES: JSON.stringify([
            {
              ...selected,
              ...(mode === "no_pins" ? {} : { publicSkill: receipt.reference, privateSkill: "private@1.0.0" }),
            },
          ]),
        },
        ["--templates-skills"],
        {
          ...fake.io,
          fetch: (url, init) => fake.io.fetch(url.replace(staging, env.ARMADA_URL), init),
        },
      ),
    ).toBe(mode !== "refused");
    expect(fake.calls.some((call) => call.path === "sandbox/launch")).toBe(false);
    expect(fake.calls.map((call) => call.path).slice(-3)).toEqual([
      "sandbox/status",
      "templates/delete",
      "variables/delete",
    ]);
    if (mode === "refused")
      expect(fake.receipts()).toContainEqual({
        case: 0,
        step: "template_launch",
        pass: false,
        code: "template_launch_failed",
        state: "failed",
        reason: "skillpack_registry_unavailable",
      });
    else
      expect(fake.receipts()).toContainEqual({
        case: 0,
        step: "private_skill",
        skip: true,
        reason: mode === "no_pins" ? "skill_pin_not_configured" : "skillpack_key_not_configured",
      });
    expect(fake.lines.join("")).not.toContain("secret-unreported");
    expect(fake.lines.join("")).not.toContain(value);
  },
);

test("default probes require the shared worker pair and validate every UUID before any traffic", async () => {
  const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const goldenId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  for (const config of [
    { args: ["--default-skills"], cases: [{ ...selected, org, goldenId }] },
    {
      args: ["--default-skills", "--work-preservation"],
      cases: [
        { ...selected, org, goldenId },
        { ...selected, org, goldenId: "invalid" },
      ],
    },
    { args: ["--default-skills", "--work-preservation"], cases: [{ ...selected, org: "invalid", goldenId }] },
  ]) {
    const fake = fixture();
    expect(
      await postDeploySmoke(
        {
          ...env,
          ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
          ARMADA_SMOKE_CASES: JSON.stringify(config.cases),
        },
        config.args,
        fake.io,
      ),
    ).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(fake.receipts()).toEqual([{ case: 0, step: "configure", pass: false, code: "invalid_configuration" }]);
  }
});

test("a merged default policy overflow has a closed failure line before allocation", async () => {
  const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const goldenId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const fake = fixture((call) => {
    if (call.path === "skills/defaults/get")
      return json({ skills: Array.from({ length: 7 }, (_, i) => `${String(call.body.scope)}-${i}@1.0.0`) });
  });
  const staging = "https://armada-mcp-staging.up.railway.app";
  expect(
    await postDeploySmoke(
      { ...env, ARMADA_URL: staging, ARMADA_SMOKE_CASES: JSON.stringify([{ ...selected, org, goldenId }]) },
      ["--work-preservation", "--default-skills"],
      {
        ...fake.io,
        fetch: (url, init) => fake.io.fetch(url.replace(staging, env.ARMADA_URL), init),
      },
    ),
  ).toBe(false);
  expect(fake.calls).toHaveLength(3);
  expect(fake.calls.every((call) => call.path === "skills/defaults/get")).toBe(true);
  expect(fake.receipts()).toContainEqual({
    case: 0,
    step: "default_skills_policy",
    pass: false,
    code: "invalid_response",
  });
});

type LifecycleFault =
  | "none"
  | "steer_admitted"
  | "wrong_steer_status"
  | "bad_extension"
  | "list_mismatch"
  | "lost_resume"
  | "stop_failed"
  | "lost_launch";
function lifecycleFixture(fault: LifecycleFault = "none") {
  let provider = "boat";
  let harness = "codex";
  let id = "";
  let launches = 0;
  let sends = 0;
  let stops = 0;
  let stopped = false;
  let readiness = 0;
  let expiry = "";
  const fake = fixture((call) => {
    if (call.path === "sandbox/launch") {
      launches++;
      provider = String(call.body.provider);
      harness = String(call.body.harness);
      id = `life-${launches}`;
      sends = 0;
      stops = 0;
      stopped = false;
      readiness = 0;
      fake.advance(500);
      expiry = new Date(fake.io.now() + 1800_000).toISOString();
      if (fault === "lost_launch") throw new Error("secret launch outcome");
      return json({ sandbox: { id, provider } });
    }
    if (call.path.startsWith("sandbox/") && !["sandbox/list", "sandbox/launch"].includes(call.path))
      expect(call.body.id).toBe(id);
    if (call.path === "sandbox/status")
      return json({
        id,
        harness,
        status: stopped ? "stopped" : !sends && ++readiness === 1 ? "starting" : "ready",
        providerState: stopped ? (provider === "boat" ? "archived" : "stopped") : "active",
        expiresAt: expiry,
      });
    if (call.path === "sandbox/send") {
      sends++;
      stopped = false;
      if (sends === 2 && fault === "lost_resume") throw new Error("secret lost resume receipt");
      return json({ promptId: `turn-${sends}` });
    }
    if (call.path === "sandbox/wait") return json({ prompt: { promptId: call.body.prompt_id, state: "finished" } });
    if (call.path === "sandbox/steer")
      return fault === "steer_admitted"
        ? json({ promptId: "unwanted" })
        : json(
            { error: { code: "no_running_turn", message: "secret refusal detail" } },
            fault === "wrong_steer_status" ? 400 : 409,
          );
    if (call.path === "sandbox/extend") {
      expect(call.body.ttl_seconds).toBe(1860);
      const next = new Date(Date.parse(expiry) + 60_000).toISOString();
      if (fault !== "bad_extension") expiry = next;
      return json({ id, expiresAt: expiry, ttlSeconds: 1860 });
    }
    if (call.path === "sandbox/list") {
      expect(call.body.owner).toBe("me");
      expect(call.body.harness).toBe(harness);
      expect(call.body.limit).toBe(200);
      return call.body.page === 1
        ? json({ sandboxes: [], page: 1, hasMore: true, nextPage: 2 })
        : json({
            sandboxes: [
              {
                id,
                provider,
                harness,
                status: fault === "list_mismatch" ? "running" : stopped ? "stopped" : "ready",
                expiresAt: expiry,
              },
            ],
            page: 2,
            hasMore: false,
            nextPage: null,
          });
    }
    if (call.path === "sandbox/stop") {
      stops++;
      if (fault === "stop_failed" && stops > 1) throw new Error("secret stop failure");
      stopped = true;
      return json({ status: "stopping" });
    }
  });
  const run = (cases: object[] = [selected]) =>
    postDeploySmoke(
      {
        ...env,
        ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
        ARMADA_SMOKE_CASES: JSON.stringify(cases),
      },
      ["--lifecycle"],
      {
        ...fake.io,
        fetch: (url, init) =>
          fake.io.fetch(url.replace("https://armada-mcp-staging.up.railway.app", env.ARMADA_URL), init),
      },
    );
  return { ...fake, run };
}

test("lifecycle records readiness and confirms extend/list, closed idle steer refusal and send-after-stop on every selected pair", async () => {
  const fake = lifecycleFixture();
  const cases = ["boat", "modal"].flatMap((provider) =>
    ["claude", "codex"].map((harness) => ({ ...selected, provider, harness })),
  );
  expect(await fake.run(cases)).toBe(true);
  expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(4);
  expect(fake.calls.filter((call) => call.path === "sandbox/send")).toHaveLength(8);
  expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(8);
  expect(fake.calls.filter((call) => call.path === "sandbox/steer")).toHaveLength(4);
  for (const [index, item] of cases.entries()) {
    expect(fake.receipts()).toContainEqual({
      case: index,
      step: "time_to_ready",
      pass: true,
      provider: item.provider,
      harness: item.harness,
      elapsedMs: 1500,
    });
    for (const step of [
      "list_ready",
      "steer_refused",
      "extend",
      "list_stopped",
      "resume_send",
      "resume_wait",
      "list_resumed",
      "stop_resumed",
      "list_stopped_final",
    ])
      expect(fake.receipts()).toContainEqual({ case: index, step, pass: true });
  }
  expect(fake.receipts().filter((line) => line.step === "lifecycle_cleanup_summary")).toHaveLength(4);
  expect(
    fake
      .receipts()
      .filter((line) => line.step === "lifecycle_cleanup_summary")
      .every((line) => line.pass && !line.leftoverSandboxIds.length && !line.launchOutcomeUnknown),
  ).toBe(true);
  expect(fake.lines.join("")).not.toContain("secret");
});

test("lifecycle failures reject false receipts and report unknown launches or leftover IDs without replaying resume", async () => {
  for (const fault of [
    "steer_admitted",
    "wrong_steer_status",
    "bad_extension",
    "list_mismatch",
    "lost_resume",
    "stop_failed",
    "lost_launch",
  ] as const) {
    const fake = lifecycleFixture(fault);
    expect(await fake.run()).toBe(false);
    const summary = fake.receipts().find((line) => line.step === "lifecycle_cleanup_summary");
    expect(summary).toBeDefined();
    expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(1);
    if (fault === "lost_resume") {
      expect(fake.calls.filter((call) => call.path === "sandbox/send")).toHaveLength(2);
      expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(2);
      expect(summary.pass).toBe(true);
    }
    if (fault === "stop_failed") {
      expect(summary.pass).toBe(false);
      expect(summary.leftoverSandboxIds).toEqual(["life-1"]);
    }
    if (fault === "lost_launch") {
      expect(summary.pass).toBe(false);
      expect(summary.launchOutcomeUnknown).toBe(true);
    }
    expect(fake.lines.join("")).not.toContain("secret");
  }
});
