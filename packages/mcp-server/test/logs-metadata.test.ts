import { expect, test } from "bun:test";
import type { Provider } from "@armada/core";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";

test.each([false, true])("logs retain runtime diagnostics across pages (all=%s)", async (all) => {
  const failure = { status: "failed" as const, reason: "runtime_transport_lost" };
  const cursors: (string | undefined)[] = [];
  const context = {
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
    provider: async () => ({
      id: "boat",
      events: async ({ cursor }: { cursor?: string }): ReturnType<Provider["events"]> => {
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
      },
    }),
    logError: () => {},
    now: () => new Date(),
  } as unknown as ToolContext;

  expect(await callSharedTool(context, "logs", { id: "sandbox", all })).toEqual({
    events: [],
    cursor: all ? "last" : null,
    hasMore: false,
    source: "armada-runtime",
    runtimeFailure: failure,
  });
  expect(cursors).toEqual(all ? [undefined, "next"] : [undefined]);
});
