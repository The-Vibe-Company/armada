import { expect, test } from "bun:test";
import { providerParitySmoke } from "./provider-parity-smoke.ts";

// Native MCP observations, not assistant prose, own the proof. Transport fixtures
// model Codex's combined call/result and Claude's separate cross-page tool-use ID join.
for (const mode of [
  "valid",
  "claude_valid",
  "claude_wrong_id",
  "missing",
  "opencode",
  "unsupported",
  "source",
  "disconnected",
  "manifest",
  "unbound",
  "echo_only",
  "wrong_server",
  "wrong_tool",
  "wrong_arguments",
  "tool_error",
  "wrong_output",
  "wrong_prompt",
  "child",
  "retracted",
  "later_page",
] as const) {
  test(`MCP canary parity: ${mode}`, async () => {
    const binding = {
      connectionId: "10000000-0000-4000-8000-000000000002",
      tool: "parity_probe",
      expectedText: `parity_mcp_${crypto.randomUUID()}`,
      readOnly: true,
    };
    const harness = mode.startsWith("claude_") ? "claude" : mode === "opencode" ? "opencode" : "codex";
    const server = `armada_${binding.connectionId.replaceAll("-", "_")}`;
    const states = new Map<string, string>(),
      answers = new Map<string, string>(),
      reads = new Map<string, number>();
    const calls: string[] = [],
      lines: string[] = [];
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
            ...(mode === "missing" ? {} : { mcp: binding }),
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
          const body = JSON.parse(String(init.body)),
            id = body.org;
          calls.push(`${id}:${route}`);
          expect(JSON.stringify(body)).not.toContain(binding.expectedText);
          let result: unknown;
          switch (route) {
            case "launch/options":
              result = {
                providers: ["modal", "docker"].map((id) => ({
                  id,
                  harnesses: [harness],
                  capabilities: {
                    launch: true,
                    mcp: mode !== "unsupported",
                    followupPrompts: true,
                    stop: true,
                    delete: true,
                  },
                  unsupportedReasons: {},
                })),
              };
              break;
            case "templates/get":
              result = {
                revision: { revision: 1, definition: { connections: mode === "source" ? [] : [binding.connectionId] } },
              };
              break;
            case "mcp/list":
              result = {
                connections: [
                  { id: binding.connectionId, status: mode === "disconnected" ? "needs_reconnect" : "connected" },
                ],
              };
              break;
            case "docker/hosts/list":
              result = { hosts: [{ id: "host", state: "online" }] };
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
                    harness,
                    model: "fixture",
                    goldenId: "golden",
                    hostId: "host",
                    connections: [binding.connectionId],
                  },
                  connections: [{ id: binding.connectionId, version: mode === "manifest" ? 0 : 1, generation: 1 }],
                },
              };
              break;
            case "mcp/sandbox-connections":
              result = { connections: mode === "unbound" ? [] : [{ id: binding.connectionId, status: "connected" }] };
              break;
            case "sandbox/send":
              expect(Boolean(body.request_id)).toBe(id === "docker");
              expect(body.prompt).toContain(binding.tool);
              expect(body.prompt).toContain("empty JSON arguments {}");
              answers.set(id, String(body.prompt).match(/PARITY_MCP_DONE_[a-f0-9-]{36}/)![0]);
              result = { promptId: `turn_${id}` };
              break;
            case "logs/read": {
              const n = (reads.get(id) ?? 0) + 1;
              reads.set(id, n);
              const promptId = mode === "wrong_prompt" ? "other" : `turn_${id}`;
              const toolResult = {
                output: { content: [{ type: "text", text: mode === "wrong_output" ? "wrong" : binding.expectedText }] },
                isError: mode === "tool_error",
              };
              const tool = {
                id: "call",
                name:
                  mode === "wrong_tool"
                    ? "shell"
                    : harness === "claude"
                      ? `mcp__${server}__${binding.tool}`
                      : binding.tool,
                server: mode === "wrong_server" ? "unrelated" : server,
                input: mode === "wrong_arguments" ? { unexpected: true } : {},
                ...(harness === "claude" ? {} : { result: toolResult }),
              };
              const toolMessage = {
                id: "tool_message",
                kind: "message",
                promptId,
                partial: false,
                text: "",
                tools: mode === "echo_only" ? [] : [tool],
                parentToolUseId: mode === "child" ? "parent" : undefined,
                retracted: mode === "retracted" && n > 1,
              };
              const claudePage = harness === "claude";
              result = {
                cursor: `page_${n}`,
                hasMore: (claudePage || mode === "later_page" || mode === "retracted") && n === 1,
                events: [
                  ...(claudePage && n > 1
                    ? [
                        {
                          id: "result_message",
                          kind: "message",
                          promptId,
                          partial: false,
                          text: "",
                          responseKind: "tool_result",
                          tools: [
                            {
                              id: mode === "claude_wrong_id" ? "other_call" : "call",
                              name: "tool_result",
                              result: toolResult,
                            },
                          ],
                        },
                      ]
                    : [toolMessage]),
                  {
                    id: "answer",
                    kind: "message",
                    promptId: `turn_${id}`,
                    partial: false,
                    responseKind: "assistant",
                    text: answers.get(id),
                    tools: [],
                  },
                  ...(mode === "later_page" && n > 1
                    ? [
                        {
                          id: "later",
                          kind: "message",
                          promptId: `turn_${id}`,
                          partial: false,
                          responseKind: "assistant",
                          text: "different final answer",
                          tools: [],
                        },
                      ]
                    : []),
                  { id: "finished", kind: "prompt", promptId: `turn_${id}`, status: "finished" },
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
              states.set(id, "deleted");
              result = { id: body.id, status: "deleted" };
              break;
            default:
              throw Error(`Unexpected ${route}`);
          }
          return Response.json(result);
        },
      },
      ["--feature", "mcp"],
    );
    const noAllocation = ["missing", "opencode", "unsupported", "source", "disconnected"].includes(mode);
    expect(passed).toBe(["valid", "claude_valid", "missing", "opencode", "unsupported"].includes(mode));
    const report = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((v) => v?.step === "provider_parity");
    expect(report.starts).toBe(noAllocation ? 0 : 2);
    for (const provider of ["modal", "docker"]) {
      expect(report.features.mcp[provider].status).toBe(
        ["valid", "claude_valid"].includes(mode) ? "pass" : mode === "unsupported" ? "unsupported" : "not-run",
      );
      if (noAllocation) expect(calls).not.toContain(`${provider}:templates/launch`);
      else {
        expect(calls).toContain(`${provider}:sandbox/delete`);
        expect(report.features.cleanup[provider].status).toBe("pass");
      }
      expect(calls).not.toContain(`${provider}:sandbox/exec`);
    }
    expect(lines.join("\n")).not.toContain(binding.expectedText);
  });
}

