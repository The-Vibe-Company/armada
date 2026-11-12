#!/usr/bin/env bun
import { createInterface } from "node:readline";
import recording from "./codex-resume-recorded.json";

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "thread/resume")
    send({ id: m.id, result: { thread: { id: "recorded-thread" }, model: "gpt-6.1-sol" } });
  if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "recorded-resume" } } });
    for (const event of recording) {
      if (event.phase !== "resume") continue;
      if (event.method === "thread/tokenUsage/updated") send({ method: event.method, params: event.params });
      if (event.method === "turn/completed")
        send({
          method: event.method,
          params: { threadId: "recorded-thread", turn: { id: "recorded-resume", status: event.status, error: null } },
        });
    }
  }
});
