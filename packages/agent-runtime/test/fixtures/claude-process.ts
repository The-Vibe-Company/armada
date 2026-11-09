#!/usr/bin/env bun
// Official SDK control/message shapes; synthetic peer, NOT authenticated Claude evidence.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

if (process.env.ARMADA_MCP_INSPECTION) {
  const header = "mcp-header-fixture-sensitive",
    stdio = "mcp-env-fixture-sensitive";
  const argv = readFileSync("/proc/self/cmdline", "utf8");
  const index = process.argv.indexOf("--mcp-config");
  const input = process.argv[index + 1] ?? "";
  let config: { mcpServers?: Record<string, { headers?: Record<string, string>; env?: Record<string, string> }> },
    pathOnly = false,
    fileMode = -1,
    directoryMode = -1,
    noSymlink = false;
  try {
    config = JSON.parse(input);
  } catch {
    pathOnly = true;
    config = JSON.parse(readFileSync(input, "utf8"));
    fileMode = statSync(input).mode & 0o777;
    directoryMode = statSync(dirname(input)).mode & 0o777;
    noSymlink = !lstatSync(input).isSymbolicLink();
  }
  const credentials = Object.values(config.mcpServers ?? {})
    .flatMap((v) => Object.values(v.headers ?? v.env ?? {}))
    .filter((v) => typeof v === "string" && v.length >= 8);
  writeFileSync(
    process.env.ARMADA_MCP_INSPECTION,
    JSON.stringify({
      pathOnly,
      configPath: pathOnly ? input : null,
      directoryPath: pathOnly ? readlinkSync(dirname(input)) : null,
      fileMode,
      directoryMode,
      noSymlink,
      argvLeak: credentials.some((v) => argv.includes(v)),
      environmentLeak: Object.values(process.env).some((v) => credentials.some((secret) => v?.includes(secret))),
      configured:
        config.mcpServers?.remote?.headers?.Authorization === header &&
        config.mcpServers?.local?.env?.PRIVATE_MCP_VALUE === stdio,
      strict: process.argv.includes("--strict-mcp-config"),
      serverNames: Object.keys(config.mcpServers ?? {}),
      headerFingerprint: config.mcpServers?.remote?.headers?.Authorization
        ? createHash("sha256").update(config.mcpServers.remote.headers.Authorization).digest("hex")
        : null,
      resumed: process.argv.some((arg) => arg === "--resume" || arg.startsWith("--resume=")),
    }),
  );
  if (config.mcpServers?.remote?.headers?.Authorization)
    process.stderr.write(config.mcpServers.remote.headers.Authorization);
}
const send = (data: unknown) => process.stdout.write(`${JSON.stringify(data)}\n`);
let initial: string | undefined;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.type === "control_request") {
    send({
      type: "control_response",
      response: { subtype: "success", request_id: m.request_id, response: { commands: [], models: [], account: {} } },
    });
  } else if (m.type === "user") {
    if (process.env.ARMADA_CWD_PROOF) {
      const path = "native-cwd-proof.json";
      let prior: { cwd: string; resumed: boolean; inputs: string[] };
      try {
        prior = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        prior = {
          cwd: process.cwd(),
          resumed: process.argv.some((arg) => arg === "--resume" || arg.startsWith("--resume=")),
          inputs: [],
        };
      }
      prior.inputs.push(m.message.content);
      writeFileSync(path, JSON.stringify(prior));
    }

    if (m.message.content === "message-semantics") {
      for (const id of ["answer-a", "answer-b"]) {
        const stream = (event: unknown) =>
          send({
            type: "stream_event",
            uuid: crypto.randomUUID(),
            session_id: "fixture-session",
            parent_tool_use_id: null,
            event,
          });
        stream({ type: "message_start", message: { id, type: "message", role: "assistant", content: [] } });
        send({
          type: "stream_event",
          uuid: crypto.randomUUID(),
          session_id: "fixture-session",
          parent_tool_use_id: "subagent-tool",
          event: {
            type: "message_start",
            message: { id: "subagent-message", type: "message", role: "assistant", content: [] },
          },
        });
        stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } });
        stream({ type: "message_stop" });
        for (const content of [
          [{ type: "text", text: "Hello" }],
          [{ type: "text", text: " world" }],
          [{ type: "tool_use", id: `tool-${id}`, name: "Read", input: {} }],
        ])
          send({
            type: "assistant",
            uuid: crypto.randomUUID(),
            session_id: "fixture-session",
            parent_tool_use_id: null,
            message: {
              id,
              type: "message",
              role: "assistant",
              model: "claude-opus-5-5",
              content,
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          });
      }
      send({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "fixture-session",
        user_message_uuids: [m.uuid],
      });
      return;
    }
    if (m.message.content === "after-usage") {
      send({
        type: "assistant",
        uuid: "work-after-usage",
        session_id: "fixture-session",
        parent_tool_use_id: null,
        message: {
          id: "work-after-usage",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "work-after-usage" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      send({
        type: "result",
        subtype: "success",
        is_error: false,
        uuid: "work-result",
        session_id: "fixture-session",
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "work-after-usage",
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        user_message_uuid: m.uuid,
        user_message_uuids: [m.uuid],
      });
      return;
    }
    if (m.message.content === "/usage") {
      send({
        type: "stream_event",
        uuid: "quota-partial",
        session_id: "fixture-session",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "private-fallback-quota" } },
      });
      send({
        type: "assistant",
        uuid: "quota-fallback",
        session_id: "fixture-session",
        parent_tool_use_id: null,
        message: {
          id: "quota-fallback",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "private-fallback-quota" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      send({
        type: "system",
        subtype: "local_command_output",
        uuid: "quota-local",
        session_id: "fixture-session",
        content: "private-local-quota",
      });
      send({
        type: "result",
        subtype: "success",
        is_error: false,
        uuid: "quota-result",
        session_id: "fixture-session",
        duration_ms: 1,
        duration_api_ms: 0,
        num_turns: 1,
        result: "",
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
        user_message_uuid: m.uuid,
        user_message_uuids: [m.uuid],
      });
      return;
    }
    if (!initial) {
      initial = m.uuid;
      send({
        type: "stream_event",
        uuid: "partial",
        session_id: "fixture-session",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
      });
    } else {
      if (m.priority !== "now") throw Error("steer must have native now priority");
      send({
        type: "stream_event",
        uuid: "tool-start",
        session_id: "fixture-session",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tool-call", name: "Read", input: {} },
        },
      });
      send({
        type: "assistant",
        uuid: "quota-report",
        session_id: "fixture-session",
        parent_tool_use_id: null,
        usage_report: {
          session: {
            total_cost_usd: 0,
            total_api_duration_ms: 0,
            total_duration_ms: 0,
            total_lines_added: 0,
            total_lines_removed: 0,
            model_usage: {},
          },
          rate_limits: {
            limits: [
              {
                kind: "session",
                group: "session",
                percent: 25,
                resets_at: "2026-11-10T00:00:00Z",
                severity: "normal",
                is_active: true,
              },
            ],
            extra_usage: {
              is_enabled: true,
              monthly_limit: 2000,
              used_credits: 125,
              utilization: 6.25,
              currency: "EUR",
            },
          },
        },
        message: {
          id: "quota",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "private-account-allowance" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      send({
        type: "assistant",
        uuid: "assistant",
        session_id: "fixture-session",
        parent_tool_use_id: null,
        message: {
          id: "message",
          type: "message",
          role: "assistant",
          model: "claude-opus-5-5",
          content: [
            { type: "text", text: "steered" },
            { type: "tool_use", id: "tool-call", name: "Read", input: { file_path: "fixture-only" } },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      send({
        type: "user",
        uuid: "tool-result",
        session_id: "fixture-session",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-call", content: "fixture output", is_error: false }],
        },
      });
      send({
        type: "result",
        subtype: "success",
        is_error: false,
        uuid: "result",
        session_id: "fixture-session",
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: "steered",
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        user_message_uuid: m.uuid,
        user_message_uuids: [initial, m.uuid],
      });
    }
  }
});
