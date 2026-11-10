import { expect, test } from "bun:test";
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
          return json({ status: "stopped", providerState: "archived" });
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
    if (call.path === "sandbox/status")
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
    const fake = fixture((call) => (call.path === failure.path ? failure.response() : undefined));
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
  for (const deadline of [true, false]) {
    const fake = fixture((call) => {
      if (deadline && call.path === "sandbox/send") fake.advance(35 * 60_000);
      if (!deadline && call.path === "sandbox/status") return json({ status: "stopped", providerState: "active" });
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
    if (call.path === "sandbox/status") return json({ status: "stopped", providerState: "stopped" });
    if (call.path === "orchestrators/capabilities")
      return json({
        version: 1,
        enabled: failure !== "disabled",
        pairs: [{ provider: "modal", harness: "codex", enabled: true }],
      });
    if (call.path.startsWith("orchestrators?") && call.init.method === "GET") {
      return json({ version: 1, items: [{ id: "orchestrator-id", configuration: { name: createdName } }] });
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

test("disabled orchestrator pair fails without allocating an orchestrator", async () => {
  const fake = orchestratorFixture("disabled");
  expect(await postDeploySmoke(orchestratorEnv, ["--orchestrator"], fake.io)).toBe(false);
  expect(fake.calls.some((call) => call.path === "orchestrators")).toBe(false);
  expect(fake.receipts().at(-1)).toEqual({
    case: 0,
    step: "orchestrator_capabilities",
    pass: false,
    code: "pair_disabled",
  });
});
