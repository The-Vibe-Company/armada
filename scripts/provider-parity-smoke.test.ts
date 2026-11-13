import { expect, test } from "bun:test";
import { postDeploySmoke } from "./post-deploy-smoke.ts";
import { smokeReceipts } from "./smoke-sandbox-cleanup.ts";

// The CLI boundary owns parity reporting: independent fake HTTP receipts catch
// route/receipt regressions without provider compute, credentials, or sleeps.
for (const mode of [
  "online",
  "offline",
  "unsupported",
  "delete_failure",
  "resume_failure",
  "filtered",
  "unimplemented",
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
] as const) {
  test(`parity normal lifecycle and honest reporting: ${mode}`, async () => {
    const lines: string[] = [];
    const calls: string[] = [];
    const deletes = new Map<string, number>();
    const prompts = new Map<string, string>();
    const states = new Map<string, string>();
    const providers = ["boat", "modal", "docker"];
    const passed = await postDeploySmoke(
      {
        ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
        ARMADA_TOKEN: "fake",
        ARMADA_SMOKE: "create_real_compute",
        ARMADA_SMOKE_CASES: JSON.stringify(
          providers.map((provider) => ({
            provider,
            org: provider,
            harness: "codex",
            model: "fake-model",
            modelAccountId: "fake-account",
            golden: "fake-golden",
            hostId: "owned-host",
          })),
        ),
      },
      mode === "filtered"
        ? ["--parity", "--only", "docker", "--feature", "exec"]
        : mode === "unimplemented"
          ? ["--parity", "--feature", "mcp"]
          : mode === "invalid_filter"
            ? ["--parity", "--feature", "typo"]
            : ["--parity"],
      {
        now: () => 0,
        sleep: async () => {},
        out: (line) => lines.push(line),
        recordSandbox: async (org, _id, requestKey) => {
          // Exercise the real journal validator, not a permissive callback.
          smokeReceipts([{ org, id: "12345678-1234-1234-1234-123456789abc", requestKey }]);
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
                    stop: true,
                    resume: !(id === "docker" && mode === "unsupported"),
                    delete: true,
                  },
                  unsupportedReasons: { resume: "Server resume disabled." },
                })),
              };
              break;
            case "docker/hosts/list":
              result = { hosts: [{ id: "owned-host", state: mode === "offline" ? "offline" : "online" }] };
              break;
            case "sandbox/launch":
              if (p === "docker") expect(body).not.toHaveProperty("image");
              if (p === "boat" && (mode === "quota" || mode === "server_failure"))
                return Response.json(
                  {
                    error: {
                      code: mode === "quota" ? "rate_limited" : "forbidden",
                      message:
                        mode === "quota"
                          ? "The Boat plan start limit per day has been reached."
                          : "Access denied. token=do-not-print ghp_abcdefghijklmnopqrstuvwxyz0123456789 sk-abcdefghijklmnopqrstuvwxyz eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl",
                      details: { secret: "do-not-print-details" },
                    },
                  },
                  { status: mode === "quota" ? 429 : 403 },
                );
              states.set(p, "ready");
              result = { sandbox: { id: p, provider: p } };
              break;
            case "sandbox/send":
              if (p !== "docker") expect(body.request_id).toBeUndefined();
              if (body.prompt.includes("Remember this token")) prompts.set(p, body.prompt.match(/PARITY_[a-z0-9]+/)[0]);
              states.set(p, p === "docker" ? "running" : "ready");
              result = { promptId: "turn-1" };
              break;
            case "logs/read":
              result = {
                events: [
                  { kind: "prompt", promptId: "turn-1", status: "finished" },
                  { kind: "message", promptId: "turn-1", text: `SMOKE_OK ${prompts.get(p)}` },
                ],
              };
              break;
            case "sandbox/exec":
              result = { exitCode: 0, timedOut: false, stdout: "PARITY_EXEC_OK" };
              break;
            case "sandbox/status":
              result = { id: p, status: states.get(p) };
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
    if (mode === "invalid_filter") {
      expect(passed).toBe(false);
      expect(calls).toHaveLength(0);
      expect(lines[0]).toContain("invalid_parity_filter");
      return;
    }
    const report = JSON.parse(lines.find((line) => line.startsWith('{"step":"provider_parity"'))!);
    if (mode === "filtered" || mode === "unimplemented") {
      expect(passed).toBe(true);
      if (mode === "unimplemented") {
        expect(calls).toHaveLength(0);
        expect(report.features.mcp.docker).toEqual({ status: "not-run", reason: "probe_not_implemented" });
      } else {
        expect(report.features.exec.docker.status).toBe("pass");
        expect(report.features.exec.boat.reason).toBe("provider_filtered");
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
    if (mode === "wrong_delete_id") {
      expect(passed).toBe(false);
      expect(report.features.cleanup.docker.status).toBe("fail");
      expect(
        lines.filter((line) => line.includes('"step":"parity_cleanup"')).every((line) => !JSON.parse(line).deleted),
      ).toBe(true);
      return;
    }
    expect(report.starts).toBe(mode === "offline" ? 2 : 3);
    if (mode === "quota" || mode === "server_failure") {
      const cell = report.features.launch.boat;
      expect(cell.status).toBe(mode === "quota" ? "not-run" : "fail");
      expect(cell.diagnostic.httpStatus).toBe(mode === "quota" ? 429 : 403);
      expect(cell.diagnostic.code).toBe(mode === "quota" ? "rate_limited" : "forbidden");
      expect(report.features.send.boat.status).toBe(cell.status);
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
      return;
    }
    if (mode === "delete_retry") expect(deletes.get("modal")).toBe(2);
    expect(report.features.launch.boat.status).toBe("pass");
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
