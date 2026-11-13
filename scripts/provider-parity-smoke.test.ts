import { expect, test } from "bun:test";
import { postDeploySmoke } from "./post-deploy-smoke.ts";
import { smokeReceipts } from "./smoke-sandbox-cleanup.ts";

const boatNotice = "boat: not part of the release gate";
const boatNotRun = { status: "not-run", reason: "not_part_of_release_gate" };

// The CLI boundary owns parity reporting: independent fake HTTP receipts catch
// route/receipt regressions without provider compute, credentials, or sleeps.
for (const mode of [
  "online",
  "accounts",
  "accounts_unknown",
  "accounts_invalid",
  "accounts_stop_unsupported",
  "accounts_unknown_bad",
  "accounts_price_lost",
  "offline",
  "unsupported",
  "delete_failure",
  "resume_failure",
  "filtered",
  "unimplemented",
  "idle-pause",
  "wake-on-send",
  "invalid_filter",
  "recall_loss",
  "quota",
  "resume_quota",
  "server_failure",
  "delete_retry",
  "journal_failure",
  "stop_response_lost",
  "terminal_failed",
  "already_deleted",
  "wrong_delete_id",
  "cost_mismatch",
  "usage_missing",
  "price_changed",
  "usage_filter",
  "usage_lost",
  "baseline_quota",
] as const) {
  test(`parity normal lifecycle and honest reporting: ${mode}`, async () => {
    const debtFeature =
      mode === "unimplemented" ? "mcp" : mode === "idle-pause" || mode === "wake-on-send" ? mode : undefined;
    const lines: string[] = [];
    const calls: string[] = [];
    const deletes = new Map<string, number>();
    const detailReads = new Map<string, number>();
    const turns = new Map<string, string[]>();
    const prompts = new Map<string, string>();
    const states = new Map<string, string>();
    const providers = ["modal", "docker"];
    const passed = await postDeploySmoke(
      {
        ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
        ARMADA_TOKEN: "fake",
        ARMADA_SMOKE: "create_real_compute",
        ARMADA_SMOKE_CASES: JSON.stringify([
          { provider: "boat", org: null },
          ...(mode.startsWith("accounts") ? ["modal", "docker"] : providers).flatMap((provider) =>
            (mode.startsWith("accounts") ? ["codex-openai", "codex-azure"] : [undefined]).map((account) => ({
              ...(account ? { account: mode === "accounts_invalid" ? "unknown-account" : account } : {}),
              provider,
              org: provider,
              harness: "codex",
              model: "fake-model",
              modelAccountId: "fake-account",
              golden: "fake-golden",
              hostId: "owned-host",
            })),
          ),
          { provider: "boat", harness: "invalid" },
        ]),
      },
      mode.startsWith("accounts")
        ? ["--parity", "--accounts"]
        : mode === "usage_filter"
          ? ["--parity", "--only", "docker", "--feature", "exact-cost"]
          : mode === "filtered"
            ? ["--parity", "--only", "docker", "--feature", "exec"]
            : debtFeature
              ? ["--parity", "--feature", debtFeature]
              : mode === "invalid_filter"
                ? ["--parity", "--feature", "typo"]
                : ["--parity"],
      {
        now: () => 0,
        sleep: async () => {},
        out: (line) => lines.push(line),
        recordSandbox: async (org, _id, requestKey, provider) => {
          // Exercise the real journal validator, not a permissive callback.
          expect(String(provider)).toBe(org);
          smokeReceipts([{ org, id: "12345678-1234-1234-1234-123456789abc", requestKey, provider }]);
          if (mode === "journal_failure") throw new Error("journal_unwritable");
        },
        fetch: async (url, init) => {
          const path = url.split("/api/v1/")[1]!;
          const body = JSON.parse(String(init.body));
          const p = body.org;
          calls.push(`${p}:${path}`);
          let result: object;
          switch (path) {
            case "launch/options":
              result = {
                providers: providers.map((id) => ({
                  id,
                  harnesses: ["codex"],
                  capabilities: {
                    launch: true,
                    exec: true,
                    followupPrompts: true,
                    status: true,
                    logs: true,
                    stop: mode !== "accounts_stop_unsupported",
                    resume: !(id === "docker" && mode === "unsupported"),
                    delete: true,
                  },
                  unsupportedReasons: {
                    stop: "Stop unavailable (#1579)",
                    resume: "Server resume disabled.",
                  },
                })),
              };
              break;
            case "docker/hosts/list":
              result = { hosts: [{ id: "owned-host", state: mode === "offline" ? "offline" : "online" }] };
              break;
            case "sandbox/launch":
              if (mode.startsWith("accounts")) turns.set(p, []);
              if (p === "docker") expect(body).not.toHaveProperty("image");
              if (p === "modal" && (mode === "quota" || mode === "server_failure"))
                return Response.json(
                  {
                    error: {
                      code: mode === "quota" ? "rate_limited" : "forbidden",
                      message:
                        mode === "quota"
                          ? "The Modal plan start limit per day has been reached."
                          : "Access denied. token=do-not-print ghp_abcdefghijklmnopqrstuvwxyz0123456789 sk-abcdefghijklmnopqrstuvwxyz eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl",
                      details: { secret: "do-not-print-details" },
                    },
                  },
                  { status: mode === "quota" ? 429 : 403 },
                );
              states.set(p, "ready");
              result = { sandbox: { id: p, provider: p } };
              break;
            case "sandbox/send": {
              if (p !== "docker") expect(body.request_id).toBeUndefined();
              if (body.prompt.includes("Remember this token")) prompts.set(p, body.prompt.match(/PARITY_[a-z0-9]+/)[0]);
              states.set(p, p === "docker" ? "running" : "ready");
              const history = turns.get(p) ?? [];
              history.push(`turn-${history.length + 1}`);
              turns.set(p, history);
              result = { promptId: history.at(-1) };
              break;
            }
            case "logs/read":
              result = {
                events: [
                  { kind: "prompt", promptId: turns.get(p)?.at(-1), status: "finished" },
                  { kind: "message", promptId: turns.get(p)?.at(-1), text: `SMOKE_OK ${prompts.get(p)}` },
                ],
              };
              break;
            case "sandbox/exec":
              result = { exitCode: 0, timedOut: false, stdout: "PARITY_EXEC_OK" };
              break;
            case "sandbox/detail":
            case "sandbox/status":
              detailReads.set(p, (detailReads.get(p) ?? 0) + 1);
              if (mode === "baseline_quota" && path === "sandbox/detail" && detailReads.get(p) === 1)
                return Response.json(
                  { error: { code: "rate_limited", message: "Read quota reached." } },
                  { status: 429 },
                );
              result = {
                id: p,
                status: states.get(p),
                usage: {
                  turnCount: turns.get(p)?.length ?? 0,
                  turns: (mode === "usage_lost" && (turns.get(p)?.length ?? 0) > 1
                    ? (turns.get(p) ?? []).slice(-1)
                    : (turns.get(p) ?? [])
                  ).map((promptId, i) => ({
                    promptId,
                    model: "fake-model",
                    inputTokens: mode === "usage_missing" ? null : 10,
                    outputTokens: 5,
                    pricing: {
                      unknown:
                        mode === "accounts_unknown" ||
                        (mode === "accounts_price_lost" && (turns.get(p)?.length ?? 0) > 1)
                          ? "price"
                          : null,
                      usd:
                        mode === "accounts_unknown" ||
                        (mode === "accounts_price_lost" && (turns.get(p)?.length ?? 0) > 1)
                          ? null
                          : mode === "price_changed" && (turns.get(p)?.length ?? 0) > 1
                            ? i === 0
                              ? "0.2"
                              : i === 1
                                ? "0.0"
                                : "0.1"
                            : "0.1",
                    },
                  })),
                  cost: {
                    currency: "USD",
                    basis: "estimated",
                    unknown:
                      mode.startsWith("accounts_unknown") ||
                      (mode === "accounts_price_lost" && (turns.get(p)?.length ?? 0) > 1)
                        ? "price"
                        : null,
                    unpricedTurns:
                      mode.startsWith("accounts_unknown") ||
                      (mode === "accounts_price_lost" && (turns.get(p)?.length ?? 0) > 1)
                        ? turns.get(p)?.length
                        : 0,
                    usd:
                      mode.startsWith("accounts_unknown") ||
                      (mode === "accounts_price_lost" && (turns.get(p)?.length ?? 0) > 1)
                        ? null
                        : mode === "cost_mismatch"
                          ? "99"
                          : `0.${turns.get(p)?.length ?? 0}`,
                  },
                },
              };
              break;
            case "sandbox/stop":
              states.set(p, mode === "already_deleted" ? "deleted" : mode === "terminal_failed" ? "failed" : "stopped");
              if (mode === "recall_loss") prompts.delete(p);
              if (mode === "stop_response_lost") throw new Error("stop_response_lost");
              result = { status: "stopped" };
              break;
            case "sandbox/resume":
              if (mode === "resume_quota")
                return Response.json(
                  { error: { code: "rate_limited", message: "Start quota reached." } },
                  { status: 429 },
                );
              expect(p).toBe("docker");
              states.set(p, "ready");
              if (mode === "resume_failure") throw new Error("lost_resume_response");
              result = { status: "ready" };
              break;
            case "sandbox/delete":
              deletes.set(p, (deletes.get(p) ?? 0) + 1);
              if (mode === "delete_retry" && p === "modal" && deletes.get(p) === 1)
                return Response.json(
                  { error: { code: "conflict", message: "Provider deletion is pending." } },
                  { status: 409 },
                );
              expect(["stopped", "failed"]).toContain(states.get(p) ?? "missing");
              result = {
                id: mode === "wrong_delete_id" ? "another-sandbox" : p,
                status: mode === "delete_failure" && p === "docker" ? "pending" : "deleted",
              };
              break;
            default:
              throw new Error(`Unexpected route ${path}`);
          }
          return Response.json(result);
        },
      },
    );
    expect(lines.filter((line) => line === boatNotice)).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("boat:"))).toBe(false);
    if (mode.startsWith("accounts")) {
      if (mode === "accounts_invalid") {
        expect(passed).toBe(false);
        expect(calls).toHaveLength(0);
        expect(lines.find((line) => line.startsWith("{"))).toContain("invalid_accounts_configuration");
        return;
      }
      const badCost = mode === "accounts_unknown_bad" || mode === "accounts_price_lost";
      expect(passed).toBe(!badCost);
      const report = JSON.parse(lines.find((line) => line.startsWith('{"step":"accounts_parity"'))!);
      for (const account of ["codex-openai", "codex-azure"]) {
        for (const provider of ["modal", "docker"]) {
          const cell = report.accounts[account][provider];
          expect(cell.status).toBe(badCost ? "fail" : mode === "accounts_stop_unsupported" ? "not-run" : "pass");
          expect(cell.features["resume-recall"][provider].status).toBe("pass");
          if (mode === "accounts_unknown") expect(cell.features["exact-cost"][provider].reason).toBe("unknown: price");
        }
      }
      expect(report.accounts["codex-subscription"].modal).toEqual({
        status: "not-run",
        reason: "no account on staging",
      });
      expect(calls.filter((call) => call.endsWith(":sandbox/launch"))).toHaveLength(4);
      expect(calls.filter((call) => call.endsWith(":sandbox/delete"))).toHaveLength(4);
      expect(calls.some((call) => call.startsWith("boat:"))).toBe(false);
      return;
    }
    if (mode === "invalid_filter") {
      expect(passed).toBe(false);
      expect(calls).toHaveLength(0);
      expect(lines.some((line) => line.includes("invalid_parity_filter"))).toBe(true);
      return;
    }
    const report = JSON.parse(lines.find((line) => line.startsWith('{"step":"provider_parity"'))!);
    for (const cells of Object.values(report.features) as Record<string, unknown>[])
      expect(cells.boat).toEqual(boatNotRun);
    if (mode === "filtered" || debtFeature) {
      expect(passed).toBe(true);
      if (debtFeature) {
        expect(calls).toHaveLength(0);
        expect(report.starts).toBe(0);
        for (const provider of providers)
          expect(report.features[debtFeature][provider]).toEqual({
            status: "not-run",
            reason: "probe_not_implemented",
          });
      } else {
        expect(report.features.exec.docker.status).toBe("pass");
        expect(report.features.exec.boat).toEqual(boatNotRun);
        expect(calls.filter((call) => call.endsWith(":sandbox/launch"))).toEqual(["docker:sandbox/launch"]);
        expect(calls).not.toContain("docker:sandbox/send");
        expect(calls).toContain("docker:sandbox/delete");
      }
      return;
    }
    if (
      mode === "journal_failure" ||
      mode === "stop_response_lost" ||
      mode === "resume_failure" ||
      mode === "terminal_failed" ||
      mode === "already_deleted"
    ) {
      expect(passed).toBe(false);
      for (const provider of providers) {
        expect(report.features.cleanup[provider].status).toBe("pass");
        if (mode === "already_deleted") expect(calls).not.toContain(`${provider}:sandbox/delete`);
        else expect(calls).toContain(`${provider}:sandbox/delete`);
      }
      if (mode === "stop_response_lost") {
        // Unknown stop outcome is reconciled with status, not replayed.
        for (const provider of providers)
          expect(calls.filter((call) => call === `${provider}:sandbox/stop`)).toHaveLength(1);
      }
      return;
    }
    if (mode === "baseline_quota") {
      expect(passed).toBe(true);
      expect(report.features["exact-cost-before-resume"].docker.status).toBe("not-run");
      expect(report.features["exact-cost-after-resume"].docker.status).toBe("pass");
      expect(report.features["exact-cost"].docker.status).toBe("not-run");
      return;
    }
    if (["cost_mismatch", "usage_missing", "price_changed", "usage_filter", "usage_lost"].includes(mode)) {
      const cell = report.features["exact-cost"].docker;
      expect(cell.status).toBe(mode === "usage_filter" ? "pass" : "fail");
      expect(passed).toBe(mode === "usage_filter");
      expect(report.features.cleanup.docker.status).toBe("pass");
      if (mode === "usage_filter") {
        expect(calls.filter((call) => call.endsWith(":sandbox/launch"))).toEqual(["docker:sandbox/launch"]);
        expect(turns.get("docker")).toHaveLength(2);
        expect(report.features["exact-cost-before-resume"].docker.status).toBe("pass");
        expect(report.features["exact-cost-after-resume"].docker.status).toBe("pass");
      }
      return;
    }
    if (mode === "wrong_delete_id") {
      expect(passed).toBe(false);
      expect(report.features.cleanup.docker.status).toBe("fail");
      expect(
        lines.filter((line) => line.includes('"step":"parity_cleanup"')).every((line) => !JSON.parse(line).deleted),
      ).toBe(true);
      return;
    }
    expect(report.starts).toBe(mode === "offline" ? 1 : 2);
    if (mode === "quota" || mode === "server_failure") {
      const cell = report.features.launch.modal;
      expect(cell.status).toBe(mode === "quota" ? "not-run" : "fail");
      expect(cell.diagnostic.httpStatus).toBe(mode === "quota" ? 429 : 403);
      expect(cell.diagnostic.code).toBe(mode === "quota" ? "rate_limited" : "forbidden");
      expect(report.features.send.modal.status).toBe(cell.status);
      expect(passed).toBe(mode === "quota");
      expect(lines.join("\n")).not.toContain("do-not-print");
      expect(lines.join("\n")).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz");
      expect(lines.join("\n")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
      expect(lines.join("\n")).not.toContain("eyJhbGci");
      expect(lines.at(-1)).toContain(mode === "quota" ? "HTTP 429" : "HTTP 403");
      return;
    }
    if (mode === "resume_quota") {
      expect(report.features.resume.docker.status).toBe("not-run");
      expect(report.features["resume-recall"].docker.status).toBe("not-run");
      expect(report.features["resume-recall"].docker.diagnostic.httpStatus).toBe(429);
      expect(passed).toBe(true);
      expect(report.features["exact-cost"].docker.status).toBe("not-run");
      return;
    }
    if (mode === "delete_retry") expect(deletes.get("modal")).toBe(2);
    expect(report.features.launch.modal.status).toBe("pass");
    expect(report.features.delete.modal.status).toBe("pass");
    expect(passed).toBe(mode === "online" || mode === "unsupported" || mode === "delete_retry");
    expect(lines.at(-1)).toContain("| Feature | Boat | Modal | Docker |");
    if (mode === "offline") {
      expect(report.features.launch.docker).toEqual({ status: "fail", reason: "host_offline" });
      expect(calls).not.toContain("docker:sandbox/launch");
      expect(lines.filter((line) => line.includes('"step":"host_offline"'))).toHaveLength(1);
    } else if (mode === "unsupported") {
      expect(report.features.resume.docker).toEqual({ status: "unsupported", reason: "Server resume disabled." });
      expect(calls).not.toContain("docker:sandbox/resume");
    } else if (mode === "recall_loss") expect(report.features["resume-recall"].modal.status).toBe("fail");
    else if (mode === "delete_failure") expect(report.features.delete.docker.status).toBe("fail");
    else expect(report.features.resume.docker.status).toBe("pass");
  });
}

