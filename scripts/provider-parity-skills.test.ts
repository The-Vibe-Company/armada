import { expect, test } from "bun:test";
import { providerParitySmoke } from "./provider-parity-smoke.ts";

// Owns the real parity HTTP boundary: exact pins, installed bytes, reporting and cleanup.
for (const mode of [
  "valid",
  "claude",
  "opencode",
  "missing",
  "source",
  "manifest",
  "status",
  "content",
  "no_exec",
  "no_followup",
  "resume_valid",
  "resume_content",
  "resume_status",
  "resume_quota",
  "resume_no_followup",
  "resume_no_resume",
  "resume_no_stop",
  "resume_budget",
  "resume_echo",
  "resume_missing",
] as const) {
  test(`skills delivery parity: ${mode}`, async () => {
    const harness = mode === "claude" ? "claude" : mode === "opencode" ? "opencode" : "codex";
    const reference = "parity-fixture@1.0.0";
    const digest = "a".repeat(64);
    const receipt = {
      reference,
      version: "1.0.0",
      skillId: "10000000-0000-4000-8000-000000000002",
      checksum: `sha256:${"b".repeat(64)}`,
      origin: "https://skillpack.app/v1",
    };
    const calls: string[] = [],
      lines: string[] = [];
    const states = new Map<string, string>();
    const resumed = new Set<string>();
    const executions = new Map<string, number>();
    let now = 0;
    const passed = await providerParitySmoke(
      {
        ARMADA_URL: "https://armada-mcp-staging.up.railway.app",
        ARMADA_TOKEN: "placeholder",
        ARMADA_SMOKE: "create_real_compute",
        ARMADA_SMOKE_CASES: JSON.stringify(
          ["modal", "docker"].map((provider) => ({
            provider,
            org: provider,
            harness,
            model: "fixture",
            modelAccountId: "account",
            golden: "golden",
            hostId: "host",
            template: { id: "10000000-0000-4000-8000-000000000001", revision: 1 },
            ...(mode === "missing" || mode === "resume_missing"
              ? {}
              : { skill: { reference, projectDir: "/home/user/project", fileSha256: digest } }),
          })),
        ),
      },
      {
        out: (line) => lines.push(line),
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        fetch: async (url, init) => {
          const route = url.split("/api/v1/")[1]!;
          const body = JSON.parse(String(init.body));
          const id = body.org;
          calls.push(`${id}:${route}`);
          let result: unknown;
          switch (route) {
            case "launch/options":
              result = {
                providers: ["modal", "docker"].map((id) => ({
                  id,
                  harnesses: [harness],
                  capabilities: {
                    launch: true,
                    exec: mode !== "no_exec",
                    stop: mode !== "resume_no_stop",
                    delete: true,
                    followupPrompts: mode !== "no_followup" && mode !== "resume_no_followup",
                    logs: true,
                    resume: mode !== "resume_no_resume",
                  },
                  unsupportedReasons: {},
                })),
              };
              break;
            case "docker/hosts/list":
              result = { hosts: [{ id: "host", state: "online" }] };
              break;
            case "templates/get":
              result = { revision: { revision: 1, definition: { skills: mode === "source" ? [] : [reference] } } };
              break;
            case "templates/launch":
              expect(body.skipSkillDefaults).toBe(true);
              states.set(id, "ready");
              result = {
                id,
                provider: id,
                state: "succeeded",
                manifest: {
                  templateId: body.id,
                  revision: 1,
                  account: { id: "account", version: 1 },
                  golden: { id: "golden", name: "golden", provider: id },
                  definition: {
                    provider: id,
                    harness,
                    model: "fixture",
                    goldenId: "golden",
                    hostId: "host",
                    skills: [reference],
                  },
                  skillReceipts: [{ ...receipt, version: mode === "manifest" ? "2.0.0" : "1.0.0" }],
                },
              };
              break;
            case "sandbox/status":
              result = {
                id: body.id,
                status: states.get(id),
                skills: [
                  {
                    ...receipt,
                    checksum:
                      mode === "status" || (mode === "resume_status" && resumed.has(id))
                        ? `sha256:${"c".repeat(64)}`
                        : receipt.checksum,
                  },
                ],
              };
              break;
            case "sandbox/exec":
              executions.set(id, (executions.get(id) ?? 0) + 1);
              if (mode === "resume_budget" && (executions.get(id) ?? 0) > 1) now += 110_001;
              expect(body.command).toContain(
                `/home/user/project/${harness === "claude" ? ".claude" : ".agents"}/skills/parity-fixture/SKILL.md`,
              );
              expect(Boolean(body.request_id)).toBe(id === "docker");
              result = {
                exitCode: 0,
                timedOut: false,
                stdout: mode === "content" || (mode === "resume_content" && resumed.has(id)) ? "wrong" : digest,
              };
              break;
            case "sandbox/send":
              if (mode === "resume_quota")
                return Response.json({ error: { code: "rate_limited", message: "fixture quota" } }, { status: 429 });
              expect(states.get(id)).toBe(id === "docker" ? "ready" : "stopped");
              resumed.add(id);
              states.set(id, "ready");
              result = { promptId: `wake_${id}` };
              break;
            case "logs/read":
              result = {
                events: [
                  { kind: "prompt", promptId: `wake_${id}`, status: "finished" },
                  {
                    id: "wake_answer",
                    kind: "message",
                    promptId: `wake_${id}`,
                    text: "SMOKE_OK",
                    partial: false,
                    responseKind: mode === "resume_echo" ? "tool_result" : "assistant",
                  },
                ],
              };
              break;
            case "sandbox/resume":
              expect(id).toBe("docker");
              expect(states.get(id)).toBe("stopped");
              states.set(id, "ready");
              result = { status: "ready" };
              break;
            case "sandbox/stop":
              states.set(id, "stopped");
              result = { id: body.id, status: "stopped" };
              break;
            case "sandbox/delete":
              states.set(id, "deleted");
              result = { id: body.id, status: "deleted" };
              break;
            default:
              throw Error(`Unexpected ${route}`);
          }
          return Response.json(result);
        },
      },
      ["--feature", mode.startsWith("resume_") ? "skills-resume" : "skills"],
    );
    if (mode.startsWith("resume_")) {
      expect(passed).toBe(!["resume_content", "resume_status", "resume_budget", "resume_echo"].includes(mode));
      const report = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((value) => value?.step === "provider_parity");
      const noAllocation = ["resume_missing", "resume_no_followup", "resume_no_resume", "resume_no_stop"].includes(
        mode,
      );
      expect(report.starts).toBe(noAllocation ? 0 : 2);
      for (const provider of ["modal", "docker"]) {
        expect(report.features["skills-resume"][provider].status).toBe(
          mode === "resume_missing" || mode === "resume_quota"
            ? "not-run"
            : ["resume_no_followup", "resume_no_resume", "resume_no_stop"].includes(mode)
              ? "unsupported"
              : mode === "resume_valid"
                ? "pass"
                : "fail",
        );
        if (noAllocation) expect(calls).not.toContain(`${provider}:templates/launch`);
        else {
          expect(report.features["skills-before-resume"][provider].status).toBe("pass");
          expect(report.features.cleanup[provider].status).toBe("pass");
          expect(calls.filter((call) => call === `${provider}:templates/launch`)).toHaveLength(1);
        }
        if (mode === "resume_valid") {
          expect(executions.get(provider)).toBe(2);
          expect(report.features["skills-after-resume"][provider].status).toBe("pass");
        }
      }
      return;
    }
    expect(passed).toBe(["valid", "claude", "opencode", "no_followup", "missing", "no_exec"].includes(mode));
    const report = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((value) => value?.step === "provider_parity");
    for (const provider of ["modal", "docker"]) {
      expect(report.features.skills[provider].status).toBe(
        ["valid", "claude", "opencode", "no_followup"].includes(mode) ? "pass" : "not-run",
      );
      if (["valid", "claude", "opencode", "no_followup", "manifest", "status", "content"].includes(mode)) {
        expect(calls).toContain(`${provider}:sandbox/delete`);
        expect(report.features.cleanup[provider].status).toBe("pass");
      }
      if (["missing", "source", "no_exec"].includes(mode)) expect(calls).not.toContain(`${provider}:templates/launch`);
    }
  });
}