test("production Boat MCP defers incomplete native provenance without allocation", async () => {
  const lines: string[] = [];
  const passed = await providerParitySmoke(
    {
      ARMADA_URL: "https://production-fixture.invalid",
      ARMADA_TOKEN: "placeholder",
      ARMADA_SMOKE: "create_real_compute",
      ARMADA_SMOKE_CASES: JSON.stringify([
        {
          provider: "boat",
          org: "fixture",
          harness: "codex",
          model: "fixture",
          modelAccountId: "account",
          golden: "golden",
          template: { id: "10000000-0000-4000-8000-000000000001", revision: 1 },
          mcp: {
            connectionId: "10000000-0000-4000-8000-000000000002",
            tool: "parity_probe",
            expectedText: `parity_mcp_${crypto.randomUUID()}`,
            readOnly: true,
          },
        },
      ]),
    },
    {
      out: (line) => lines.push(line),
      now: () => 0,
      sleep: async () => {
        throw Error("unexpected wait");
      },
      fetch: async () => {
        throw Error("must not allocate or discover");
      },
    },
    ["--production-boat", "--only", "boat", "--feature", "mcp"],
  );
  expect(passed).toBe(true);
  const report = lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((value) => value?.step === "provider_parity");
  expect(report.starts).toBe(0);
  expect(report.features.mcp.boat).toEqual({
    status: "not-run",
    reason: "native_boat_mcp_evidence_probe_not_implemented",
  });
});