test("parity --only boat is an owner-decision not-run report, never allocation or proof", async () => {
  const lines: string[] = [];
  const calls: string[] = [];
  const passed = await postDeploySmoke(
    {
      ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
      ARMADA_TOKEN: "fake",
      ARMADA_SMOKE: "create_real_compute",
      ARMADA_SMOKE_CASES: JSON.stringify([{ provider: "boat", org: null, harness: "invalid" }]),
    },
    ["--parity", "--only", "boat"],
    {
      now: () => 0,
      sleep: async () => {},
      out: (line) => lines.push(line),
      fetch: async (url) => {
        calls.push(url);
        throw new Error("Boat staging must never call an API");
      },
    },
  );
  expect(passed).toBe(false);
  expect(calls).toHaveLength(0);
  expect(lines.filter((line) => line === boatNotice)).toHaveLength(1);
  const report = JSON.parse(lines.find((line) => line.startsWith('{"step":"provider_parity"')) ?? "{}");
  expect(report.starts).toBe(0);
  for (const cells of Object.values(report.features) as Record<string, unknown>[])
    expect(cells.boat).toEqual(boatNotRun);
});

const productionBoatCase = {
  provider: "boat",
  org: "production-org",
  harness: "codex",
  model: "selected-model",
  modelAccountId: "selected-account",
  golden: "selected-golden",
};
const productionBoatEnv = {
  ARMADA_URL: "https://production.invalid",
  ARMADA_TOKEN: "fake",
  ARMADA_SMOKE: "create_real_compute",
  ARMADA_SMOKE_CASES: JSON.stringify([productionBoatCase]),
};
const productionBoatArgs = ["--production-boat", "--only", "boat"];

