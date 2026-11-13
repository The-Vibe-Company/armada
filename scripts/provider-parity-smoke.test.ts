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
