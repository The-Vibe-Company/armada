import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedQueue, createLaunchTracker, postDeploySmoke } from "./post-deploy-smoke.ts";
import deadlines from "./smoke-deadlines.json";

const boatNotice = "boat: not part of the release gate";

const selected = {
  provider: "modal",
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
const sandboxFixtureId = "f0000000-0000-4000-8000-000000000000";
const lifecycleId = (sequence: number) => `f0000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
const json = (body: unknown, status = 200) => Response.json(body, { status });
type Call = { path: string; body: Record<string, unknown>; init: RequestInit };
function fixture(handler?: (call: Call) => Response | undefined | Promise<Response | undefined>) {
  const calls: Call[] = [];
  const lines: string[] = [];
  let clock = 0;
  let stopping = false;
  const promptsBySandbox = new Map<unknown, string>();
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
      if (call.path === "sandbox/wait") promptsBySandbox.set(call.body.id, String(call.body.prompt_id));
      const override = await handler?.(call);
      if (override) {
        if (call.path === "sandbox/status" && override.ok) {
          const body = (await override.clone().json()) as Record<string, unknown>;
          if (!Object.hasOwn(body, "usage"))
            return json({
              ...body,
              usage: {
                turns: [
                  { promptId: promptsBySandbox.get(call.body.id) ?? "prompt-id", inputTokens: 10, outputTokens: 2 },
                ],
                tokenTotals: { inputTokens: 10, outputTokens: 2 },
              },
            });
        }
        return override;
      }
      switch (call.path) {
        case "sandbox/launch":
          return json({ sandbox: { id: sandboxFixtureId, provider: call.body.provider } });
        case "sandbox/send":
          return json({ promptId: "prompt-id" });
        case "sandbox/wait":
          return json({ prompt: { promptId: "prompt-id", state: "finished" } });
        case "sandbox/exec":
          return json({ exitCode: 0, timedOut: false, stdout: "secret-output", stderr: "secret-error" });
        case "sandbox/stop":
          return json({ status: "stopped" });
        case "sandbox/status":
          return json({
            status: stopping ? "stopped" : "ready",
            providerState: stopping ? "stopped" : "active",
            usage: {
              turns: [{ promptId: "prompt-id", inputTokens: 10, outputTokens: 2 }],
              tokenTotals: { inputTokens: 10, outputTokens: 2 },
            },
          });
        default:
          throw new Error("Unexpected fake API call");
      }
    },
  };
  return {
    io,
    calls,
    lines,
    // Protocol assertions below ignore additive per-step telemetry; timing and lanes have their own contract tests.
    receipts: () =>
      lines
        .filter((line) => line !== boatNotice)
        .map((line) => {
          const receipt = JSON.parse(line);
          if (!receipt.step.endsWith("_summary") && receipt.step !== "time_to_ready") delete receipt.elapsedMs;
          delete receipt.lane;
          return receipt;
        }),
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
  // Distinct orgs keep each concurrent case lane's fake state apart.
  const cases = ["modal"].flatMap((provider) =>
    ["claude", "codex"].map((harness) => ({ ...selected, provider, harness, org: `org-${harness}` })),
  );
  const waited = new Set<unknown>();
  const fake = fixture((call) => {
    const org = call.body.org;
    const mine = fake.calls.filter((entry) => entry.body.org === org);
    if (call.path === "sandbox/launch") waited.delete(org);
    if (call.path === "sandbox/wait" && !waited.has(org)) {
      waited.add(org);
      return json({ prompt: { promptId: "prompt-id", state: "running" } });
    }
    if (
      call.path === "sandbox/status" &&
      mine.findLastIndex((entry) => entry.path === "sandbox/stop") >
        mine.findLastIndex((entry) => entry.path === "sandbox/launch")
    )
      return json({ status: "stopped", providerState: "stopped" });
    if (call.path === "sandbox/status") return json({ status: "ready", providerState: "active" });
  });
  expect(await postDeploySmoke({ ...env, ARMADA_SMOKE_CASES: JSON.stringify(cases) }, [], fake.io)).toBe(true);
  const launches = fake.calls.filter((call) => call.path === "sandbox/launch");
  expect(launches.map(({ body: { idempotencyKey: _, externalRef: __, ...body } }) => body)).toEqual(
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
  for (const item of cases) {
    const mine = fake.calls.filter((call) => call.body.org === item.org);
    expect(mine.find((call) => call.path === "sandbox/wait")?.body).toEqual({
      org: item.org,
      id: sandboxFixtureId,
      prompt_id: "prompt-id",
      timeout_seconds: 0,
    });
    expect(
      mine.filter((call) => call.path === "sandbox/exec").map((call) => [call.body.command, call.body.cwd]),
    ).toEqual([
      ["git status -sb", selected.repo],
      ["git ls-remote origin HEAD", selected.repo],
    ]);
  }
  expect(fake.receipts().filter((line) => line.step === "stop" && line.pass)).toHaveLength(2);
  expect(fake.lines.join("")).not.toContain("secret");
});

test("ignores malformed Boat cases before field validation and prints the staging owner decision once", async () => {
  const fake = fixture();
  expect(
    await postDeploySmoke(
      {
        ...env,
        ARMADA_SMOKE_CASES: JSON.stringify([
          { provider: "boat", harness: null, repo: "relative" },
          selected,
          { provider: "boat" },
        ]),
      },
      [],
      fake.io,
    ),
  ).toBe(true);
  expect(fake.lines.filter((line) => line === boatNotice)).toHaveLength(1);
  expect(fake.calls.filter((call) => call.path === "sandbox/launch").map((call) => call.body.provider)).toEqual([
    "modal",
  ]);
  expect(fake.calls.some((call) => call.body.provider === "boat")).toBe(false);
  expect(fake.receipts()).toContainEqual(expect.objectContaining({ step: "stop", pass: true }));
});

test("failure paths retain cleanup handles and never emit remote bodies, arbitrary codes or errors", async () => {
  const failures = [
    {
      path: "sandbox/launch",
      response: () => json({ sandbox: { id: sandboxFixtureId, provider: "modal" }, promptId: "unexpected" }),
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
        return json({ status: "failed", providerState: "stopped" });
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

test("pending turns terminate at the measured deadline and cleanup errors remain visible", async () => {
  const fake = fixture((call) => {
    if (call.path === "sandbox/wait") return json({ prompt: { promptId: "prompt-id", state: "running" } });
    if (call.path === "sandbox/stop") return json({ error: { code: "unavailable", message: "secret" } }, 503);
  });
  expect(await postDeploySmoke(env, [], fake.io)).toBe(false);
  expect(fake.calls.filter((call) => call.path === "sandbox/wait")).toHaveLength(Math.ceil(deadlines.wait / 1000));
  expect(fake.io.now()).toBe(deadlines.wait);
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

const modalEnv = { ...env, ARMADA_SMOKE_CASES: JSON.stringify([{ ...selected, provider: "modal" }]) };

test("waits for readiness and retries only rejected sends with bounded injected backoff", async () => {
  let reads = 0;
  let sends = 0;
  const fake = fixture((call) => {
    if (call.path === "sandbox/status" && !sends) return json({ status: ++reads < 2 ? "starting" : "ready" });
    if (call.path === "sandbox/send" && ++sends < 2)
      return json({ error: { code: "sandbox_not_ready", message: "secret" } }, 409);
  });
  expect(await postDeploySmoke(env, [], fake.io)).toBe(true);
  expect(reads).toBe(2);
  expect(sends).toBe(2);
  expect(fake.io.now()).toBe(2000);
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
    expect(fake.io.now()).toBe(deadlines[phase]);
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
    expect(await postDeploySmoke(modalEnv, [], fake.io)).toBe(true);
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
    expect(await postDeploySmoke(modalEnv, [], fake.io)).toBe(false);
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

test("GitHub runtime slice requires staging assertions and disposable repository before compute", async () => {
  const valid = {
    ...env,
    ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
    ARMADA_SMOKE_GITHUB_GATE: "true",
    ARMADA_SMOKE_SERVER_REVISION: "a".repeat(40),
    ARMADA_SMOKE_RUNTIME_REVISION: "b".repeat(40),
    ARMADA_SMOKE_CASES: JSON.stringify(
      ["modal"].flatMap((provider) =>
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
    // Distinct orgs keep each concurrent case lane's fake state apart.
    const stopping = new Set<unknown>();
    const fake = fixture((call) => {
      if (call.path === "sandbox/launch") stopping.delete(call.body.org);
      if (call.path === "sandbox/stop") stopping.add(call.body.org);
      if (call.path === "sandbox/status")
        return json({
          status: stopping.has(call.body.org) ? "stopped" : "ready",
          providerState: stopping.has(call.body.org) ? "stopped" : "active",
        });
      if (call.path === "sandbox/exec" && String(call.body.command).startsWith("head -c 64 --"))
        return json({ exitCode: 0, timedOut: false, stdout: failReceipt ? "0 128 0" : "0 0 0" });
      return undefined;
    });
    const cases = ["modal"].flatMap((provider) =>
      ["claude", "codex"].map((harness) => ({
        ...selected,
        provider,
        harness,
        org: `org-${harness}`,
        repo: "/home/user/it's a repo",
        disposableRepository: "https://github.com/smoke/disposable.git",
      })),
    );
    const staging = {
      ...env,
      ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
      ARMADA_SMOKE_GITHUB_GATE: "true",
      ARMADA_SMOKE_SERVER_REVISION: "a".repeat(40),
      ARMADA_SMOKE_RUNTIME_REVISION: "b".repeat(40),
      ARMADA_SMOKE_CASES: JSON.stringify(cases),
    };
    const io = {
      ...fake.io,
      fetch: (url: string, init: RequestInit) => fake.io.fetch(url.replace(staging.ARMADA_URL, env.ARMADA_URL), init),
    };
    expect(await postDeploySmoke(staging, ["--github-runtime"], io)).toBe(!failReceipt);
    for (const item of cases) {
      const mine = fake.calls.filter((call) => call.body.org === item.org);
      const sends = mine.filter((call) => call.path === "sandbox/send");
      expect(sends).toHaveLength(failReceipt ? 1 : 2);
      expect(String(sends[0]?.body.prompt)).toContain("push origin HEAD:refs/heads/armada-runtime-smoke-");
      expect(mine.filter((call) => String(call.body.command).startsWith("head -c 64 --"))).toHaveLength(
        failReceipt ? 1 : 2,
      );
      if (!failReceipt) {
        expect(String(sends[1]?.body.prompt)).not.toContain("push origin");
        expect(String(sends[1]?.body.prompt)).toContain("ls-remote origin HEAD");
        expect(String(sends[1]?.body.prompt)).toContain("git -C '/home/user/it'\\''s a repo'");
      }
      const cleanup = mine.findIndex((call) =>
        String(call.body.command).includes("push origin --delete armada-runtime-smoke-"),
      );
      expect(cleanup).toBeGreaterThan(0);
      expect(mine.findIndex((call) => call.path === "sandbox/stop")).toBeGreaterThan(cleanup);
    }
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
    let stopping = false;

    const fake = fixture((call) => {
      if (call.path === "sandbox/launch") {
        stopping = false;
      }
      if (call.path === "sandbox/stop") stopping = true;
      if (call.path === "sandbox/status")
        return json({
          status: stopping ? "stopped" : "ready",
          providerState: stopping ? "stopped" : "active",
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
        ["modal"].flatMap((provider) =>
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
      Array.from({ length: 2 }, (_, index) => ({ case: index, step: "scratch_branch_cleanup", outcome: "absent" })),
    );
    expect(fake.receipts().filter((entry) => entry.step === "cleanup_sandbox" && entry.pass)).toHaveLength(2);
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
  for (const provider of ["modal"]) {
    for (const fault of [
      "wrong_handle_owner",
      "none",
      "default_policy",
      "default_empty",
      "default_wrong_receipt",
      "default_opt_out_ignored",
      "default_wrong_golden",
      "scoped_pair",
      "scoped_unsupported",
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
      test(`provider=${provider} fault=${fault} validates recovery without leaking material`, async () => {
        const defaults = fault.startsWith("default_");
        const scopes = fault === "scoped_pair";
        const scopeFlag = fault.startsWith("scoped_");
        const baselineScopeAccount = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        const scopeAccount = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        const childId = crypto.randomUUID();
        const scriptedParents = new Map<string, boolean>();
        let childExists = false;
        let childStopped = false;
        const scopeEvents = new Map<string, object[]>();
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
          if (scopes && call.path === "sandbox/list") {
            expect(call.body.owner).toBe("me");
            expect(call.body.golden).toBe(defaultGolden);
            return json({
              sandboxes: [
                ...[...scriptedParents.keys()].map((id) => ({ id })),
                ...(childExists ? [{ id: childId }] : []),
              ],
              hasMore: false,
              nextPage: null,
              page: 1,
            });
          }
          if (
            scopes &&
            call.path === "sandbox/send" &&
            String(call.body.prompt).startsWith("ARMADA_SCOPED_SMOKE_V1 ")
          ) {
            const prefix = "ARMADA_SCOPED_SMOKE_V1 ";
            const { lane, launch, messageKey, stopKey, answer, noAccess } = JSON.parse(
              String(call.body.prompt).slice(prefix.length),
            );
            expect(lane).toBe("parent");
            expect(launch.selection).toMatchObject({
              credentialId: scopeAccount,
              model: "scripted",
              credentialVersion: 7,
            });
            const parent = String(call.body.id);
            expect(scriptedParents.has(parent)).toBe(true);
            expect(launches).toBeGreaterThan(0);
            if (parent === scriptedParents.keys().next().value) {
              const message = { idempotencyKey: messageKey, text: prefix + JSON.stringify({ lane: "child", answer }) };
              const op = () => ({ id: crypto.randomUUID(), state: "succeeded", sandboxId: childId });
              const tool = (name: string, input: object, result: object) => ({
                id: `call-${name}`,
                name,
                input,
                result: { isError: false, output: { structuredContent: { result } } },
              });
              childExists = true;
              childStopped = true;
              scopeEvents.set(parent, [
                {
                  id: "scoped-tools",
                  kind: "message",
                  text: "",
                  partial: false,
                  promptId: "scope-turn",
                  tools: [
                    tool("launch", launch, op()),
                    tool("message", { ...message, sandboxId: childId }, op()),
                    tool(
                      "read",
                      { sandboxId: childId },
                      {
                        id: childId,
                        provider,
                        harness: "codex",
                        orgId: defaultOrg,
                        goldenId: defaultGolden,
                        credentialId: scopeAccount,
                        credentialVersion: 7,
                        model: "scripted",
                        events: [
                          {
                            id: "child-answer",
                            kind: "message",
                            partial: false,
                            responseKind: "assistant",
                            tools: [],
                            text: answer,
                          },
                        ],
                      },
                    ),
                    tool("stop", { idempotencyKey: stopKey, sandboxId: childId }, op()),
                  ],
                },
              ]);
            } else
              scopeEvents.set(parent, [
                {
                  id: "no-scope",
                  kind: "message",
                  partial: false,
                  promptId: "scope-turn",
                  text: noAccess,
                  tools: [],
                },
              ]);
            return json({ promptId: "scope-turn" });
          }
          if (scopes && call.path === "sandbox/wait" && call.body.prompt_id === "scope-turn")
            return json({ prompt: { promptId: "scope-turn", state: "finished" } });
          if (scopes && call.path === "logs/read")
            return json({ events: scopeEvents.get(String(call.body.id)) ?? [], cursor: null, hasMore: false });
          if (scopes && call.path === "sandbox/stop" && call.body.id === childId) {
            childStopped = true;
            return json({ status: "stopped" });
          }
          if (scopes && call.path === "sandbox/status" && call.body.id === childId)
            return json({
              id: childId,
              status: childStopped ? "stopped" : "ready",
              providerState: childStopped ? "stopped" : "active",
            });
          const requestedId = String(call.body.id);
          if (scriptedParents.has(requestedId)) {
            if (call.path === "sandbox/stop") {
              scriptedParents.set(requestedId, true);
              return json({ status: "stopped" });
            }
            if (call.path === "sandbox/status") {
              const stopped = scriptedParents.get(requestedId);
              return json({ status: stopped ? "stopped" : "ready", providerState: stopped ? "stopped" : "active" });
            }
          }
          if (call.path === "sandbox/launch") {
            if (scopes && call.body.model === "scripted") {
              expect(call.body.credentialId).toBe(scopeAccount);
              const enabled = scriptedParents.size === 0;
              const id = crypto.randomUUID();
              scriptedParents.set(id, false);
              if (enabled) {
                expect(call.body.armadaAccessVersion).toBe(1);
                expect(call.body.armadaAccess).toEqual({ maxActiveChildren: 1 });
              } else {
                expect(call.body).not.toHaveProperty("armadaAccess");
                expect(call.body).not.toHaveProperty("armadaAccessVersion");
                expect(call.body.skipSkillDefaults).toBe(true);
              }
              return json({
                sandbox: {
                  id,
                  provider,
                  harness: "codex",
                  model: "scripted",
                  credentialId: scopeAccount,
                  credentialVersion: 7,
                  visibility: "private",
                },
                golden: { id: defaultGolden },
                ...(enabled ? { armadaAccess: { enabled: true, maxActiveChildren: 1 } } : {}),
              });
            }
            stopping = false;
            sandboxId = crypto.randomUUID();
            launches++;
            recoveryReads = 0;
            if (scopes) {
              expect(call.body.model).toBe(selected.model);
              expect(call.body.credentialId).toBe(baselineScopeAccount);
              expect(call.body).not.toHaveProperty("armadaAccess");
            }
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
              providerState: stopping ? "stopped" : "active",
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
                ...(defaults || scopes ? { org: defaultOrg.toUpperCase(), goldenId: defaultGolden.toUpperCase() } : {}),
                ...(scopes
                  ? { modelAccountId: baselineScopeAccount, scriptedModelAccountId: scopeAccount.toUpperCase() }
                  : {}),
                ...(fault === "scoped_unsupported" ? { harness: "claude" } : {}),
              },
            ]),
          },
          scopeFlag
            ? ["--work-preservation", "--scoped-access"]
            : defaults
              ? ["--work-preservation", "--default-skills"]
              : ["--work-preservation"],
          {
            ...fake.io,
            fetch: (url, init) => fake.io.fetch(url.replace(staging, env.ARMADA_URL), init),
          },
        );
        const success = ["none", "default_policy", "default_empty", "scoped_pair", "scoped_unsupported"].includes(
          fault,
        );
        expect(result).toBe(success);
        const stops = fake.calls.filter((call) => call.path === "sandbox/stop" && call.body.id !== childId).length;
        expect(stops).toBeGreaterThanOrEqual(2);
        expect(stops).toBeLessThanOrEqual(4);
        if (success) {
          expect(stops).toBe(scopes ? 4 : 2);
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
        if (fault === "scoped_unsupported") {
          expect(fake.receipts()).toContainEqual({ case: 0, step: "scoped_access", skip: true, reason: "codex_only" });
          expect(fake.calls.some((call) => call.path === "sandbox/launch" && call.body.armadaAccessVersion === 1)).toBe(
            false,
          );
        }
        if (scopes) {
          const scriptedSteps = fake.lines
            .filter((line) => line !== boatNotice)
            .map((line) => JSON.parse(line))
            .filter((line) => line.lane === "scoped");
          expect(scriptedSteps.map((line) => line.step)).not.toContain("launch");
          expect(scriptedSteps.filter((line) => line.step === "scoped_parent_launch" && line.pass)).toHaveLength(2);
          expect(
            fake.receipts().filter((line) => line.step === "scoped_access" && line.model === "scripted"),
          ).toHaveLength(2);
          expect(fake.calls.filter((call) => call.path === "sandbox/stop" && call.body.id === childId)).toHaveLength(1);
          expect(fake.receipts().filter((line) => line.step === "scoped_cleanup_summary" && line.pass)).toHaveLength(2);
          expect(
            fake.calls.filter((call) => call.path === "sandbox/launch" && call.body.armadaAccessVersion === 1),
          ).toHaveLength(1);
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

test.each(["configured", "no_pins", "refused", "late_wait"])(
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
    const fake = fixture(async (call) => {
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
              id: sandboxFixtureId,
              reason: "skillpack_registry_unavailable",
              manifest: { value: "secret-unreported", definition: { provider: "modal" } },
            });
          return json({
            state: "succeeded",
            id: sandboxFixtureId,
            provider: "modal",
            promptId: "prompt-id",
            manifest: { skillReceipts: [receipt] },
          });
        case "sandbox/wait":
          if (mode === "late_wait") await fake.io.sleep(deadlines.template_wait + 1);
          return json({ prompt: { promptId: "prompt-id", state: "finished" } });
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
            providerState: stopped ? "stopped" : "active",
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
    ).toBe(mode !== "refused" && mode !== "late_wait");
    expect(fake.calls.some((call) => call.path === "sandbox/launch")).toBe(false);
    expect(fake.calls.map((call) => call.path).slice(-3)).toEqual([
      "sandbox/status",
      "templates/delete",
      "variables/delete",
    ]);
    if (mode === "late_wait") {
      expect(fake.receipts()).toContainEqual({
        case: 0,
        step: "template_wait",
        pass: false,
        code: "poll_limit_exceeded",
      });
      expect(fake.calls.some((call) => call.path === "logs/read")).toBe(false);
      return;
    }
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

test("scoped access validates its matched control pair and explicit account IDs before any network call", async () => {
  const valid = {
    ...selected,
    org: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    goldenId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    modelAccountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    scriptedModelAccountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
  for (const config of [
    { args: ["--scoped-access"], cases: [valid] },
    ...[undefined, "invalid", valid.modelAccountId.toUpperCase()].map((scriptedModelAccountId) => ({
      args: ["--work-preservation", "--scoped-access"],
      cases: [valid, { ...valid, scriptedModelAccountId }],
    })),
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

test("vault transport catches canary echoes in error envelopes, cleans metadata and never allocates compute", async () => {
  const org = "11111111-1111-4111-8111-111111111111";
  let variable: Record<string, unknown> | undefined;
  let readable = "";
  let canary = "";
  const fake = fixture((call) => {
    switch (call.path) {
      case "variables/set":
        readable = String(call.body.value);
        variable = {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          orgId: org,
          ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          name: call.body.name,
          scope: "personal",
          version: 1,
          epoch: 1,
          status: "active",
          createdAt: "2026-11-11T00:00:00Z",
          updatedAt: "2026-11-11T00:00:00Z",
        };
        return json({ item: variable });
      case "variables/list":
        return json({ items: variable ? [variable] : [] });
      case "variables/read":
        return json({ item: variable, value: readable });
      case "secrets/set":
        canary = String(call.body.value);
        return json({ error: { code: "conflict", message: canary } }, 409);
      case "secrets/list":
        return json({ items: [] });
      case "variables/delete": {
        const item = { ...variable, version: 2, epoch: 2, status: "deleted" };
        variable = undefined;
        return json({ item });
      }
    }
  });
  expect(await postDeploySmoke(env, ["--vault"], fake.io)).toBe(false);
  expect(fake.calls).toHaveLength(0);
  const staging = "https://armada-mcp-staging.up.railway.app";
  expect(
    await postDeploySmoke(
      { ...env, ARMADA_URL: staging, ARMADA_SMOKE_CASES: JSON.stringify([{ ...selected, org }, selected]) },
      ["--vault"],
      fake.io,
    ),
  ).toBe(false);
  expect(fake.calls).toHaveLength(0);
  expect(
    await postDeploySmoke(
      { ...env, ARMADA_URL: staging, ARMADA_SMOKE_CASES: JSON.stringify([{ ...selected, org }]) },
      ["--vault"],
      {
        ...fake.io,
        fetch: (url, init) => fake.io.fetch(url.replace(staging, env.ARMADA_URL), init),
      },
    ),
  ).toBe(false);
  expect(fake.receipts()).toContainEqual({ case: 0, step: "vault_secret_set", pass: false, code: "secret_exposed" });
  expect(fake.calls.some((call) => call.path.startsWith("sandbox/"))).toBe(false);
  expect(fake.calls.filter((call) => call.path === "variables/delete")).toHaveLength(1);
  expect(fake.lines.join("")).not.toContain(canary);
  expect(fake.receipts()).toContainEqual({
    case: 0,
    step: "vault_cleanup_summary",
    pass: false,
    leftoverSecrets: [String(fake.calls.find((call) => call.path === "secrets/set")?.body.name)],
    leftoverVariables: [],
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
  | "lost_launch"
  | "recovered_launch";
function lifecycleFixture(fault: LifecycleFault = "none", handler?: (call: Call) => Response | undefined) {
  // Per-sandbox state: concurrent case lanes interleave their calls.
  interface Life {
    id: string;
    provider: string;
    harness: string;
    sends: number;
    stops: number;
    stopped: boolean;
    readiness: number;
    expiry: string;
  }
  const lives = new Map<string, Life>();
  let launches = 0;
  let observations = 0;
  const fake = fixture((call) => {
    const override = handler?.(call);
    if (override) return override;
    if (call.path === "sandbox/launch") {
      launches++;
      fake.advance(500);
      const life: Life = {
        id: lifecycleId(launches),
        provider: String(call.body.provider),
        harness: String(call.body.harness),
        sends: 0,
        stops: 0,
        stopped: false,
        readiness: 0,
        expiry: new Date(fake.io.now() + 1800_000).toISOString(),
      };
      lives.set(life.id, life);
      if (fault === "lost_launch" || fault === "recovered_launch") {
        fake.advance(600_000);
        throw new DOMException("secret launch outcome", "TimeoutError");
      }
      return json({ sandbox: { id: life.id, provider: life.provider } });
    }
    if (call.path === "sandbox/list" && call.body.externalRef) {
      expect(call.body.owner).toBe("me");
      if (fault !== "recovered_launch" || ++observations === 1) return json({ sandboxes: [] });
      const launch = fake.calls.find((entry) => entry.path === "sandbox/launch")!;
      return json({
        sandboxes: [
          { id: lifecycleId(1), provider: "modal", status: "ready", externalRef: launch.body.idempotencyKey },
        ],
      });
    }
    const life =
      call.path === "sandbox/list"
        ? [...lives.values()].findLast((entry) => entry.harness === call.body.harness)
        : lives.get(String(call.body.id));
    if (call.path.startsWith("sandbox/")) expect(life).toBeDefined();
    if (!life) return undefined;
    const { id, provider, harness } = life;
    if (call.path === "sandbox/status")
      return json({
        id,
        harness,
        status: life.stopped ? "stopped" : !life.sends && ++life.readiness === 1 ? "starting" : "ready",
        providerState: life.stopped ? "stopped" : "active",
        expiresAt: life.expiry,
      });
    if (call.path === "sandbox/send") {
      life.sends++;
      life.stopped = false;
      if (life.sends === 2 && fault === "lost_resume") throw new Error("secret lost resume receipt");
      return json({ promptId: `turn-${life.sends}` });
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
      expect(call.body.ttlSeconds).toBe(1860);
      const next = new Date(Date.parse(life.expiry) + 60_000).toISOString();
      if (fault !== "bad_extension") life.expiry = next;
      return json({ id, expiresAt: life.expiry, ttlSeconds: 1860 });
    }
    if (call.path === "sandbox/list") {
      expect(call.body.owner).toBe("me");
      expect(call.body.limit).toBe(200);
      return call.body.page === 1
        ? json({ sandboxes: [], page: 1, hasMore: true, nextPage: 2 })
        : json({
            sandboxes: [
              {
                id,
                provider,
                harness,
                status: fault === "list_mismatch" ? "running" : life.stopped ? "stopped" : "ready",
                expiresAt: life.expiry,
              },
            ],
            page: 2,
            hasMore: false,
            nextPage: null,
          });
    }
    if (call.path === "sandbox/stop") {
      life.stops++;
      if (fault === "stop_failed" && life.stops > 1) throw new Error("secret stop failure");
      life.stopped = true;
      return json({ status: "stopping" });
    }
  });
  const run = (cases: object[] = [selected], extraArgs: string[] = []) =>
    postDeploySmoke(
      {
        ...env,
        ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
        ARMADA_SMOKE_CASES: JSON.stringify(cases),
      },
      ["--lifecycle", ...extraArgs],
      {
        ...fake.io,
        sleep: async (ms) => {
          const wakeAt = fake.io.now() + ms;
          await new Promise<void>((resolve) => setImmediate(resolve));
          fake.advance(Math.max(0, wakeAt - fake.io.now()));
        },
        fetch: (url, init) =>
          fake.io.fetch(url.replace("https://armada-mcp-staging.up.railway.app", env.ARMADA_URL), init),
      },
    );
  return { ...fake, run };
}

test("an ordinary lifecycle case never reads goldenId, which only scoped Codex cases validate", async () => {
  const fake = lifecycleFixture();
  expect(await fake.run([{ ...selected, goldenId: 42 }])).toBe(true);
  expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(1);
});

test("lifecycle records readiness and confirms extend/list, closed idle steer refusal and send-after-stop on every selected pair", async () => {
  const fake = lifecycleFixture();
  const cases = ["modal"].flatMap((provider) =>
    ["claude", "codex"].map((harness) => ({ ...selected, provider, harness })),
  );
  expect(await fake.run(cases)).toBe(true);
  expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(2);
  expect(fake.calls.filter((call) => call.path === "sandbox/send")).toHaveLength(4);
  expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(4);
  expect(fake.calls.filter((call) => call.path === "sandbox/steer")).toHaveLength(2);
  for (const [index, item] of cases.entries()) {
    expect(fake.receipts()).toContainEqual({
      case: index,
      step: "time_to_ready",
      pass: true,
      provider: item.provider,
      harness: item.harness,
      // Concurrent lanes share the fake clock; the lower bound is checked below.
      elapsedMs: expect.any(Number),
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
  expect(
    fake
      .receipts()
      .filter((line) => line.step === "time_to_ready")
      .map((line) => line.elapsedMs >= 1500),
  ).toEqual([true, true]);
  expect(fake.receipts().filter((line) => line.step === "lifecycle_cleanup_summary")).toHaveLength(2);
  expect(
    fake
      .receipts()
      .filter((line) => line.step === "lifecycle_cleanup_summary")
      .every((line) => line.pass && !line.leftoverSandboxIds.length && !line.launchOutcomeUnknown),
  ).toBe(true);
  expect(fake.lines.join("")).not.toContain("secret");
});

test("a resumed send admitted after its measured deadline fails without replay and still cleans up", async () => {
  const fake = lifecycleFixture("none", (call) => {
    if (call.path !== "sandbox/send" || !fake.calls.some((entry) => entry.path === "sandbox/stop")) return;
    fake.advance(deadlines.resume_send + 1);
    return undefined;
  });
  expect(await fake.run()).toBe(false);
  expect(fake.receipts()).toContainEqual({ case: 0, step: "resume_send", pass: false, code: "poll_limit_exceeded" });
  expect(fake.calls.filter((call) => call.path === "sandbox/send")).toHaveLength(2);
  expect(fake.calls.at(-2)?.path).toBe("sandbox/stop");
  expect(fake.calls.at(-1)?.path).toBe("sandbox/status");
});

test("a resumed turn receipt arriving after its measured deadline fails and the sandbox is stopped", async () => {
  const fake = lifecycleFixture("none", (call) => {
    if (call.path !== "sandbox/wait" || call.body.prompt_id !== "turn-2") return;
    fake.advance(deadlines.resume_wait + 1);
    return json({ prompt: { promptId: "turn-2", state: "finished" } });
  });
  expect(await fake.run()).toBe(false);
  expect(fake.receipts()).toContainEqual({
    case: 0,
    step: "resume_wait",
    pass: false,
    code: "poll_limit_exceeded",
  });
  expect(fake.calls.at(-2)?.path).toBe("sandbox/stop");
  expect(fake.calls.at(-1)?.path).toBe("sandbox/status");
});

test("resume wait reports only the redacted shape of an invalid response", async () => {
  const invalidResponses = [
    {
      response: json({ status: "starting", providerState: null, prompt: null, settled: false, timedOut: true }),
      shape: {
        body: "object",
        status: "starting",
        providerState: "null",
        prompt: "null",
        promptId: "missing",
        promptIdMatches: false,
        state: "missing",
        settled: false,
        timedOut: true,
      },
    },
    {
      response: json({
        status: "secret sandbox status",
        prompt: { promptId: "secret prompt id", state: "secret state", reason: "secret reason" },
        "secret key": "secret value",
      }),
      shape: {
        body: "object",
        status: "string",
        providerState: "missing",
        prompt: "object",
        promptId: "string",
        promptIdMatches: false,
        state: "string",
        settled: "missing",
        timedOut: "missing",
      },
    },
    {
      response: new Response("secret non-JSON body", { status: 200 }),
      shape: { body: "unparseable", httpStatus: 200 },
    },
  ];
  for (const { response, shape } of invalidResponses) {
    const fake = lifecycleFixture("none", (call) =>
      call.path === "sandbox/wait" && call.body.prompt_id === "turn-2" ? response : undefined,
    );
    expect(await fake.run()).toBe(false);
    expect(fake.receipts().find((line) => line.step === "resume_wait")).toMatchObject({
      pass: false,
      code: "invalid_response",
      waitResponse: shape,
    });
    expect(fake.lines.join("")).not.toContain("secret");
  }
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
      expect(summary.leftoverSandboxIds).toEqual([lifecycleId(1)]);
    }
    if (fault === "lost_launch") {
      expect(summary.pass).toBe(false);
      expect(summary.launchOutcomeUnknown).toBe(true);
      expect(fake.receipts().find((line) => line.step === "launch")).toMatchObject({
        launchResponse: { requestKey: fake.calls.find((call) => call.path === "sandbox/launch")!.body.idempotencyKey },
      });
    }
    expect(fake.lines.join("")).not.toContain("secret");
  }
});

test("an ordinary lifecycle launch continues on the sandbox observed after a response timeout", async () => {
  const fake = lifecycleFixture("recovered_launch");
  expect(await fake.run()).toBe(true);
  const starts = fake.calls.filter((call) => call.path === "sandbox/launch");
  expect(starts).toHaveLength(1);
  const key = starts[0]!.body.idempotencyKey;
  expect(key).toEqual(expect.any(String));
  expect(starts[0]!.body.externalRef).toBe(key);
  expect(fake.calls.filter((call) => call.path === "sandbox/list" && call.body.externalRef === key)).toHaveLength(2);
  expect(fake.calls.find((call) => call.path === "sandbox/send")?.body.id).toBe(lifecycleId(1));
  expect(fake.lines.map((line) => (line === boatNotice ? null : JSON.parse(line)))).toContainEqual(
    expect.objectContaining({ step: "launch", pass: true, elapsedMs: 601_500 }),
  );
});

// The merged staging command combines these independently runnable families.
test("the launch tracker records every launch handle, awaits launches in flight and flags a lost launch", async () => {
  const tracker = createLaunchTracker();
  let finish: (value: unknown) => void = () => {};
  const template = tracker.track("templates/launch", (record) =>
    new Promise((resolve) => (finish = resolve)).then(() => record({ id: "template-sandbox" })),
  );
  // A receipt that fails validation (wrong provider) is still a sibling handle, and not a lost launch.
  await tracker
    .track("sandbox/launch", async (record) => {
      record({ sandbox: { id: "launched", provider: "boat" } });
      throw new Error("invalid_response");
    })
    .catch(() => {});
  await tracker.track("sandbox/launch", async (record) => record({ sandbox: { id: "parent" } }));
  // Only launches gate the snapshot diff; a pending read never does.
  tracker.track("sandbox/status", (record) => {
    record({ id: "not-a-launch" });
    return new Promise(() => {});
  });
  const never = () => false;
  const idle = () => new Promise<void>(() => {});
  // Rows already explained, or none at all, never wait on a launch in flight.
  expect([...(await tracker.siblings(new Set(["parent"]), never, idle))].sort()).toEqual(["launched", "parent"]);
  expect((await tracker.siblings(new Set(), never, idle)).size).toBe(2);
  // A pending launch is unknown, not lost, until it settles.
  expect(tracker.lostLaunch()).toBe(true);
  const waiting = Promise.withResolvers<void>();
  const siblings = tracker.siblings(new Set(["template-sandbox"]), never, () => {
    waiting.resolve();
    return idle();
  });
  expect(await Promise.race([siblings, waiting.promise])).toBeUndefined();
  finish(null);
  await template;
  expect([...(await siblings)].sort()).toEqual(["launched", "parent", "template-sandbox"]);
  expect(tracker.lostLaunch()).toBe(false);
  // The wait is bounded: a launch that never answers cannot hold an unexplained row forever.
  tracker.track("sandbox/launch", () => new Promise(() => {}));
  let ticks = 0;
  const bounded = await tracker.siblings(
    new Set(["unknown"]),
    () => ticks >= 3,
    async () => {
      ticks++;
    },
  );
  expect(ticks).toBe(3);
  expect(bounded.has("unknown")).toBe(false);
  expect(tracker.lostLaunch()).toBe(true);
  // A launch that fails before any handle may still have created a sandbox.
  const lostTracker = createLaunchTracker();
  await lostTracker.track("templates/launch", () => Promise.reject(new Error("request_failed"))).catch(() => {});
  expect(lostTracker.lostLaunch()).toBe(true);
});
test("an unrelated launch in flight never holds scoped child cleanup or the next preservation worker", async () => {
  const org = "30000000-0000-4000-8000-000000000001";
  const scopedGolden = "50000000-0000-4000-8000-000000000001";
  const otherGolden = "50000000-0000-4000-8000-000000000002";
  const children = new Map<string, string>();
  const stopped: string[] = [];
  const inventory: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let releasedAt = -1;
  const lines: string[] = [];
  const fake = fixture(async (call) => {
    if (call.path === "sandbox/list" && call.body.golden)
      return json({ sandboxes: inventory.map((id) => ({ id })), page: 1, hasMore: false, nextPage: null });
    if (call.path === "sandbox/launch" && call.body.harness === "claude") {
      // The other golden's launch answers only once the scoped case has finished both windows.
      await held;
      return json({ sandbox: { id: crypto.randomUUID(), provider: "modal" } });
    }
    if (call.path === "sandbox/launch") {
      const id = crypto.randomUUID();
      inventory.push(id);
      if (call.body.armadaAccessVersion === 1) {
        children.set(id, crypto.randomUUID());
        inventory.push(children.get(id)!);
      }
      return json({ sandbox: { id, provider: "modal" } });
    }
    if (call.path === "sandbox/stop") {
      stopped.push(String(call.body.id));
      return json({ status: "stopping" });
    }
    if (call.path === "sandbox/status") {
      const id = String(call.body.id);
      const done = stopped.includes(id);
      return json({ id, status: done ? "stopped" : "ready", providerState: done ? "stopped" : "active" });
    }
    if (call.path === "logs/read") return json({ events: [], cursor: null, hasMore: false });
    return undefined;
  });
  const cases = [
    {
      ...selected,
      org,
      golden: `smoke-${scopedGolden}`,
      goldenId: scopedGolden,
      modelAccountId: "40000000-0000-4000-8000-000000000000",
      scriptedModelAccountId: "60000000-0000-4000-8000-000000000000",
    },
    { ...selected, harness: "claude", org, golden: `smoke-${otherGolden}`, goldenId: otherGolden },
  ];
  const staging = "https://armada-mcp-staging.up.railway.app";
  await postDeploySmoke(
    { ...env, ARMADA_URL: staging, ARMADA_SMOKE_CASES: JSON.stringify(cases) },
    ["--work-preservation", "--scoped-access"],
    {
      ...fake.io,
      fetch: (url, init) => fake.io.fetch(url.replace(staging, env.ARMADA_URL), init),
      out: (line) => {
        fake.io.out(line);
        if (line === boatNotice) return;
        lines.push(line);
        const parsed = JSON.parse(line);
        if (parsed.case === 0 && parsed.step === "scoped_cleanup_summary" && parsed.mode === "no_option") {
          releasedAt = lines.length;
          release();
        }
      },
    },
  );
  // Both scoped windows of case 0 closed while the other launch was pending.
  expect(releasedAt).toBeGreaterThan(0);
  const before = lines.slice(0, releasedAt).map((line) => JSON.parse(line));
  const summaries = before.filter((line) => line.case === 0 && line.step === "scoped_cleanup_summary");
  expect(summaries.map((line) => line.mode)).toEqual(["enabled", "no_option"]);
  // The unclaimed child still fails the probe; the parent was stopped. The bounded wait for the
  // still-pending launch applies only to that unexplained row (child-first order and the no-wait
  // path are proven at the probe boundary in scoped-access-smoke.test.ts).
  const enabled = summaries[0];
  expect(enabled.unattributedSandboxIds).toEqual([children.get(enabled.parentId)]);
  expect(enabled.pass).toBe(false);
  expect(summaries[1].unattributedSandboxIds).toEqual([]);
  expect(stopped).toContain(enabled.parentId);
  expect(fake.lines.join("")).not.toContain("secret");
});

/** Fake expiry API for one 180 s sandbox per harness; `starting` decides a status poll still reports starting. */
function expiryId(harness: unknown) {
  return harness === "claude" ? "12345678-1234-1234-1234-123456789abc" : "12345678-1234-1234-1234-123456789abd";
}

function expiryApi(now: () => number, starting: (id: string) => boolean = () => false) {
  const expiries = new Map<string, number>();
  return (call: Call): Response | undefined => {
    if (call.path === "sandbox/launch" && call.body.ttlSeconds === 180) {
      const id = expiryId(call.body.harness);
      expiries.set(id, now() + 180_000);
      return json({ sandbox: { id, provider: call.body.provider } });
    }
    const id = String(call.body.id);
    const expiresMs = expiries.get(id);
    const listed = call.path === "sandbox/list" && call.body.status === undefined;
    if (expiresMs === undefined && !listed) return undefined;
    const target = listed ? expiryId(call.body.harness) : id;
    const deadline = expiries.get(target)!;
    const expired = now() >= deadline;
    const expiresAt = new Date(deadline).toISOString();
    if (call.path === "sandbox/status")
      return json({
        id,
        status: expired ? "stopped" : starting(id) ? "starting" : "ready",
        providerState: expired ? "stopped" : "active",
        statusReason: expired ? "expired" : null,
        expiresAt,
      });
    if (listed)
      return json({
        sandboxes: [
          {
            id: target,
            provider: "modal",
            harness: call.body.harness,
            status: expired ? "stopped" : "ready",
            effectiveTtlSeconds: 180,
            expiresAt,
            stoppedAt: expired ? expiresAt : null,
          },
        ],
        page: call.body.page,
        hasMore: false,
        nextPage: null,
      });
    throw new Error("unexpected expiry call");
  };
}

test("an ambiguous expiry launch reports bounded HTTP correlation without replaying the launch", async () => {
  const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  for (const header of [requestId, "secret-header"]) {
    const fake = lifecycleFixture("none", (call) => {
      if (call.path === "sandbox/list" && call.body.externalRef) return Response.json({ sandboxes: [] });
      if (call.path !== "sandbox/launch" || call.body.ttlSeconds !== 180) return undefined;
      fake.advance(112_848);
      return Response.json(
        { error: { code: "outcome_unknown", message: "secret-body" } },
        { status: 503, headers: { "x-request-id": header, "server-timing": "secret-timing" } },
      );
    });
    expect(await fake.run([selected], ["--expiry"])).toBe(false);
    const launches = fake.calls.filter((call) => call.path === "sandbox/launch" && call.body.ttlSeconds === 180);
    expect(launches).toHaveLength(1);
    expect(fake.lines.filter((line) => line !== boatNotice).map((line) => JSON.parse(line))).toContainEqual({
      case: 0,
      lane: "expiry",
      step: "expiry_launch",
      pass: false,
      code: "outcome_unknown",
      elapsedMs: 112_848 + deadlines.expiry_launch,
      launchResponse: {
        httpStatus: 503,
        timeoutMs: deadlines.expiry_launch,
        requestKey: launches[0]?.body.idempotencyKey,
        ...(header === requestId ? { requestId } : {}),
      },
    });
    expect(fake.lines.join("")).not.toMatch(/secret-(header|body|timing)/);
  }
});

test("independent sandbox lanes run concurrently: the expiry wait overlaps every case's lifecycle, receipts stay attributable", async () => {
  const fake = lifecycleFixture("none", (call) => expiry(call));
  const expiry = expiryApi(fake.io.now);
  // Distinct model accounts: nothing makes the lanes take turns.
  const cases = ["claude", "codex"].map((harness) => ({ ...selected, harness, modelAccountId: `account-${harness}` }));
  expect(await fake.run(cases, ["--expiry"])).toBe(true);
  const receipts = fake.lines.filter((line) => line !== boatNotice).map((line) => JSON.parse(line));
  const at = (lane: string, step: string, index: number) =>
    receipts.findIndex((line) => line.lane === lane && line.step === step && line.case === index);
  for (const index of [0, 1]) {
    // A serial run would finish every 180 s expiry wait before the first lifecycle launch.
    expect(at("lifecycle", "lifecycle_cleanup_summary", index)).toBeGreaterThan(-1);
    expect(at("lifecycle", "lifecycle_cleanup_summary", index)).toBeLessThan(at("expiry", "expiry_as_stop", 0));
    expect(at("expiry", "expiry_cleanup_summary", index)).toBeGreaterThan(-1);
  }
  // Both cases' lifecycle sandboxes are launched before either one stops.
  const lifecycleCalls = fake.calls.filter(
    (call) =>
      [lifecycleId(1), lifecycleId(2)].includes(String(call.body.id)) ||
      (call.path === "sandbox/launch" && call.body.ttlSeconds === 1800),
  );
  expect(lifecycleCalls.filter((call) => call.path === "sandbox/launch")).toHaveLength(2);
  expect(lifecycleCalls.findLastIndex((call) => call.path === "sandbox/launch")).toBeLessThan(
    lifecycleCalls.findIndex((call) => call.path === "sandbox/stop"),
  );
  // Interleaved output stays attributable: every unit receipt names its case and lane.
  const unitReceipts = receipts.filter((line) => line.step !== "smoke_cleanup_summary");
  expect(unitReceipts.length).toBeGreaterThan(0);
  for (const line of unitReceipts) {
    expect([0, 1]).toContain(line.case);
    expect(["lifecycle", "expiry"]).toContain(line.lane);
    expect(line.lane === "expiry").toBe(String(line.step).startsWith("expiry_"));
  }
  expect(fake.lines.join("")).not.toContain("secret");
});

test("lanes sharing a one-slot model account take turns, and the expiry wait still overlaps the lifecycle", async () => {
  for (const harnesses of [["claude"], ["claude", "codex"]]) {
    // The server's admission rule: a launch reserves the account's only slot, a starting sandbox
    // keeps it, an idle ready one frees it, and a concurrent launch is refused with a conflict.
    const working = new Set<string>();
    const polls = new Map<string, number>();
    let conflicts = 0;
    let lifecycleLaunches = 0;
    const expiry = expiryApi(
      () => fake.io.now(),
      (id) => {
        const count = (polls.get(id) ?? 0) + 1;
        polls.set(id, count);
        if (count > 1) working.delete(id);
        return count === 1;
      },
    );
    const fake = lifecycleFixture("none", (call) => {
      if (call.path === "sandbox/launch") {
        expect(call.body.credentialId).toBe("account");
        if (working.size) {
          conflicts++;
          return json({ error: { code: "conflict", message: "secret account at its limit" } }, 409);
        }
        working.add(call.body.ttlSeconds === 180 ? expiryId(call.body.harness) : lifecycleId(++lifecycleLaunches));
      }
      if (call.path === "sandbox/stop") working.delete(String(call.body.id));
      return expiry(call);
    });
    const cases = harnesses.map((harness) => ({ ...selected, harness }));
    expect(await fake.run(cases, ["--expiry"])).toBe(true);
    expect(conflicts).toBe(0);
    expect(lifecycleLaunches).toBe(harnesses.length);
    const receipts = fake.lines.filter((line) => line !== boatNotice).map((line) => JSON.parse(line));
    const at = (lane: string, step: string, index: number) =>
      receipts.findIndex((line) => line.lane === lane && line.step === step && line.case === index);
    for (const index of harnesses.keys()) {
      // Each expiry lane gives the account back once ready, so every lifecycle runs inside the TTL waits.
      expect(at("expiry", "expiry_ready", index)).toBeGreaterThan(-1);
      expect(at("lifecycle", "lifecycle_cleanup_summary", index)).toBeGreaterThan(
        at("expiry", "expiry_ready", harnesses.length - 1),
      );
      expect(at("lifecycle", "lifecycle_cleanup_summary", index)).toBeLessThan(at("expiry", "expiry_as_stop", 0));
    }
    expect(fake.lines.join("")).not.toContain("secret");
  }
});

test("a template probe held beyond the TTL takes its account first, and the expiry wait still overlaps the lifecycle", async () => {
  const expiry = expiryApi(() => fake.io.now());
  let templateCalls = 0;
  const fake = lifecycleFixture("none", (call) => {
    // The template lane holds its account for a full template launch timeout, far beyond the 180 s TTL,
    // then fails; its account turn ends when it settles either way, so only the order is checked.
    if (!call.path.startsWith("sandbox/") && !call.path.startsWith("logs/") && templateCalls++ === 0)
      fake.advance(600_000);
    return expiry(call);
  });
  expect(await fake.run([selected], ["--expiry", "--templates-skills"])).toBe(false);
  expect(templateCalls).toBeGreaterThan(0);
  const first = (match: (call: Call) => boolean) => fake.calls.findIndex(match);
  const template = first((call) => !call.path.startsWith("sandbox/") && !call.path.startsWith("logs/"));
  const expiryLaunch = first((call) => call.path === "sandbox/launch" && call.body.ttlSeconds === 180);
  const lifecycleLaunch = first((call) => call.path === "sandbox/launch" && call.body.ttlSeconds !== 180);
  expect(template).toBeGreaterThan(-1);
  expect(expiryLaunch).toBeGreaterThan(template);
  expect(lifecycleLaunch).toBeGreaterThan(expiryLaunch);
  const receipts = fake.lines.filter((line) => line !== boatNotice).map((line) => JSON.parse(line));
  const at = (lane: string, step: string) =>
    receipts.findIndex((line) => line.lane === lane && line.step === step && line.case === 0);
  // Lifecycle work runs while the expiry sandbox is still waiting out its TTL, and both lanes pass.
  expect(at("expiry", "expiry_ready")).toBeGreaterThan(-1);
  expect(at("lifecycle", "lifecycle_cleanup_summary")).toBeGreaterThan(at("expiry", "expiry_ready"));
  expect(at("lifecycle", "lifecycle_cleanup_summary")).toBeLessThan(at("expiry", "expiry_as_stop"));
  for (const lane of ["expiry", "lifecycle"])
    expect(receipts.filter((line) => line.lane === lane && line.pass === false)).toEqual([]);
});

test("a keyed action that releases its key early lets the next one start before it finishes", async () => {
  const queue = createKeyedQueue();
  const events: string[] = [];
  let finish: () => void = () => {};
  const first = queue("a", async (release) => {
    events.push("a1 ready");
    release();
    await new Promise<void>((resolve) => (finish = resolve));
    events.push("a1 end");
  });
  const second = queue("a", async () => {
    events.push("a2");
  });
  await second;
  expect(events).toEqual(["a1 ready", "a2"]);
  finish();
  await first;
  expect(events).toEqual(["a1 ready", "a2", "a1 end"]);
});

test("the keyed queue runs same-key actions in order, keeps other keys concurrent and survives a failure", async () => {
  const queue = createKeyedQueue();
  const events: string[] = [];
  let release: () => void = () => {};
  const first = queue("a", async () => {
    events.push("a1 start");
    await new Promise<void>((resolve) => (release = resolve));
    events.push("a1 end");
    throw new Error("a1 failed");
  });
  const second = queue("a", async () => {
    events.push("a2");
    return 2;
  });
  const other = queue("b", async () => {
    events.push("b");
    return "b";
  });
  expect(await other).toBe("b");
  expect(events).toEqual(["a1 start", "b"]);
  release();
  await expect(first).rejects.toThrow("a1 failed");
  expect(await second).toBe(2);
  expect(events).toEqual(["a1 start", "b", "a1 end", "a2"]);
});

test("scoped probes sharing an org and golden never see each other's child; distinct goldens stay concurrent", async () => {
  const org = "30000000-0000-4000-8000-000000000001";
  const run = async (goldens: string[]) => {
    // One inventory per golden. A launch-access parent registers a scoped child the owner API never launched.
    const inventories = new Map<string, string[]>();
    const children = new Map<string, string>();
    const stopped = new Set<string>();
    const fake = fixture((call) => {
      // Lists name the golden by id, launches by slug; the server matches ids case-insensitively.
      const golden = String(call.body.golden ?? "")
        .replace(/^smoke-/, "")
        .toLowerCase();
      if (call.path === "sandbox/list" && call.body.golden)
        return json({
          sandboxes: (inventories.get(golden) ?? []).map((id) => ({ id })),
          page: 1,
          hasMore: false,
          nextPage: null,
        });
      if (call.path === "sandbox/launch") {
        const id = crypto.randomUUID();
        const added: string[] = [id];
        // The concurrent Claude lane's receipt fails validation after its handle arrived.
        const provider = call.body.harness === "claude" ? "boat" : "modal";
        if (call.body.armadaAccessVersion === 1) {
          children.set(id, crypto.randomUUID());
          added.push(children.get(id)!);
        }
        inventories.set(golden, [...(inventories.get(golden) ?? []), ...added]);
        // No golden receipt: the launch fails validation and the case goes straight to cleanup.
        return json({ sandbox: { id, provider } });
      }
      if (call.path === "sandbox/stop") {
        stopped.add(String(call.body.id));
        return json({ status: "stopping" });
      }
      if (call.path === "sandbox/status") {
        const id = String(call.body.id);
        const state = stopped.has(id) ? "stopped" : "active";
        return json({ id, status: stopped.has(id) ? "stopped" : "ready", providerState: state });
      }
      if (call.path === "logs/read") return json({ events: [], cursor: null, hasMore: false });
      return undefined;
    });
    const cases = [
      ...goldens.map((golden, index) => ({
        ...selected,
        org: index ? org.toUpperCase() : org,
        golden: `smoke-${golden}`,
        goldenId: golden,
        modelAccountId: `40000000-0000-4000-8000-00000000000${index}`,
        scriptedModelAccountId: `60000000-0000-4000-8000-00000000000${index}`,
      })),
      // Not a scoped pair, so never queued: its owner launches land in the first inventory
      // while the scoped windows are open and must be recognised as siblings.
      { ...selected, harness: "claude", org, golden: `smoke-${goldens[0]}`, goldenId: goldens[0] },
    ];
    const staging = "https://armada-mcp-staging.up.railway.app";
    await postDeploySmoke(
      { ...env, ARMADA_URL: staging, ARMADA_SMOKE_CASES: JSON.stringify(cases) },
      ["--work-preservation", "--scoped-access"],
      { ...fake.io, fetch: (url, init) => fake.io.fetch(url.replace(staging, env.ARMADA_URL), init) },
    );
    return { fake, children, lines: fake.lines.filter((line) => line !== boatNotice).map((l) => JSON.parse(l)) };
  };
  const golden = "50000000-0000-4000-8000-000000000001";
  const shared = await run([golden, golden.toUpperCase()]);
  const summaries = shared.lines.filter((line) => line.step === "scoped_cleanup_summary");
  expect(summaries).toHaveLength(4);
  for (const index of [0, 1]) {
    // Only the case's own unclaimed child is unattributed: a genuinely unknown ID still fails.
    const enabled = summaries.find((line) => line.case === index && line.mode === "enabled");
    expect(enabled).toMatchObject({ pass: false, unattributedSandboxIds: [shared.children.get(enabled.parentId)] });
    expect(summaries.find((line) => line.case === index && line.mode === "no_option")).toMatchObject({
      unattributedSandboxIds: [],
    });
  }
  // Probe windows on the same inventory never overlap: each snapshot pair is contiguous.
  const windows = shared.lines.filter(
    (line) => line.step === "scoped_snapshot" || line.step === "scoped_cleanup_summary",
  );
  for (let at = 0; at < windows.length; at += 2) {
    expect(windows[at].step).toBe("scoped_snapshot");
    expect(windows[at + 1]).toMatchObject({ step: "scoped_cleanup_summary", case: windows[at].case });
  }

  // Distinct goldens are independent inventories: both probes open before either closes.
  const independent = await run([golden, "50000000-0000-4000-8000-000000000002"]);
  const order = independent.lines.filter(
    (line) => line.step === "scoped_snapshot" || line.step === "scoped_cleanup_summary",
  );
  expect(order.slice(0, 2).map((line) => [line.step, line.case])).toEqual([
    ["scoped_snapshot", 0],
    ["scoped_snapshot", 1],
  ]);
  expect(independent.fake.lines.join("")).not.toContain("secret");
});

test("vault/template failures remain failures without bypassing the combined lifecycle checks", async () => {
  const fake = lifecycleFixture();
  expect(
    await fake.run([{ ...selected, org: "11111111-1111-4111-8111-111111111111" }], ["--vault", "--templates-skills"]),
  ).toBe(false);
  expect(fake.calls.some((call) => call.path === "variables/set")).toBe(true);
  expect(fake.receipts()).toContainEqual({ case: 0, step: "list_stopped_final", pass: true });
});

test("GitHub refresh reports Modal's shipped refusal without losing launch access or cleanup", async () => {
  for (const harness of ["claude", "codex"]) {
    const fake = lifecycleFixture("none", (call) =>
      call.path === "github/refresh" ? json({ error: { code: "unsupported" } }, 400) : undefined,
    );
    expect(await fake.run([{ ...selected, harness }], ["--github-refresh"])).toBe(true);
    expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.path === "sandbox/send")).toHaveLength(2);
    expect(fake.calls.filter((call) => call.path === "github/refresh")).toHaveLength(1);
    const reports = fake.receipts();
    expect(reports).toContainEqual({ case: 0, step: "github_launch_access", pass: true });
    expect(reports.findIndex((line) => line.step === "time_to_ready")).toBeLessThan(
      reports.findIndex((line) => line.step === "github_launch_access"),
    );
    expect(reports).toContainEqual({ case: 0, step: "github_refresh_unsupported", pass: true });
    expect(reports).toContainEqual({
      case: 0,
      step: "github_refresh_idempotency",
      skip: true,
      reason: "not_part_of_release_gate",
    });
    expect(JSON.stringify(reports)).not.toContain('"login"');
  }
});

test("GitHub refresh rejects false Modal admission, wrong refusal and broken launch access without losing cleanup", async () => {
  for (const fault of ["modal_admitted", "modal_wrong_refusal", "launch_access"]) {
    let refreshes = 0;
    const fake = lifecycleFixture("none", (call) => {
      if (call.path === "sandbox/exec" && String(call.body.command).includes("ls-remote") && fault === "launch_access")
        return json({ exitCode: 1, timedOut: false });
      if (call.path === "github/refresh") {
        refreshes++;
        return fault === "modal_wrong_refusal"
          ? json({ error: { code: "forbidden" } }, 403)
          : json({ id: call.body.id, status: "connected", login: "owner" });
      }
    });
    expect(await fake.run([selected], ["--github-refresh"])).toBe(false);
    expect(refreshes).toBeLessThanOrEqual(1);
    expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(1);
    expect(fake.receipts().at(-1)).toMatchObject({
      step: "lifecycle_cleanup_summary",
      pass: true,
      leftoverSandboxIds: [],
    });
    expect(JSON.stringify(fake.receipts())).not.toContain("secret");
  }
});

test("GitHub refresh refuses modes that bypass its ordinary lifecycle worker before traffic", async () => {
  for (const args of [["--github-refresh"], ["--github-refresh", "--templates-skills"]]) {
    const fake = fixture();
    const staging = "https://armada-mcp-staging.up.railway.app";
    expect(
      await postDeploySmoke({ ...env, ARMADA_URL: staging }, args, {
        ...fake.io,
        fetch: (url, init) => fake.io.fetch(url.replace(staging, env.ARMADA_URL), init),
      }),
    ).toBe(false);
    expect(fake.calls).toHaveLength(0);
  }
});

test("the advertised smoke workflow invocation admits ordinary staging checks", async () => {
  const workflow = Bun.YAML.parse(
    readFileSync(new URL("../.github/workflows/staging-gated-production.yml", import.meta.url), "utf8"),
  ) as {
    on: { workflow_dispatch: { inputs?: Record<string, unknown> } | null };
    jobs: { staging: { steps: { name?: string; env?: Record<string, string>; run?: string }[] } };
  };
  const exercise = workflow.jobs.staging.steps.find((step) => step.name === "Smoke pinned staging")!;
  const directory = mkdtempSync(join(tmpdir(), "smoke-workflow-admission-"));
  try {
    const bun = join(directory, "bun");
    writeFileSync(bun, '#!/bin/bash\nif [[ "$1" == "scripts/post-deploy-smoke.ts" ]]; then printf "%s\\0" "$@"; fi\n');
    chmodSync(bun, 0o755);
    const command = Bun.spawnSync(["bash", "-eu", "-c", exercise.run!], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
        ARMADA_TOKEN: "fixture",
        ARMADA_SMOKE_CASES: JSON.stringify([selected]),
        ARMADA_SMOKE: "create_real_compute",
        ARMADA_SMOKE_JOURNAL: join(directory, "sandboxes.json"),
      },
    });
    expect(command.exitCode).toBe(0);
    const argv = command.stdout.toString().split("\0").slice(0, -1);
    expect(argv[0]).toBe("scripts/post-deploy-smoke.ts");
    const fake = fixture((call) => {
      if (call.path === "skills/defaults/get") return json({ error: { code: "unauthorized" } }, 401);
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
              org: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              goldenId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              modelAccountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              scriptedModelAccountId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            },
          ]),
        },
        argv.slice(1),
        {
          ...fake.io,
          fetch: (url, init) => fake.io.fetch(url.replace(staging, env.ARMADA_URL), init),
        },
      ),
    ).toBe(false);
    // A deliberate auth refusal after admission, not a configuration failure or compute allocation.
    expect(fake.calls.map((call) => call.path)).toEqual(["skills/defaults/get"]);
    expect(fake.receipts()).toContainEqual({
      case: 0,
      step: "default_skills_golden",
      pass: false,
      code: "unauthorized",
    });
    expect(fake.receipts().some((line) => line.step === "configure")).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("golden runtime integrity probes are staging-only, fail closed, and retain stopped cleanup on Modal", async () => {
  const staging = "https://armada-mcp-staging.up.railway.app";
  for (const provider of ["modal"]) {
    for (const broken of [undefined, "helper", "skillpack"] as const) {
      let stopped = false;
      const fake = fixture((call) => {
        if (call.path === "sandbox/stop") stopped = true;
        if (call.path === "sandbox/status")
          return json({
            status: stopped ? "stopped" : "ready",
            providerState: stopped ? "stopped" : "active",
          });
        if (
          call.path === "sandbox/exec" &&
          broken &&
          String(call.body.command).includes(broken === "helper" ? "armada-helper" : "skillpack-runtime")
        )
          return json({ exitCode: 1, timedOut: false, stdout: "private-output", stderr: "private-error" });
      });
      expect(
        await postDeploySmoke(
          {
            ...env,
            ARMADA_URL: staging,
            ARMADA_SMOKE_CASES: JSON.stringify([{ ...selected, provider }]),
          },
          ["--golden-runtime"],
          {
            ...fake.io,
            fetch: (url, init) => fake.io.fetch(url.replace(staging, env.ARMADA_URL), init),
          },
        ),
      ).toBe(broken === undefined);
      const reports = fake.receipts();
      expect(reports.some((line) => line.step === "golden_helper_integrity")).toBe(true);
      expect(reports.some((line) => line.step === "golden_skillpack_integrity")).toBe(broken !== "helper");
      expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(1);
      expect(stopped).toBe(true);
      expect(fake.lines.join("\n")).not.toContain("private-output");
      expect(fake.lines.join("\n")).not.toContain("private-error");
    }
  }
  for (const flags of [["--golden-runtime"], ["--golden-runtime", "--templates-skills"]]) {
    const invalid = fixture();
    expect(
      await postDeploySmoke({ ...env, ...(flags.length > 1 ? { ARMADA_URL: staging } : {}) }, flags, {
        ...invalid.io,
        fetch: (url, init) => invalid.io.fetch(url.replace(staging, env.ARMADA_URL), init),
      }),
    ).toBe(false);
    expect(invalid.calls).toHaveLength(0);
  }
});

test("readiness timing excludes slow integrity probes and survives either probe failing", async () => {
  for (const failedExec of [0, 1, 2]) {
    let execs = 0;
    const fake = lifecycleFixture("none", (call) => {
      if (call.path !== "sandbox/exec") return;
      execs++;
      fake.advance(30_000);
      if (execs === failedExec) return json({ exitCode: 1, timedOut: false });
    });
    expect(await fake.run([selected], ["--golden-runtime"])).toBe(failedExec === 0);
    const reports = fake.receipts();
    const timing = reports.findIndex((line) => line.step === "time_to_ready");
    expect(timing).toBeGreaterThanOrEqual(0);
    expect(reports[timing]).toEqual({
      case: 0,
      step: "time_to_ready",
      pass: true,
      provider: selected.provider,
      harness: selected.harness,
      elapsedMs: 1500,
    });
    expect(timing).toBeLessThan(reports.findIndex((line) => line.step === "golden_helper_integrity"));
    if (failedExec)
      expect(reports).toContainEqual({
        case: 0,
        step: failedExec === 1 ? "golden_helper_integrity" : "golden_skillpack_integrity",
        pass: false,
        code: "exec_failed",
      });
    expect(fake.calls.some((call) => call.path === "sandbox/stop")).toBe(true);
  }
});

test("Modal smoke refuses a finished turn whose status never reports usage and still stops compute", async () => {
  const fake = fixture((call) =>
    call.path === "sandbox/status" && !fake.calls.some((entry) => entry.path === "sandbox/stop")
      ? json({
          status: "ready",
          providerState: "active",
          usage: { turns: [], tokenTotals: { inputTokens: null, outputTokens: null } },
        })
      : undefined,
  );
  expect(
    await postDeploySmoke(
      { ...env, ARMADA_SMOKE_CASES: JSON.stringify([{ ...selected, provider: "modal" }]) },
      [],
      fake.io,
    ),
  ).toBe(false);
  expect(fake.receipts()).toContainEqual({ case: 0, step: "usage", pass: false, code: "poll_limit_exceeded" });
  expect(fake.io.now()).toBe(deadlines.usage);
  expect(fake.calls.some((call) => call.path === "sandbox/stop")).toBe(true);
});

// The staging acceptance check requires measured counters for this resumed prompt,
// not an unknown receipt or totals belonging to an earlier turn.
test.each(["unknown", "missing", "old", "partial", "measured", "null-totals", "complete-marker"])(
  "Modal resumed Codex usage contract: %s",
  async (mode) => {
    let resumed = false;
    const fake = lifecycleFixture("none", (call) => {
      if (call.path === "sandbox/wait" && call.body.prompt_id === "turn-2") resumed = true;
      if (call.path === "sandbox/stop" || fake.receipts().some((r) => r.step === "resume_usage" && r.pass))
        resumed = false;
      if (call.path !== "sandbox/status" || !resumed) return;

      return json({
        status: "ready",
        providerState: "active",
        usage: {
          turns:
            mode === "missing"
              ? []
              : [
                  {
                    promptId: mode === "old" ? "turn-1" : "turn-2",
                    inputTokens: mode === "measured" ? 12 : null,
                    outputTokens: mode === "measured" ? 3 : null,
                    ...(mode === "partial" ? {} : { cachedTokens: mode === "measured" ? 0 : null }),
                  },
                ],
          tokenTotals: {
            inputTokens: mode === "null-totals" ? null : 22,
            outputTokens: mode === "null-totals" ? null : 5,
            incomplete: mode !== "measured" && mode !== "complete-marker",
          },
        },
      });
    });
    const accepted = mode === "measured";
    expect(await fake.run([{ ...selected, provider: "modal" }])).toBe(accepted);
    if (!accepted) {
      const usage = fake.lines
        .slice(1)
        .map((line) => JSON.parse(line))
        .find((line) => line.step === "resume_usage");
      expect(usage?.elapsedMs).toBe(deadlines.resume_usage);
    }
    expect(fake.receipts()).toContainEqual(
      accepted
        ? { case: 0, step: "resume_usage", pass: true }
        : { case: 0, step: "resume_usage", pass: false, code: "poll_limit_exceeded" },
    );
  },
);
