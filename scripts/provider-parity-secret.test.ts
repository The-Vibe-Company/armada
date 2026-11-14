import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { parseApplicationSecretBindings } from "../packages/core/src/application-secret-bindings.ts";
import { providerParitySmoke } from "./provider-parity-smoke.ts";

// Owns real parity request/reporting/cleanup and executes the generated guest program as a function,
// with no process, provider, wall-clock wait or plaintext API access.
for (const mode of [
  "valid",
  "missing",
  "unsupported",
  "no_exec",
  "source",
  "rotated",
  "expiry",
  "manifest",
  "wrong_environment",
  "wrong_answer",
  "echo",
  "later_page",
  "cleanup_lost",
] as const) {
  test(`application-secret parity: ${mode}`, async () => {
    const value = `parity_secret_${crypto.randomUUID()}`;
    const binding = {
      id: "10000000-0000-4000-8000-000000000002",
      version: 1,
      key: "PARITY_SECRET_CANARY",
      canarySha256: createHash("sha256").update(value).digest("hex"),
    };
    const refs = parseApplicationSecretBindings([{ key: binding.key, secretId: binding.id, version: 1 }]);
    const calls: string[] = [],
      lines: string[] = [];
    const states = new Map<string, string>(),
      digests = new Map<string, string>();
    const reads = new Map<string, number>();
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
            ...(mode === "missing" ? {} : { applicationSecret: binding }),
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
          expect(JSON.stringify(body)).not.toContain(value);
          expect(JSON.stringify(body)).not.toContain(binding.canarySha256);
          let result: unknown;
          switch (route) {
            case "launch/options":
              result = {
                providers: ["modal", "docker"].map((id) => ({
                  id,
                  harnesses: ["codex"],
                  capabilities: {
                    launch: true,
                    secrets: mode !== "unsupported",
                    exec: mode !== "no_exec",
                    followupPrompts: true,
                    stop: true,
                    delete: true,
                  },
                  unsupportedReasons: { secrets: "fixture_unavailable" },
                })),
              };
              break;
            case "docker/hosts/list":
              result = { hosts: [{ id: "host", state: "online" }] };
              break;
            case "templates/get":
              result = { revision: { revision: 1, definition: { secrets: mode === "source" ? [] : refs } } };
              break;
            case "secrets/list":
              result = {
                items: [
                  {
                    id: binding.id,
                    version: mode === "rotated" ? 2 : 1,
                    status: "active",
                    expiresAt: mode === "expiry" ? "2099-01-01T00:00:00Z" : null,
                  },
                ],
              };
              break;
            case "templates/launch":
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
                    secrets: mode === "manifest" ? [{ ...refs[0], version: 2 }] : refs,
                  },
                },
              };
              break;
            case "sandbox/exec": {
              expect(Boolean(body.request_id)).toBe(id === "docker");
              const program = String(body.command).slice("node -e '".length, -1).replaceAll("'\\''", "'");
              let output = "",
                exitCode = 0;
              try {
                runInNewContext(program, {
                  require: (name: string) => {
                    expect(name).toBe("node:crypto");
                    return { createHash };
                  },
                  process: {
                    env: { [binding.key]: mode === "wrong_environment" ? "ordinary_placeholder" : value },
                    exit: () => {
                      throw Error("guest refusal");
                    },
                    stdout: {
                      write: (text: string) => {
                        output += text;
                      },
                    },
                  },
                });
              } catch {
                exitCode = 1;
              }
              digests.set(id, output);
              result = { exitCode, timedOut: false, stdout: output };
              break;
            }
            case "sandbox/send":
              expect(body.prompt).toContain("node -e");
              result = { promptId: `turn_${id}` };
              break;
            case "logs/read": {
              const n = (reads.get(id) ?? 0) + 1;
              reads.set(id, n);
              result = {
                cursor: `page_${n}`,
                hasMore: mode === "later_page" && n === 1,
                events: [
                  { id: "finished", kind: "prompt", promptId: `turn_${id}`, status: "finished" },
                  {
                    id: "answer",
                    kind: "message",
                    promptId: `turn_${id}`,
                    partial: false,
                    responseKind: mode === "echo" ? "tool_result" : "assistant",
                    text: mode === "wrong_answer" ? "wrong" : digests.get(id),
                  },
                  ...(mode === "later_page" && n > 1
                    ? [
                        {
                          id: "later",
                          kind: "message",
                          promptId: `turn_${id}`,
                          partial: false,
                          responseKind: "assistant",
                          text: "superseded",
                        },
                      ]
                    : []),
                ],
              };
              break;
            }
            case "sandbox/status":
              result = { id: body.id, status: states.get(id) };
              break;
            case "sandbox/stop":
              states.set(id, "stopped");
              result = { id: body.id, status: "stopped" };
              break;
            case "sandbox/delete":
              if (mode === "cleanup_lost")
                return Response.json({ error: { code: "forbidden", message: "fixture refusal" } }, { status: 403 });
              states.set(id, "deleted");
              result = { id: body.id, status: "deleted" };
              break;
            default:
              throw Error(`Unexpected ${route}`);
          }
          return Response.json(result);
        },
      },
      ["--feature", "application-secrets"],
    );
    expect(passed).toBe(["valid", "missing", "unsupported", "no_exec", "expiry"].includes(mode));
    const report = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((v) => v?.step === "provider_parity");
    for (const provider of ["modal", "docker"]) {
      expect(report.features["application-secrets"][provider].status).toBe(
        ["valid", "cleanup_lost"].includes(mode) ? "pass" : mode === "unsupported" ? "unsupported" : "not-run",
      );
      if (
        ["valid", "manifest", "wrong_environment", "wrong_answer", "echo", "later_page", "cleanup_lost"].includes(mode)
      ) {
        expect(calls).toContain(`${provider}:sandbox/delete`);
        expect(report.features.cleanup[provider].status).toBe(mode === "cleanup_lost" ? "fail" : "pass");
      } else expect(calls).not.toContain(`${provider}:templates/launch`);
    }
    expect(lines.join("\n")).not.toContain(value);
    expect(lines.join("\n")).not.toContain(binding.canarySha256);
    expect(calls.filter((path) => path.includes("secrets/")).every((path) => path.endsWith("secrets/list"))).toBe(true);
  });
}
