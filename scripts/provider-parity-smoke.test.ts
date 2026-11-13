import { expect, test } from "bun:test";
import { postDeploySmoke } from "./post-deploy-smoke.ts";

// The CLI boundary owns parity reporting: independent fake HTTP receipts catch
// route/receipt regressions without provider compute, credentials, or sleeps.
for (const mode of ["online", "offline", "unsupported", "delete_failure", "resume_failure"] as const) {
  test(`parity normal lifecycle and honest reporting: ${mode}`, async () => {
    const lines: string[] = [];
    const calls: string[] = [];
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
            image: "fake-image@sha256:abc",
          })),
        ),
      },
      ["--parity"],
      {
        now: () => 0,
        sleep: async () => {},
        out: (line) => lines.push(line),
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
              states.set(p, "ready");
              result = { sandbox: { id: p, provider: p } };
              break;
            case "sandbox/send":
              if (p !== "docker") expect(body.request_id).toBeUndefined();
              states.set(p, "ready");
              result = { promptId: "turn-1" };
              break;
            case "logs/read":
              result = {
                events: [
                  { kind: "prompt", promptId: "turn-1", status: "finished" },
                  { kind: "message", promptId: "turn-1", text: "SMOKE_OK" },
                ],
              };
              break;
            case "sandbox/status":
              result = { id: p, ...(p === "docker" ? { provider: p } : {}), status: states.get(p) };
              break;
            case "sandbox/stop":
              states.set(p, "stopped");
              result = { status: "stopped" };
              break;
            case "sandbox/resume":
              expect(p).toBe("docker");
              states.set(p, "ready");
              if (mode === "resume_failure") throw new Error("lost_resume_response");
              result = { status: "ready" };
              break;
            case "sandbox/delete":
              expect(states.get(p)).toBe("stopped");
              result = { status: mode === "delete_failure" && p === "docker" ? "pending" : "deleted" };
              break;
            default:
              throw new Error(`Unexpected route ${path}`);
          }
          return Response.json(result);
        },
      },
    );
    const report = JSON.parse(lines.find((line) => line.startsWith('{"step":"provider_parity"'))!);
    expect(report.features.launch.boat.status).toBe("pass");
    expect(report.features.delete.modal.status).toBe("pass");
    expect(passed).toBe(mode === "online" || mode === "unsupported");
    expect(lines.at(-1)).toContain("| Feature | Boat | Modal | Docker |");
    if (mode === "offline") {
      expect(report.features.launch.docker).toEqual({ status: "fail", reason: "host_offline" });
      expect(calls).not.toContain("docker:sandbox/launch");
      expect(lines.filter((line) => line.includes('"step":"host_offline"'))).toHaveLength(1);
    } else if (mode === "unsupported") {
      expect(report.features.resume.docker).toEqual({ status: "unsupported", reason: "Server resume disabled." });
      expect(calls).not.toContain("docker:sandbox/resume");
    } else if (mode === "resume_failure") expect(report.features.resume.docker.status).toBe("fail");
    else if (mode === "delete_failure") expect(report.features.delete.docker.status).toBe("fail");
    else expect(report.features.resume.docker.status).toBe("pass");
  });
}
