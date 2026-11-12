import { expect, test } from "bun:test";
import { GitHubHydrationError } from "@armada/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { callSharedTool } from "../src/tool-api.ts";
import type { ToolContext } from "../src/tools.ts";
import { createArmadaServer } from "../src/tools.ts";

// This is the shared HTTP/MCP operation boundary, not a second resolver mock.
// It protects owner-only injection into running machines without model credentials.
test.each([
  { caller: "owner", state: "running", providerId: "boat", expected: "connected" },
  { caller: "admin", state: "running", providerId: "boat", expected: "forbidden" },
  { caller: "owner", state: "stopped", providerId: "boat", expected: "conflict" },
  { caller: "owner", state: "running", providerId: "modal", expected: "unsupported" },
])("legacy GitHub repair authorizes $caller on $providerId $state", async ({ caller, state, providerId, expected }) => {
  const calls: unknown[] = [];
  const context = repairContext(
    caller,
    state,
    async (...args: unknown[]) => {
      calls.push(args);
      return { login: "octocat" };
    },
    providerId,
  );
  const provider = await context.provider({} as never);
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
      ...(expected === "unsupported" ? { status: 400 } : {}),
    });
    expect(calls).toEqual([]);
  }
});

function repairContext(
  caller: string,
  state: string,
  refreshGitHub: () => Promise<{ login: string }>,
  providerId = "boat",
): ToolContext {
  const provider = { id: providerId, get: async () => ({ state }) };
  return {
    caller: { userId: caller, orgs: [{ orgId: "org", role: "admin" }], via: "service" },
    data: {
      sandboxes: {
        get: async () => ({
          id: "sandbox",
          ownerId: "owner",
          orgId: "org",
          provider: providerId,
          credentialId: "credential",
          providerSandboxId: "bx",
          status: "running",
        }),
      },
    },
    provider: async () => provider,
    launchCredentials: {
      refreshGitHub,
    },
    now: () => new Date(),
  } as unknown as ToolContext;
}

// Discovery enables SDK output validation: an error must not masquerade as success structuredContent.
test("discovery-first MCP clients receive closed hydration error details without success-schema validation failure", async () => {
  const context = repairContext("owner", "running", async () => {
    throw new GitHubHydrationError("sudo");
  });
  const server = createArmadaServer(context, "test");
  const client = new Client({ name: "discovery-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    await client.listTools();
    const result = await client.callTool({ name: "github_refresh", arguments: { id: "sandbox" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const error = {
      code: "github_hydration_failed",
      message: new GitHubHydrationError().message,
      details: { phase: "sudo" },
    };
    expect(result._meta).toEqual({ error });
    expect(result.content).toContainEqual({ type: "text", text: JSON.stringify({ error }) });
  } finally {
    await client.close();
    await server.close();
  }
});