function productionBoatFixture(
  fault?:
    | "foreign_provider"
    | "ambiguous_launch"
    | "delete_failed"
    | "slow_turn"
    | "turn_timeout"
    | "stop_settling"
    | "late_success"
    | "deadline_exhausted",
) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const lines: string[] = [];
  let status = "ready";
  let memory = "";
  const turns: string[] = [];
  let journalWrites = 0;
  let clock = 0;
  let reads = 0;
  let deleteAttempts = 0;
  const io = {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    out: (line: string) => lines.push(line),
    recordSandbox: async () => {
      journalWrites++;
    },
    fetch: async (url: string, init: RequestInit) => {
      expect(new URL(url).origin).toBe(productionBoatEnv.ARMADA_URL);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fake");
      expect(init.redirect).toBe("error");
      const path = new URL(url).pathname.slice("/api/v1/".length);
      const body = JSON.parse(String(init.body));
      calls.push({ path, body });
      if (body.id !== undefined) expect(body.id).toBe("new-production-boat");
      switch (path) {
        case "launch/options":
          return Response.json({
            providers: [
              {
                id: "boat",
                harnesses: ["codex"],
                capabilities: {
                  launch: true,
                  followupPrompts: true,
                  status: true,
                  logs: true,
                  exec: true,
                  stop: true,
                  resume: true,
                  delete: true,
                },
                unsupportedReasons: {},
              },
            ],
          });
        case "sandbox/launch":
          if (fault === "deadline_exhausted") clock += 35 * 60_000;
          expect(body.provider).toBe("boat");
          if (fault === "ambiguous_launch") throw new Error("lost launch acknowledgement");
          return Response.json({
            sandbox: { id: "new-production-boat", provider: fault === "foreign_provider" ? "modal" : "boat" },
          });
        case "sandbox/send":
          status = "ready";
          if (String(body.prompt).includes("Remember this token"))
            memory = String(body.prompt).match(/PARITY_[a-z0-9]+/)?.[0] ?? "";
          turns.push(`turn-${turns.length + 1}`);
          return Response.json({ promptId: turns.at(-1) });
        case "logs/read":
          if (fault === "late_success") clock += 601_000;
          if (fault === "slow_turn" || fault === "turn_timeout") {
            clock += 2000;
            reads++;
            if (fault === "turn_timeout" || reads <= 130)
              return Response.json({
                events: [{ kind: "prompt", promptId: turns.at(-1), status: "running", at: 1_000_000 }],
              });
          }
          return Response.json({
            events: [
              { kind: "prompt", promptId: turns.at(-1), status: "running", at: 1_000_000 },
              { kind: "prompt", promptId: turns.at(-1), status: "finished", at: 1_180_000 },
              { kind: "message", promptId: turns.at(-1), text: `SMOKE_OK ${memory}` },
            ],
          });
        case "sandbox/detail":
          return Response.json({
            usage: {
              turnCount: turns.length,
              turns: turns.map((promptId) => ({
                promptId,
                model: "selected-model",
                inputTokens: 10,
                outputTokens: 2,
                pricing: { unknown: null, usd: "0.1" },
              })),
              cost: { currency: "USD", unknown: null, unpricedTurns: 0, usd: `0.${turns.length}` },
            },
          });
        case "sandbox/status":
          return Response.json({ id: "new-production-boat", status });
        case "sandbox/exec":
          return Response.json({ exitCode: 0, timedOut: false, stdout: "PARITY_EXEC_OK" });
        case "sandbox/stop":
          status = "stopped";
          return Response.json({ status });
        case "sandbox/delete":
          deleteAttempts++;
          if (fault === "stop_settling" && deleteAttempts <= 2)
            return Response.json(
              { error: { code: "sandbox_not_ready", message: "Stop is still settling." } },
              { status: 409 },
            );
          if (fault === "delete_failed") return Response.json({ error: { code: "forbidden" } }, { status: 403 });
          status = "deleted";
          return Response.json({ id: "new-production-boat", status });
        default:
          throw new Error(`Unexpected production route ${path}`);
      }
    },
  };
  return { io, calls, lines, journalWrites: () => journalWrites };
}

