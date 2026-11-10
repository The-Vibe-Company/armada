import { expect, test } from "bun:test";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";

// This is the shared HTTP/MCP operation boundary, not a second resolver mock.
// It protects owner-only injection into running machines without model credentials.
test.each([
  { caller: "owner", state: "running", expected: "connected" },
  { caller: "admin", state: "running", expected: "forbidden" },
  { caller: "owner", state: "stopped", expected: "conflict" },
])("legacy GitHub repair authorizes $caller on $state", async ({ caller, state, expected }) => {
  const calls: unknown[] = [];
  const provider = { id: "boat", get: async () => ({ state }) };
  const context = {
    caller: { userId: caller, orgs: [{ orgId: "org", role: "admin" }], via: "service" },
    data: {
      sandboxes: {
        get: async () => ({
          id: "sandbox",
          ownerId: "owner",
          orgId: "org",
          provider: "boat",
          providerSandboxId: "bx",
          status: "running",
        }),
      },
    },
    provider: async () => provider,
    launchCredentials: {
      refreshGitHub: async (...args: unknown[]) => {
        calls.push(args);
        return { login: "octocat" };
      },
    },
    now: () => new Date(),
  } as unknown as ToolContext;
  if (expected === "connected") {
    expect(await callSharedTool(context, "github_refresh", { id: "sandbox" })).toEqual({
      id: "sandbox",
      login: "octocat",
      status: "connected",
    });
    expect(calls).toEqual([[{ userId: "owner", orgId: "org", role: "member" }, provider, "bx"]]);
  } else {
    await expect(callSharedTool(context, "github_refresh", { id: "sandbox" })).rejects.toMatchObject({
      code: expected,
    });
    expect(calls).toEqual([]);
  }
});
