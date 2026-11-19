import { expect, test } from "bun:test";
import { promptFailureReason } from "../packages/core/src/native-failure.ts";
import { postDeploySmoke } from "./post-deploy-smoke.ts";
import deadlines from "./smoke-deadlines.json";
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
  let now = 0;
  const launches: { provider: string; credentialId: string }[] = [];
  let dockerAllocation: { id: string; externalRef: string } | undefined;
  const sent: string[] = [];
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
      switch (new URL(url).pathname) {
        case "/api/v1/sandbox/launch":
          launches.push({ provider: body.provider, credentialId: body.credentialId });
          if (body.provider === "docker" && scenario === "recovered Docker launch receipt") {
            dockerAllocation = { id: body.requestId, externalRef: body.externalRef };
            return Response.json({ sandbox: { id: id(6) } });
          }
          return Response.json({
            sandbox: { id: body.provider === "docker" ? body.requestId : id(5), provider: body.provider },
          });
        case "/api/v1/sandbox/list":
          expect(body.externalRef).toBe(dockerAllocation?.externalRef);
          return Response.json({ sandboxes: [{ ...dockerAllocation, provider: "docker", status: "ready" }] });
        case "/api/v1/sandbox/status":
          return Response.json(
            stopped.has(body.id) ? { status: "stopped", providerState: "stopped" } : { status: "ready" },
          );
        case "/api/v1/sandbox/send":
          sent.push(body.id);
          return Response.json({ promptId: body.id });
        case "/api/v1/sandbox/wait":
          if (scenario === "wait request reaches the model deadline") {
            now += deadlines.wait;
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
          return Response.json({});
        default:
          throw new Error(`Unexpected request ${url}`);
      }
    },
  });
  expect(passed).toBe(code === undefined);
  expect(launches).toEqual([
    { provider: "modal", credentialId: modal.modelAccountId },
    { provider: "docker", credentialId: docker.modelAccountId },
  ]);
  expect(sent).toHaveLength(2);
  if (dockerAllocation) expect(stopped.has(dockerAllocation.id)).toBe(true);
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