function runProductionBoat(env: NodeJS.ProcessEnv, io: ReturnType<typeof productionBoatFixture>["io"], args: string[]) {
  return postDeploySmoke(env, ["--parity", ...args], io);
}

test("production Boat verification requires coordinator opt-in and rejects unsafe configuration before traffic", async () => {
  const cases = [
    { args: ["--only", "boat"] },
    { args: ["--production-boat"] },
    { args: ["--production-boat", "--only", "modal"] },
    { args: ["--production-boat", "--only", "docker"] },
    { args: [...productionBoatArgs, "--production-boat"] },
    { args: [...productionBoatArgs, "--only", "boat"] },
    { args: [...productionBoatArgs, "--unknown"] },
    { args: [...productionBoatArgs, "--feature", "exec", "--feature", "exec"] },
    { args: [...productionBoatArgs, "--accounts"] },
    ...[
      { ARMADA_URL: "https://armada-mcp-staging.up.railway.app" },
      { ARMADA_URL: "http://production.invalid" },
      { ARMADA_URL: "https://user@production.invalid" },
      { ARMADA_URL: "https://production.invalid/api" },
      { ARMADA_URL: "https://production.invalid/?key=value" },
      { ARMADA_URL: "https://production.invalid/#fragment" },
      { ARMADA_URL: "" },
      { ARMADA_TOKEN: "" },
      { ARMADA_SMOKE: "" },
      { CI: "false" },
      { GITHUB_ACTIONS: "false" },
      { ARMADA_SMOKE_JOURNAL: "/tmp/preexisting-journal" },
      { ARMADA_SMOKE_CASES: JSON.stringify([{ ...productionBoatCase, provider: "modal" }]) },
      { ARMADA_SMOKE_CASES: JSON.stringify([{ ...productionBoatCase, provider: "docker" }]) },
      { ARMADA_SMOKE_CASES: JSON.stringify([productionBoatCase, productionBoatCase]) },
      { ARMADA_SMOKE_CASES: JSON.stringify([{ ...productionBoatCase, harness: "unknown" }]) },
      { ARMADA_SMOKE_CASES: JSON.stringify([{ ...productionBoatCase, golden: "" }]) },
    ].map((env) => ({ env })),
  ];
  for (const scenario of cases) {
    const fake = productionBoatFixture();
    expect(
      await runProductionBoat(
        { ...productionBoatEnv, ...("env" in scenario ? scenario.env : {}) },
        fake.io,
        "args" in scenario ? scenario.args : productionBoatArgs,
      ),
    ).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(fake.journalWrites()).toBe(0);
  }
});

