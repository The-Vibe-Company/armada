import { expect, test } from "bun:test";
import type { Caller } from "../src/caller.ts";
import { callSharedTool } from "../src/tool-api.ts";

test("queued status usage uses the public receipt without relabelling other turns", async () => {
  const input = { id: "sandbox", request_id: "30000000-0000-4000-8000-000000000001" };
  const caller = { userId: "owner", orgs: [] } as unknown as Caller;
  const routedPrompts: unknown[] = [];
  const context = {
    caller,
    accountTurns: {
      status: async () => ({ nativePromptId: "actual_docker_prompt", publicPromptId: input.request_id }),
    },
    data: {
      sandboxes: {
        get: async () => {
          throw Error("Docker routes before native data");
        },
      },
    },
    dockerControls: {
      invoke: async (_caller: Caller, name: string, args: Record<string, unknown>) => {
        expect(name).toBe("status");
        routedPrompts.push(args.prompt_id);
        if (args.prompt_id !== undefined && args.prompt_id !== "actual_docker_prompt") throw Error("unknown prompt");
        return {
          handled: true,
          result: {
            id: input.id,
            golden: null,
            visibility: "private",
            harness: "codex",
            repositoryDir: null,
            model: null,
            reasoningEffort: null,
            machineSize: null,
            statusReason: null,
            providerState: null,
            conversationIds: ["history"],
            status: "ready",
            settled: true,
            expiresAt: null,
            prompt: { promptId: "actual_docker_prompt", conversationId: "history", reason: null, state: "finished" },
            usage: {
              computeSeconds: 0,
              turnCount: 2,
              turns: [
                { promptId: "actual_docker_prompt", model: "model", inputTokens: 10, outputTokens: 2, cachedTokens: 0 },
                { promptId: "earlier_prompt", model: "model", inputTokens: 3, outputTokens: 1, cachedTokens: 0 },
              ],
            },
          },
        };
      },
    },
    now: () => new Date(0),
    sleep: async () => {
      throw Error("No real waits");
    },
  } as unknown as import("../src/tools.ts").ToolContext;
  const report = await callSharedTool(context, "status", { id: input.id });
  expect(report).toMatchObject({
    prompt: { promptId: input.request_id },
    usage: {
      turns: [
        { promptId: input.request_id, inputTokens: 10, outputTokens: 2 },
        { promptId: "earlier_prompt", inputTokens: 3, outputTokens: 1 },
      ],
    },
  });
});
