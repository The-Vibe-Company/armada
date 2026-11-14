#!/usr/bin/env bun
import { readFileSync } from "node:fs";

const command = process.argv[2];
if (command === "acp") await import("./acp.ts");
else if (command === "export" && process.env.FAIL_EXPORT) process.exit(2);
else if (command === "export") {
  const step = (
    id: string,
    input: number,
    output: number,
    reasoning: number,
    read: number,
    write: number,
    finish: string,
  ) => ({
    info: {
      id,
      sessionID: "session-1",
      role: "assistant",
      providerID: "armada",
      modelID: "model",
      time: { completed: 1 },
      finish,
      tokens: { input, output, reasoning, cache: { read, write }, total: input + output + reasoning + read + write },
    },
    parts: [],
  });
  const measured = [
    step("old", 2, 3, 1, 1, 0, "stop"),
    ...(process.env.EXPORT_STAGE === "2"
      ? [step("new-tool", 5, 2, 0, 0, 1, "tool-calls"), step("new-answer", 1, 4, 2, 2, 1, "stop")]
      : []),
  ];
  if (process.env.EXPORT_TOOLS || process.env.EXPORT_MCP) {
    for (const message of measured) {
      if (message.info.id === "new-answer") continue;
      const id = message.info.id;
      const part = {
        type: "tool",
        id: `part-${id}`,
        callID: `call-${id}`,
        messageID: id,
        sessionID: "session-1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: id === "old" ? "printf OLD" : "printf EXPECTED" },
          output: id === "old" ? "OLD" : "EXPECTED",
          metadata: { exit: 0 as number | undefined, truncated: false, timeout: false },
        },
      };
      if (id !== "old") {
        if (process.env.EXPORT_TOOLS === "exit") part.state.metadata.exit = 1;
        if (process.env.EXPORT_TOOLS === "missing-exit") part.state.metadata.exit = undefined;
        if (process.env.EXPORT_TOOLS === "truncated") part.state.metadata.truncated = true;
        if (process.env.EXPORT_TOOLS === "timeout") part.state.metadata.timeout = true;
        if (process.env.EXPORT_TOOLS === "foreign-session") part.sessionID = "foreign";
        if (process.env.EXPORT_TOOLS === "oversized") part.state.output = "x".repeat(65537);
      }
      if (process.env.EXPORT_MCP) {
        part.tool = "armada_fixture_read_counter";
        Object.assign(part.state, {
          input: { label: "fixture", nested: { a: 1, b: 2 } },
          output: "native MCP result",
          metadata: { truncated: false },
        });
        if (id !== "old") {
          if (process.env.EXPORT_MCP === "failed") part.state.status = "error";
          if (process.env.EXPORT_MCP === "truncated") part.state.metadata.truncated = true;
          if (process.env.EXPORT_MCP === "foreign-session") part.sessionID = "foreign";
          if (process.env.EXPORT_MCP === "unknown-server") part.tool = "foreign_read_counter";
          if (process.env.EXPORT_MCP === "oversized") part.state.output = "x".repeat(65537);
        }
      }
      Object.assign(message, {
        parts: [
          part,
          ...(id !== "old" && (process.env.EXPORT_TOOLS === "duplicate" || process.env.EXPORT_MCP === "duplicate")
            ? [part]
            : []),
        ],
      });
    }
  }
  process.stdout.write(
    JSON.stringify({
      info: { id: "session-1" },
      messages: process.env.EXPORT_STAGE ? measured : [{ text: "private-key-for-test" }],
    }),
  );
} else if (command === "import") {
  const saved = JSON.parse(readFileSync(process.argv[3]!, "utf8"));
  if (
    saved.info.id !== "session-1" ||
    !Array.isArray(saved.messages) ||
    JSON.stringify(saved).includes("private-key-for-test")
  )
    process.exit(2);
} else process.exit(3);