for (const fault of [undefined, "foreign_provider", "ambiguous_launch", "delete_failed"] as const) {
  test(`production Boat verifies only its new allocation and never stage journals: ${fault ?? "happy"}`, async () => {
    const fake = productionBoatFixture(fault);
    expect(
      await runProductionBoat(
        {
          ...productionBoatEnv,
          ARMADA_SMOKE_CASES: JSON.stringify([
            { provider: "modal", harness: null },
            productionBoatCase,
            { provider: "docker" },
          ]),
        },
        fake.io,
        productionBoatArgs,
      ),
    ).toBe(fault === undefined);
    expect(fake.lines.filter((line) => line === "boat: production verification (coordinator opt-in)")).toHaveLength(1);
    expect(fake.lines).not.toContain(boatNotice);
    expect(fake.calls.filter((call) => call.path === "sandbox/launch")).toHaveLength(1);
    expect(fake.journalWrites()).toBe(0);
    const report = JSON.parse(fake.lines.find((line) => line.startsWith('{"step":"provider_parity"')) ?? "{}");
    if (fault === "foreign_provider" || fault === "ambiguous_launch") {
      expect(fake.calls.map((call) => call.path)).toEqual(["launch/options", "sandbox/launch"]);
      expect(report.features.launch.boat.status).toBe("fail");
      expect(fake.lines.some((line) => line.includes('"step":"parity_cleanup"'))).toBe(false);
    } else {
      expect(fake.calls.filter((call) => call.path === "sandbox/stop")).toHaveLength(2);
      expect(fake.calls.some((call) => call.path === "sandbox/delete")).toBe(true);
      const cleanup = JSON.parse(fake.lines.find((line) => line.startsWith('{"step":"parity_cleanup"')) ?? "{}");
      expect(cleanup).toMatchObject({ provider: "boat", id: "new-production-boat", deleted: fault === undefined });
      expect(report.features.cleanup.boat.status).toBe(fault ? "fail" : "pass");
      for (const step of [
        "launch",
        "send",
        "status",
        "logs",
        "exec",
        "stop",
        "resume",
        "resume-recall",
        "usage",
        "exact-cost",
      ])
        expect(report.features[step].boat.status).toBe("pass");
      expect(report.features.mcp.boat).toEqual({ status: "not-run", reason: "probe_not_implemented" });
      expect(report.features.launch.modal.reason).toBe("provider_filtered");
      expect(report.features.launch.docker.reason).toBe("provider_filtered");
    }
  });
}

