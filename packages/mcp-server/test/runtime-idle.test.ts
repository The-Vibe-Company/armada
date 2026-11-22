import { expect, test } from "bun:test";
import type { AgentEvent } from "@armada/core";
import { runtimeIdle } from "../src/runtime-idle.ts";

test("idle pause requires all turns settled and a full quiet interval", () => {
  const prompt = (id: string, status: "running" | "finished", at: number): AgentEvent => ({
    id: `${id}-${at}`,
    promptId: id,
    kind: "prompt",
    text: "",
    status,
    at,
  });
  const ended = [prompt("one", "running", 100), prompt("one", "finished", 200)];
  expect(runtimeIdle(ended, 799, 600)).toBe(false);
  expect(runtimeIdle(ended, 800, 600)).toBe(true);
  expect(runtimeIdle([...ended, prompt("two", "running", 300)], 1000, 600)).toBe(false);
  expect(runtimeIdle([...ended, { id: "output", kind: "other", type: "output", data: {}, at: 500 }], 1000, 600)).toBe(
    false,
  );
  expect(runtimeIdle([], 1000, 600)).toBe(false);
});
