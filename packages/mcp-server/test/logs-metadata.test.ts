import { expect, test } from "bun:test";
import { type Provider, ProviderError } from "@armada/core";
import { readLogs } from "../src/control-logs.ts";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";

function context(events: Provider["events"]): ToolContext {
  return {
    caller: { userId: "owner", orgs: [{ orgId: "org", role: "member" }], via: "service" },
    data: {
      sandboxes: {
        get: async () => ({
          id: "sandbox",
          ownerId: "owner",
          orgId: "org",
          provider: "boat",
          providerSandboxId: "bx",
          status: "failed",
        }),
      },
    },
    provider: async () => ({ id: "boat", events }),
    logError: () => {},
    now: () => new Date(),
  } as unknown as ToolContext;
}

test.each([false, true])("logs retain runtime diagnostics across pages (all=%s)", async (all) => {
  const failure = { status: "failed" as const, reason: "runtime_transport_lost" };
  const cursors: (string | undefined)[] = [];
  const fixture = context(async ({ cursor }) => {
    cursors.push(cursor);
    return cursor
      ? { events: [], cursor: "last", hasMore: false }
      : {
          events: [],
          ...(all ? { cursor: "next" } : {}),
          hasMore: all,
          source: "armada-runtime",
          runtimeFailure: failure,
        };
  });

  expect(await callSharedTool(fixture, "logs", { id: "sandbox", all })).toEqual({
    events: [],
    cursor: all ? "last" : null,
    hasMore: false,
    source: "armada-runtime",
    runtimeFailure: failure,
    settled: true,
    threadStatus: { status: "failed", statusMessage: null, prompt: null, usage: null },
  });
  expect(cursors).toEqual(all ? [undefined, "next"] : [undefined]);
});

test("Boat and Modal logs return threadStatus and settled matching Docker's shape", async () => {
  const now = new Date("2026-11-25T12:00:00Z");
  const usage = { computeSeconds: null, turnCount: 1, turns: [] };
  const base = {
    id: "sandbox",
    ownerId: "owner",
    orgId: "org",
    provider: "modal" as const,
    providerSandboxId: "mx",
    status: "running" as const,
    taskPromptId: "pr_1",
    conversationIds: ["conv_1"],
    usage,
  };
  const mcpFixture = {
    ...context(async () => ({
      events: [
        { id: "e1", at: 1, kind: "prompt", promptId: "pr_1", conversationId: "conv_1", text: "hi", status: "running" },
      ],
      cursor: "c1",
      hasMore: false,
    })),
    data: { sandboxes: { get: async () => base } },
    now: () => now,
  } as unknown as ToolContext;
  expect(await callSharedTool(mcpFixture, "logs", { id: "sandbox" })).toMatchObject({
    settled: false,
    threadStatus: {
      status: "running",
      statusMessage: null,
      prompt: { promptId: "pr_1", state: "running", reason: null },
      usage,
    },
  });
  const paused = {
    ...base,
    provider: "boat" as const,
    status: "stopped" as const,
    statusReason: "idle_paused",
    expiresAt: "2026-11-25T13:00:00Z",
  };
  expect(
    await readLogs(
      {
        now: () => now,
        logs: async () => ({
          providerSandboxId: "bx",
          sandbox: paused as never,
          provider: {
            events: async () => ({ events: [], cursor: "c2", hasMore: false }),
            followSettled: async () => true,
          } as never,
        }),
      },
      mcpFixture.caller,
      "sandbox",
      {},
    ),
  ).toMatchObject({
    settled: true,
    threadStatus: {
      status: "stopped",
      statusMessage: "Paused — wakes on your next message",
      prompt: { promptId: "pr_1", state: "finished", reason: null },
      usage,
    },
  });
  expect(
    await readLogs(
      {
        now: () => now,
        logs: async () => ({
          providerSandboxId: "mx",
          sandbox: { ...base, taskPromptId: "pr_2" } as never,
          provider: {
            events: async () => ({
              events: [
                {
                  id: "e1",
                  at: 1,
                  kind: "prompt",
                  promptId: "pr_1",
                  conversationId: "conv_1",
                  text: "old",
                  status: "finished",
                },
              ],
              cursor: "c1",
              hasMore: false,
            }),
            followSettled: async () => false,
          } as never,
        }),
      },
      mcpFixture.caller,
      "sandbox",
      {},
    ),
  ).toMatchObject({
    settled: false,
    threadStatus: { prompt: { promptId: "pr_2", state: "running", reason: null } },
  });
});

test("MCP logs rejects a backward drain even when the provider is unavailable", async () => {
  const fixture = context(async () => ({ events: [], hasMore: false }));
  fixture.provider = async () => {
    throw new ProviderError({
      provider: "boat",
      code: "unavailable",
      status: 503,
      retryable: true,
      message: "Provider unavailable.",
    });
  };
  await expect(
    callSharedTool(fixture, "logs", { id: "sandbox", direction: "backward", all: true }),
  ).rejects.toMatchObject({ code: "invalid", message: "Backward reads cannot drain all pages.", status: 400 });
});