test("production Boat preserves capability discovery and feature-filtered probes", async () => {
  const refused = productionBoatFixture();
  expect(
    await runProductionBoat(
      {
        ...productionBoatEnv,
        ARMADA_SMOKE_CASES: JSON.stringify([{ ...productionBoatCase, harness: "claude" }]),
      },
      refused.io,
      productionBoatArgs,
    ),
  ).toBe(false);
  expect(refused.calls.map((call) => call.path)).toEqual(["launch/options"]);

  const filtered = productionBoatFixture();
  expect(await runProductionBoat(productionBoatEnv, filtered.io, [...productionBoatArgs, "--feature", "exec"])).toBe(
    true,
  );
  expect(filtered.calls.map((call) => call.path)).not.toContain("sandbox/send");
  expect(filtered.calls.map((call) => call.path)).toContain("sandbox/exec");
  expect(filtered.calls.map((call) => call.path)).toContain("sandbox/delete");
  expect(filtered.journalWrites()).toBe(0);
});

// Fake time crosses the old 120-read ceiling without sleeping or real compute.
for (const fault of ["slow_turn", "turn_timeout", "stop_settling", "late_success", "deadline_exhausted"] as const) {
  test(`parity turn observation and terminal cleanup: ${fault}`, async () => {
    const fake = productionBoatFixture(fault);
    const passed = await runProductionBoat(productionBoatEnv, fake.io, [...productionBoatArgs, "--feature", "send"]);
    expect(passed).toBe(!["turn_timeout", "late_success", "deadline_exhausted"].includes(fault));
    const report = JSON.parse(fake.lines.find((line) => line.startsWith('{"step":"provider_parity"')) ?? "{}");
    expect(report.features.cleanup.boat.status).toBe("pass");
    const cleanup = JSON.parse(fake.lines.find((line) => line.startsWith('{"step":"parity_cleanup"')) ?? "{}");
    expect(cleanup.deleted).toBe(true);
    if (fault === "slow_turn") {
      const timing = JSON.parse(fake.lines.find((line) => line.startsWith('{"step":"parity_turn"')) ?? "{}");
      expect(timing.polls).toBe(131);
      expect(timing.serverElapsedMs).toBe(180_000);
      expect(timing.elapsedMs).toBeGreaterThan(180_000);
    } else if (fault === "turn_timeout") {
      expect(report.features.send.boat.diagnostic).toMatchObject({
        code: "poll_limit_exceeded",
        polls: 200,
        elapsedMs: 600_000,
        serverElapsedMs: null,
      });
      expect(fake.lines.at(-1)).toContain("polls=200");
      expect(fake.lines.at(-1)).toContain("elapsedMs=600000");
    } else if (fault === "late_success" || fault === "deadline_exhausted") {
      expect(report.features.send.boat.diagnostic.code).toBe("poll_limit_exceeded");
      expect(report.features.send.boat.diagnostic.polls).toBe(fault === "late_success" ? 1 : 0);
    } else {
      const paths = fake.calls.map((call) => call.path);
      const firstDelete = paths.indexOf("sandbox/delete");
      expect(paths[firstDelete - 1]).toBe("sandbox/status");
      expect(paths.filter((path) => path === "sandbox/delete")).toHaveLength(3);
      expect(paths.filter((path) => path === "sandbox/stop")).toHaveLength(1);
      const requests = fake.calls.filter((call) => call.path === "sandbox/delete").map((call) => call.body.request_id);
      expect(new Set(requests).size).toBe(1);
    }
  });
}
