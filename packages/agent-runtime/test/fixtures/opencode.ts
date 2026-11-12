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
