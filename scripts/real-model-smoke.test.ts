import { expect, spyOn, test } from "bun:test";
import { promptFailureReason } from "../packages/core/src/native-failure.ts";
import { RUNTIME_STARTUP_FAILURES } from "../packages/core/src/runtime-startup-failure.ts";
import { postDeploySmoke } from "./post-deploy-smoke.ts";
import deadlineTable from "./smoke-deadlines.json";
import { deadlinesFor } from "./smoke-deadlines.ts";
import { STAGING_ORIGIN } from "./smoke-sandbox-cleanup.ts";

const id = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const modal = {
  provider: "modal",
  harness: "codex",
  org: id(1),
  modelAccountId: id(2),
  model: "real-model",
  golden: "staging-golden",
  repo: "/tmp/repo",
};
const docker = { ...modal, provider: "docker", modelAccountId: id(3), hostId: id(4) };
const env = {
  ARMADA_URL: STAGING_ORIGIN,
  ARMADA_SMOKE: "create_real_compute",
  ARMADA_TOKEN: "placeholder",
  ARMADA_SMOKE_CASES: JSON.stringify([modal, docker]),
};

test.each([
  { scenario: "finished with complete text", state: "finished", code: undefined },
  { scenario: "recovered Docker launch receipt", state: "finished", code: undefined },
  { scenario: "authentication refusal", state: "failed", code: "model_authentication_refused" },
  { scenario: "model timeout", state: "running", code: "model_timeout" },
  { scenario: "wait request reaches the model deadline", state: "running", code: "model_timeout" },
  { scenario: "finished without complete text", state: "finished", code: "invalid_receipt" },
])("real-model staging smoke handles $scenario and stops both sandboxes", async ({ scenario, state, code }) => {
  const budgets = (provider: string) => deadlinesFor(deadlineTable, provider, "real-model");
  const timeouts = new Map<string, number[]>();
  const timeout = spyOn(AbortSignal, "timeout");
  let now = 0;
  const launches: { provider: string; credentialId: string }[] = [];
  let dockerAllocation: { id: string; externalRef: string } | undefined;
  const sent: string[] = [];
  let modalSetupReads = 0;
  let modalStopReads = 0;
  const stopped = new Set<string>();
  const receipts: Record<string, unknown>[] = [];
  const passed = await postDeploySmoke(env, ["--real-model"], {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    out: (line) => {
      if (line.startsWith("{")) receipts.push(JSON.parse(line));
    },
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body));
      const path = new URL(url).pathname;
      const request = path.endsWith("/status") && stopped.has(body.id) ? "stop-confirmation" : path.split("/").at(-1)!;
      const signalIndex = timeout.mock.results.findIndex((result) => result.value === init.signal);
      const budget = timeout.mock.calls[signalIndex]?.[0];
      if (budget !== undefined) {
        const values = timeouts.get(request) ?? [];
        values.push(budget);
        timeouts.set(request, values);
      }
      switch (path) {
        case "/api/v1/sandbox/launch":
          if (body.provider === "docker") {
            expect(body.idempotencyKey).toBe(body.externalRef);
            expect(body).not.toHaveProperty("requestId");
          }
          launches.push({ provider: body.provider, credentialId: body.credentialId });
          if (body.provider === "docker" && scenario === "recovered Docker launch receipt") {
            dockerAllocation = { id: id(7), externalRef: body.externalRef };
            return Response.json({ sandbox: { id: id(6), provider: "docker", externalRef: "different-launch" } });
          }
          if (body.provider === "modal" && scenario === "finished with complete text") {
            return Response.json({ sandbox: { id: id(5), status: "starting" } });
          }
          return Response.json({
            sandbox: {
              id: body.provider === "docker" ? id(7) : id(5),
              provider: body.provider,
              externalRef: body.externalRef,
            },
          });
        case "/api/v1/sandbox/list":
          expect(body.externalRef).toBe(dockerAllocation?.externalRef);
          return Response.json({ sandboxes: [{ ...dockerAllocation, provider: "docker", status: "ready" }] });
        case "/api/v1/sandbox/status":
          if (body.id === id(5) && scenario === "finished with complete text" && !stopped.has(body.id)) {
            const pending = ++modalSetupReads === 1;
            return Response.json({
              status: pending ? "starting" : "ready",
            });
          }
          if (body.id === id(5) && scenario === "finished with complete text" && ++modalStopReads === 1)
            return Response.json({ status: "failed", providerState: null });
          return Response.json(
            stopped.has(body.id) ? { status: "stopped", providerState: "stopped" } : { status: "ready" },
          );
        case "/api/v1/sandbox/send":
          if (body.id === id(5) && modalSetupReads === 1)
            return Response.json({ error: { code: "conflict" } }, { status: 409 });
          sent.push(body.id);
          return Response.json({ promptId: body.id });
        case "/api/v1/sandbox/wait":
          if (scenario === "wait request reaches the model deadline") {
            now += budgets(body.id === id(7) ? "docker" : "modal").real_model_wait ?? 120_000;
            throw new DOMException("Timed out", "TimeoutError");
          }
          return Response.json({
            prompt: {
              promptId: body.id,
              state,
              reason: state === "failed" ? promptFailureReason("authentication_failed:authentication") : null,
            },
          });
        case "/api/v1/logs/read":
          return Response.json({
            events: [
              { kind: "message", promptId: "different-turn", partial: false, text: "Unrelated" },
              { kind: "message", promptId: body.id, partial: true, text: "Partial" },
              {
                kind: "message",
                promptId: body.id,
                partial: false,
                text: code === undefined ? "Hello there" : "  ",
              },
            ],
          });
        case "/api/v1/sandbox/stop":
          stopped.add(body.id);
          if (scenario === "finished with complete text") {
            now += 100;
            return Response.json({ id: body.id, status: body.id === id(5) ? "stopping" : "stopped" });
          }
          return Response.json({});
        default:
          throw new Error(`Unexpected request ${url}`);
      }
    },
  }).finally(() => timeout.mockRestore());
  if (scenario === "finished with complete text") {
    const providers = ["modal", "docker"];
    for (const [request, step, fallback] of [
      ["launch", "real_model_launch", 600_000],
      ["send", "real_model_send", 120_000],
      ["wait", "real_model_wait", 120_000],
      ["stop", "real_model_stop", 120_000],
    ] as const) {
      expect(timeouts.get(request)?.toSorted()).toEqual(
        providers.map((provider) => budgets(provider)[step] ?? fallback).toSorted(),
      );
    }
    const confirmations = timeouts.get("stop-confirmation")!;
    expect(modalSetupReads).toBe(2);
    const readyBudget = budgets("modal").real_model_ready!;
    expect(timeouts.get("status")?.toSorted()).toEqual(
      [readyBudget, readyBudget - 1000, budgets("docker").real_model_ready ?? 120_000].toSorted(),
    );
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]).toBe(confirmations[0]! - 1000);
    const stopBudget = budgets("modal").real_model_stop;
    if (stopBudget === undefined) expect(confirmations[0]).toBe(120_000);
    else {
      expect(confirmations[0]).toBeGreaterThan(0);
      expect(confirmations[0]).toBeLessThanOrEqual(stopBudget - 100);
    }
  } else {
    expect(timeouts.get("stop-confirmation")).toHaveLength(2);
  }
  expect(passed).toBe(code === undefined);
  expect(launches).toEqual([
    { provider: "modal", credentialId: modal.modelAccountId },
    { provider: "docker", credentialId: docker.modelAccountId },
  ]);
  expect([...sent].sort()).toEqual([id(5), id(7)]);
  if (dockerAllocation) {
    expect(stopped.has(dockerAllocation.id)).toBe(true);
    expect(stopped.has(id(6))).toBe(false);
  }
  expect([...stopped].sort()).toEqual([...sent].sort());
  expect(receipts.filter((row) => row.model === "real").map((row) => row.provider)).toEqual(["modal", "docker"]);
  expect(receipts.filter((row) => row.step === "real_model_wait").map((row) => row.code)).toEqual([code, code]);
});

