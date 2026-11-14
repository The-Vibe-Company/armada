import { expect, test } from "bun:test";
import { providerParitySmoke } from "./provider-parity-smoke.ts";

// Owns the real parity HTTP boundary: exact pins, installed bytes, reporting and cleanup.
for (const mode of ["valid", "missing", "source", "manifest", "status", "content", "no_exec"] as const) {
  test(`skills delivery parity: ${mode}`, async () => {
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
            harness: "codex",
            model: "fixture",
            modelAccountId: "account",
            golden: "golden",
            hostId: "host",
            template: { id: "10000000-0000-4000-8000-000000000001", revision: 1 },
            ...(mode === "missing"
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
                  harnesses: ["codex"],
                  capabilities: {
                    launch: true,
                    exec: mode !== "no_exec",
                    stop: true,
                    delete: true,
                    followupPrompts: true,
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
                    harness: "codex",
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
                skills: [{ ...receipt, checksum: mode === "status" ? `sha256:${"c".repeat(64)}` : receipt.checksum }],
              };
              break;
            case "sandbox/exec":
              expect(body.command).toContain("/home/user/project/.agents/skills/parity-fixture/SKILL.md");
              expect(Boolean(body.request_id)).toBe(id === "docker");
              result = { exitCode: 0, timedOut: false, stdout: mode === "content" ? "wrong" : digest };
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
      ["--feature", "skills"],
    );
    expect(passed).toBe(["valid", "missing", "no_exec"].includes(mode));
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
      expect(report.features.skills[provider].status).toBe(mode === "valid" ? "pass" : "not-run");
      if (["valid", "manifest", "status", "content"].includes(mode)) {
        expect(calls).toContain(`${provider}:sandbox/delete`);
        expect(report.features.cleanup[provider].status).toBe("pass");
      }
      if (["missing", "source", "no_exec"].includes(mode)) expect(calls).not.toContain(`${provider}:templates/launch`);
    }
  });
}
