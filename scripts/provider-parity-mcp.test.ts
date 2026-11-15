import { expect, test } from "bun:test";
import { exportedToolProofs } from "../packages/agent-runtime/src/opencode-export-observations.ts";
import { providerParitySmoke } from "./provider-parity-smoke.ts";

// Native MCP observations, not assistant prose, own the proof. Transport fixtures
// model Codex's combined call/result and Claude's separate cross-page tool-use ID join.
for (const scenario of [
  "valid",
  "resume_valid",
  "resume_claude",
  "opencode_resume_valid",
  "resume_stale_prompt",
  "resume_tool_error",
  "resume_disconnected",
  "resume_quota",
  "resume_no_stop",
  "resume_budget",
  "resume_stop_budget",
  "resume_missing",
  "opencode_resume_collision",
  "claude_valid",
  "claude_wrong_id",
  "missing",
  "opencode",
  "opencode_valid",
  "opencode_docker_unadvertised",
  "opencode_inventory_missing",
  "opencode_collision",
  "opencode_inventory_changed",
  "opencode_inventory_late",
  "opencode_no_native",
  "opencode_foreign_prompt",
  "opencode_wrong_server",
  "opencode_wrong_tool",
  "opencode_missing_message",
  "opencode_missing_call",
  "opencode_missing_revision",
  "opencode_wrong_input",
  "opencode_error",
  "opencode_wrong_result",
  "opencode_non_native_output",
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
  { mode: "opencode_valid", boat: true },
  { mode: "opencode_resume_valid", boat: true },
  { mode: "opencode_wrong_server", boat: true },
  { mode: "opencode_no_native", boat: true },
  { mode: "opencode", boat: true },
  { mode: "opencode_valid", boat: true, nativeDefault: true },
  { mode: "opencode_resume_valid", boat: true, missingCheckpointVersion: true },
  { mode: "opencode_resume_valid", boat: true, invalidCheckpoint: "ack" },
  { mode: "opencode_resume_valid", boat: true, invalidCheckpoint: "epoch" },
] as const) {
  const boat = typeof scenario === "object";
  const mode = boat ? scenario.mode : scenario;
  const nativeDefault = boat && "nativeDefault" in scenario;
  const missingCheckpointVersion = boat && "missingCheckpointVersion" in scenario;
  const invalidCheckpoint = boat && "invalidCheckpoint" in scenario ? scenario.invalidCheckpoint : undefined;
  const providers = boat ? ["boat"] : ["modal", "docker"];
  test(`MCP canary parity: ${boat ? "production Boat " : ""}${mode}${nativeDefault ? " native default" : ""}${missingCheckpointVersion ? " missing checkpoint version" : ""}${invalidCheckpoint ? ` invalid checkpoint ${invalidCheckpoint}` : ""}`, async () => {
    const binding = {
      connectionId: "10000000-0000-4000-8000-000000000002",
      tool: "parity_probe",
      expectedText: `parity_mcp_${crypto.randomUUID()}`,
      readOnly: true,
    };
    const deep = mode.startsWith("resume_") || mode.startsWith("opencode_resume_");
    const harness =
      mode.startsWith("claude_") || mode === "resume_claude"
        ? "claude"
        : mode.startsWith("opencode")
          ? "opencode"
          : "codex";
    const server = `armada_${binding.connectionId.replaceAll("-", "_")}`;
    const states = new Map<string, string>(),
      answers = new Map<string, string>(),
      reads = new Map<string, number>();
    const inventoryReads = new Map<string, number>();
    const turns = new Map<string, number>();
    const calls: string[] = [],
      lines: string[] = [];
    let now = 0;
    const passed = await providerParitySmoke(
      {
        ARMADA_URL: boat ? "https://production-fixture.invalid" : "https://armada-mcp-staging.up.railway.app",
        ARMADA_TOKEN: "placeholder",
        ARMADA_SMOKE: "create_real_compute",
        ARMADA_SMOKE_CASES: JSON.stringify(
          providers.map((provider) => ({
            provider,
            org: provider,
            harness,
            model: "fixture",
            modelAccountId: "account",
            golden: "golden",
            hostId: "host",
            template: { id: "10000000-0000-4000-8000-000000000001", revision: 1 },
            ...(mode === "missing" || mode === "resume_missing" ? {} : { mcp: binding }),
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
                ...(mode.startsWith("opencode_")
                  ? {
                      modalRuntime: { opencodeMcpProofVersion: 1 },
                      ...(mode === "opencode_docker_unadvertised"
                        ? {}
                        : { dockerRuntime: { opencodeMcpProofVersion: 1 } }),
                    }
                  : {}),
                boatRuntime: {
                  enabled: true,
                  defaultPath: nativeDefault ? "native" : "runtime",
                  opencodeVersion: 1,
                  ...(mode.startsWith("opencode_") ? { opencodeMcpProofVersion: 1 } : {}),
                  checkpointVersion: missingCheckpointVersion ? 0 : 1,
                  resumeVersion: 1,
                },
                providers: providers.map((id) => ({
                  id,
                  harnesses: [harness],
                  capabilities: {
                    launch: true,
                    mcp: mode !== "unsupported",
                    followupPrompts: true,
                    stop: mode !== "resume_no_stop",
                    resume: true,
                    logs: true,
                    delete: true,
                  },
                  unsupportedReasons: {},
                })),
              };
              break;
            case "sandbox/mcp-preflight-v1": {
              expect(body).toMatchObject({
                runtimeVersion: 1,
                connections: [binding.connectionId],
                toolInventory: true,
              });
              const n = (inventoryReads.get(id) ?? 0) + 1;
              inventoryReads.set(id, n);
              if (mode === "opencode_inventory_late" && n > 1) now += 110_001;
              result = {
                mcpReady: true,
                connections: [binding.connectionId],
                mcpToolInventory:
                  mode === "opencode_inventory_missing"
                    ? undefined
                    : [
                        {
                          connectionId: binding.connectionId,
                          tools: [
                            binding.tool,
                            ...(mode === "opencode_collision" ? ["parity.probe"] : []),
                            ...(mode === "opencode_inventory_changed" && n > 1 ? ["new_tool"] : []),
                            ...(mode === "opencode_resume_collision" && n >= 3 ? ["parity.probe"] : []),
                          ],
                        },
                      ],
              };
              break;
            }
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
              result = {
                connections:
                  mode === "unbound" || (mode === "resume_disconnected" && (turns.get(id) ?? 0) > 0)
                    ? []
                    : [{ id: binding.connectionId, status: "connected" }],
              };
              break;
            case "sandbox/send":
              if (deep && (turns.get(id) ?? 0) > 0 && mode === "resume_quota")
                return Response.json({ error: { code: "rate_limited", message: "fixture quota" } }, { status: 429 });
              if (deep && (turns.get(id) ?? 0) > 0) expect(states.get(id)).toBe(id === "docker" ? "ready" : "stopped");
              turns.set(id, (turns.get(id) ?? 0) + 1);
              reads.set(id, 0);
              states.set(id, "ready");
              expect(Boolean(body.request_id)).toBe(id === "docker" || id === "boat");
              expect(body.prompt).toContain(binding.tool);
              expect(body.prompt).toContain("empty JSON arguments {}");
              answers.set(id, String(body.prompt).match(/PARITY_MCP_DONE_[a-f0-9-]{36}/)![0]);
              result = {
                promptId: `turn_${id}_${turns.get(id)}`,
                ...(boat ? { runtime: { kind: "armada", epoch: String(turns.get(id)) } } : {}),
              };
              break;
            case "logs/read": {
              const n = (reads.get(id) ?? 0) + 1;
              reads.set(id, n);
              const actualPrompt = `turn_${id}_${turns.get(id)}`;
              const promptId =
                mode === "wrong_prompt"
                  ? "other"
                  : mode === "resume_stale_prompt" && (turns.get(id) ?? 0) > 1
                    ? `turn_${id}_1`
                    : actualPrompt;
              if (mode === "resume_budget" && (turns.get(id) ?? 0) > 1) now += 110_001;
              const toolResult = {
                output: { content: [{ type: "text", text: mode === "wrong_output" ? "wrong" : binding.expectedText }] },
                isError: mode === "tool_error" || (mode === "resume_tool_error" && (turns.get(id) ?? 0) > 1),
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
              let native: { type: string; data: Record<string, unknown> }[] = [];
              if (harness === "opencode" && mode !== "opencode_no_native") {
                native = exportedToolProofs(
                  {
                    info: { id: "session" },
                    messages: [
                      {
                        info: { id: "native_message", role: "assistant", sessionID: "session", time: { completed: 1 } },
                        parts: [
                          {
                            type: "tool",
                            sessionID: "session",
                            messageID: "native_message",
                            callID: "native_call",
                            tool: `${server}_${binding.tool}`,
                            state: {
                              status: "completed",
                              input: {},
                              output: binding.expectedText,
                              metadata: { truncated: false },
                            },
                          },
                        ],
                      },
                    ],
                  },
                  new Set(),
                  {
                    revision: "fixture-revision",
                    servers: { [server]: { type: "http", url: "https://fixture.invalid/mcp" } },
                  },
                );
                expect(native).toHaveLength(1);
                const data = native[0]!.data;
                if (mode === "opencode_wrong_server") data.server = "unrelated";
                if (mode === "opencode_wrong_tool") data.nativeToolName = `${server}_different_tool`;
                if (mode === "opencode_missing_message") data.nativeMessageId = "";
                if (mode === "opencode_missing_call") data.callId = "";
                if (mode === "opencode_missing_revision") data.configurationRevision = "";
                if (mode === "opencode_wrong_input") data.input = { unexpected: true };
                if (mode === "opencode_error") data.result = { output: binding.expectedText, isError: true };
                if (mode === "opencode_wrong_result") data.result = { output: "wrong", isError: false };
                if (mode === "opencode_non_native_output")
                  data.result = { output: { content: [{ type: "text", text: binding.expectedText }] }, isError: false };
              }
              result = {
                cursor: `page_${n}`,
                hasMore: (claudePage || mode === "later_page" || mode === "retracted") && n === 1,
                events: [
                  ...native.map((proof) => ({
                    id: "native_proof",
                    kind: "other",
                    promptId: mode === "opencode_foreign_prompt" ? "old_prompt" : promptId,
                    ...proof,
                  })),
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
                    promptId: actualPrompt,
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
                          promptId: actualPrompt,
                          partial: false,
                          responseKind: "assistant",
                          text: "different final answer",
                          tools: [],
                        },
                      ]
                    : []),
                  { id: "finished", kind: "prompt", promptId: actualPrompt, status: "finished" },
                ],
              };
              break;
            }
            case "sandbox/resume":
              expect(id).toBe("docker");
              expect(states.get(id)).toBe("stopped");
              states.set(id, "ready");
              result = { status: "ready" };
              break;
            case "sandbox/status":
              result = { id: body.id, status: states.get(id) };
              break;
            case "sandbox/checkpoint-runtime-v1":
              expect(boat && deep).toBe(true);
              expect(body.runtimeVersion).toBe(1);
              expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);
              expect(states.get(id)).toBe("ready");
              result = {
                id,
                requestId: body.request_id,
                runtime: { kind: "armada", epoch: invalidCheckpoint === "epoch" ? "99" : String(turns.get(id)) },
                checkpoint: {
                  state: "complete",
                  watermark: 10,
                  acknowledgedSequence: invalidCheckpoint === "ack" ? 9 : 10,
                },
              };
              break;
            case "sandbox/stop":
              states.set(id, "stopped");
              if (mode === "resume_stop_budget") now += 110_001;
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
      [...(boat ? ["--production-boat", "--only", "boat"] : []), "--feature", deep ? "mcp-resume" : "mcp"],
    );
    if (nativeDefault || missingCheckpointVersion || invalidCheckpoint) {
      const report = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((value) => value?.step === "provider_parity");
      expect(report.starts).toBe(invalidCheckpoint ? 1 : 0);
      if (invalidCheckpoint) {
        expect(passed).toBe(false);
        expect(report.features["prerequisite:stop"].boat.status).toBe("fail");
        expect(calls.filter((call) => call === "boat:sandbox/send")).toHaveLength(1);
        expect(report.features.cleanup.boat.status).toBe("pass");
      } else {
        expect(passed).toBe(true);
        expect(report.features[deep ? "mcp-resume" : "mcp"].boat.status).toBe("not-run");
        expect(calls).not.toContain("boat:templates/launch");
      }
      return;
    }
    if (deep) {
      const noAllocation = mode === "resume_missing" || mode === "resume_no_stop";
      expect(passed).toBe(
        [
          "resume_valid",
          "resume_claude",
          "opencode_resume_valid",
          "resume_missing",
          "resume_no_stop",
          "resume_quota",
        ].includes(mode),
      );
      const report = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .find((value) => value?.step === "provider_parity");
      expect(report.starts).toBe(noAllocation ? 0 : providers.length);
      for (const provider of providers) {
        expect(report.features["mcp-resume"][provider].status).toBe(
          mode === "resume_missing" || mode === "resume_quota" || mode === "resume_stop_budget"
            ? "not-run"
            : mode === "resume_no_stop"
              ? "unsupported"
              : ["resume_valid", "resume_claude", "opencode_resume_valid"].includes(mode)
                ? "pass"
                : "fail",
        );
        if (noAllocation) expect(calls).not.toContain(`${provider}:templates/launch`);
        else {
          expect(report.features["mcp-before-resume"][provider].status).toBe("pass");
          expect(report.features.cleanup[provider].status).toBe("pass");
          expect(calls.filter((path) => path === `${provider}:templates/launch`)).toHaveLength(1);
          if (["resume_valid", "resume_claude", "opencode_resume_valid"].includes(mode)) {
            expect(turns.get(provider)).toBe(2);
            expect(report.features["mcp-after-resume"][provider].status).toBe("pass");
          }
          if (mode === "opencode_resume_collision") expect(turns.get(provider)).toBe(1);
          if (mode === "resume_stop_budget") {
            expect(report.features["prerequisite:stop"][provider].status).toBe("fail");
            expect(turns.get(provider)).toBe(1);
            expect(calls).not.toContain(`${provider}:sandbox/resume`);
          }
        }
      }
      if (mode === "opencode_resume_valid") {
        for (const provider of providers) expect(inventoryReads.get(provider)).toBe(4);
      }
      expect(lines.join("\n")).not.toContain(binding.expectedText);
      return;
    }
    const noAllocation = [
      "missing",
      "opencode",
      "unsupported",
      "source",
      "disconnected",
      "opencode_inventory_missing",
      "opencode_collision",
    ].includes(mode);
    expect(passed).toBe(
      [
        "valid",
        "claude_valid",
        "missing",
        "opencode",
        "opencode_valid",
        "opencode_docker_unadvertised",
        "unsupported",
      ].includes(mode),
    );
    const report = lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((v) => v?.step === "provider_parity");
    expect(report.starts).toBe(noAllocation ? 0 : mode === "opencode_docker_unadvertised" ? 1 : providers.length);
    for (const provider of providers) {
      expect(report.features.mcp[provider].status).toBe(
        ["valid", "claude_valid", "opencode_valid"].includes(mode) ||
          (mode === "opencode_docker_unadvertised" && provider === "modal")
          ? "pass"
          : mode === "unsupported"
            ? "unsupported"
            : "not-run",
      );
      if (noAllocation || (mode === "opencode_docker_unadvertised" && provider === "docker"))
        expect(calls).not.toContain(`${provider}:templates/launch`);
      else {
        expect(calls).toContain(`${provider}:sandbox/delete`);
        expect(report.features.cleanup[provider].status).toBe("pass");
      }
      expect(calls).not.toContain(`${provider}:sandbox/exec`);
      if (mode === "opencode_docker_unadvertised" && provider === "docker")
        expect(report.features.mcp.docker.reason).toBe("opencode_mcp_native_proof_not_advertised");
    }
    expect(lines.join("\n")).not.toContain(binding.expectedText);
    if (mode === "opencode_valid" || mode === "opencode_inventory_changed" || mode === "opencode_inventory_late")
      for (const provider of providers) expect(inventoryReads.get(provider)).toBe(2);
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