test("real-model staging smoke refuses a missing provider before allocating", async () => {
  const receipts: Record<string, unknown>[] = [];
  expect(
    await postDeploySmoke({ ...env, ARMADA_SMOKE_CASES: JSON.stringify([modal]) }, ["--real-model"], {
      now: () => 0,
      sleep: async () => {
        throw new Error("Unexpected sleep");
      },
      out: (line) => {
        if (line.startsWith("{")) receipts.push(JSON.parse(line));
      },
      fetch: async () => {
        throw new Error("Unexpected request");
      },
    }),
  ).toBe(false);
  expect(receipts).toEqual([{ case: 0, step: "configure", pass: false, code: "invalid_configuration" }]);
});

test.each([
  {
    scenario: "terminal status",
    response: () =>
      Response.json({
        status: "failed",
        providerState: "private_diagnostic_placeholder",
        statusReason: RUNTIME_STARTUP_FAILURES.artifact_integrity,
      }),
    evidence: {
      source: "status_body",
      statusResponse: { status: "failed", providerState: "string", statusReason: "artifact_integrity" },
    },
  },
  {
    scenario: "API refusal",
    response: () =>
      Response.json(
        { error: { code: "sandbox_not_ready", message: "private_diagnostic_placeholder" } },
        { status: 409, headers: { "x-request-id": id(9) } },
      ),
    evidence: { source: "status_api", httpStatus: 409, requestId: id(9) },
  },
])("real-model readiness attributes $scenario after observing starting", async ({ response, evidence }) => {
  let now = 0;
  let dockerReads = 0;
  const receipts: Record<string, unknown>[] = [];
  const passed = await postDeploySmoke(env, ["--real-model"], {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    out: (line) => {
      if (line.startsWith("{")) receipts.push(JSON.parse(line));
    },
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body));
      switch (new URL(url).pathname) {
        case "/api/v1/sandbox/launch":
          return Response.json({
            sandbox: {
              id: body.provider === "docker" ? id(7) : id(5),
              status: "starting",
              provider: body.provider,
              externalRef: body.externalRef,
            },
          });
        case "/api/v1/sandbox/status":
          if (body.id === id(5)) return Response.json({ status: "ready" });
          return ++dockerReads === 1 ? Response.json({ status: "starting" }) : response();
        case "/api/v1/sandbox/send":
          expect(body.id).toBe(id(5));
          return Response.json({ promptId: id(8) });
        case "/api/v1/sandbox/wait":
          return Response.json({ prompt: { promptId: id(8), state: "finished" } });
        case "/api/v1/logs/read":
          return Response.json({
            events: [{ kind: "message", promptId: id(8), partial: false, text: "Hello" }],
          });
        case "/api/v1/sandbox/stop":
          return Response.json({ id: body.id, status: "stopped" });
        default:
          throw new Error(`Unexpected request ${url}`);
      }
    },
  });
  expect(passed).toBe(false);
  expect(receipts.filter((row) => row.step === "readiness_diagnostic")).toEqual([
    {
      case: 1,
      lane: "real-model",
      provider: "docker",
      step: "readiness_diagnostic",
      readinessStep: "real_model_ready",
      sandboxId: id(7),
      observedStarting: true,
      code: "sandbox_not_ready",
      ...evidence,
    },
  ]);
  expect(JSON.stringify(receipts)).not.toContain("private_diagnostic_placeholder");
  expect(receipts).toContainEqual(
    expect.objectContaining({
      provider: "docker",
      step: "real_model_ready",
      pass: false,
      code: "sandbox_not_ready",
    }),
  );
  expect(
    receipts
      .filter((row) => row.step === "real_model_stop" && row.pass)
      .map((row) => row.provider)
      .sort(),
  ).toEqual(["docker", "modal"]);
  expect(receipts).toContainEqual(expect.objectContaining({ provider: "modal", step: "real_model_wait", pass: true }));
});
