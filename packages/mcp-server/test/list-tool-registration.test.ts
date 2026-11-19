import { expect, test } from "bun:test";
import {
  launchOptionsOperation,
  MCP_OUTPUT_MAX_BYTES,
  operations,
  sandboxOutputOperations,
} from "@armada/core/contract";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createArmadaServer, createRestToolServer, type ToolContext } from "../src/tools.ts";

test("list-only registration retains SDK validation and listing while normal MCP retains its catalogue", async () => {
  const reads: unknown[] = [];
  const context = {
    caller: { userId: "owner", orgs: [], via: "supabase" },
    data: {
      sandboxes: {
        list: async (filter: unknown) => {
          reads.push(filter);
          return { rows: [], total: 0 };
        },
      },
    },
  } as unknown as ToolContext;
  for (const onlyTool of [true, false]) {
    const server = onlyTool ? createRestToolServer(context, "test", "list") : createArmadaServer(context, "test");
    const client = new Client({ name: "test", version: "test" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      if (onlyTool) expect(names).toEqual(["list"]);
      else {
        expect(names).toContain("list");
        expect(names).toContain("launch");
      }
      const invalid = await client.callTool({ name: "list", arguments: { limit: 0 } });
      expect(invalid.isError).toBe(true);
      expect(reads).toHaveLength(onlyTool ? 0 : 1);
      const result = await client.callTool({ name: "list", arguments: { limit: 10, owner: "me", harness: "codex" } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        sandboxes: [],
        total: 0,
        page: 1,
        limit: 10,
        hasMore: false,
        nextPage: null,
      });
      expect(reads.at(-1)).toMatchObject({ ownerId: "owner", harness: "codex", limit: 10, page: 1 });
    } finally {
      await client.close();
      await server.close();
    }
  }
});

test("owner MCP publishes all agent operations and their descriptions", async () => {
  const context = { caller: { userId: "owner", orgs: [] }, data: {} } as unknown as ToolContext;
  const server = createArmadaServer(context, "test", { docker: { hosts: true } });
  const client = new Client({ name: "test", version: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "exec",
      "launch",
      "launch_options",
      "list",
      "logs",
      "output_read",
      "outputs_list",
      "report",
      "send",
      "status",
      "stop",
    ]);
    for (const tool of tools) expect(tool.outputSchema).toBeDefined();
    const result = await client.callTool({ name: "launch_options", arguments: {} });
    expect(result.isError).not.toBe(true);
    const discovery = launchOptionsOperation.output.parse(result.structuredContent);
    expect(discovery.providers.find(({ id }) => id === "docker")).toMatchObject({
      enabled: true,
      capabilities: { launch: false },
    });
    expect(discovery.harnesses).toContainEqual(expect.objectContaining({ id: "codex" }));
    const launch = tools.find((tool) => tool.name === "launch");
    expect(launch?.inputSchema.anyOf).toEqual(
      ["boat", "modal"].map((provider) =>
        expect.objectContaining({
          properties: expect.objectContaining({ provider: expect.objectContaining({ const: provider }) }),
          required: expect.arrayContaining(["provider", "harness", "golden"]),
        }),
      ),
    );
    const agentDescriptions = Object.values(operations).flatMap((operation) =>
      operation.audience === "agent"
        ? [[operation.toolName, "mcpDescription" in operation ? operation.mcpDescription : operation.description]]
        : [],
    );
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.description]))).toEqual(
      Object.fromEntries(agentDescriptions),
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP output tools send the authenticated caller to the snapshot reader and enforce the inline limit", async () => {
  const id = crypto.randomUUID();
  const caller = { userId: "owner", orgs: [], via: "service" } satisfies ToolContext["caller"];
  let cancelled = false;
  const context = {
    caller,
    readOutputSnapshot: async (principal, sandboxId, name) => {
      expect(principal).toBe(caller);
      expect(sandboxId).toBe(id);
      if (name === undefined) {
        return Response.json({
          directory: "/home/user/outputs",
          limits: {
            maxFiles: 32,
            maxFileBytes: 32 * 1024 * 1024,
            maxSandboxBytes: 64 * 1024 * 1024,
            maxOrgBytes: 1024 * 1024 * 1024,
          },
          files: [{ name: "binary.dat", size: 3, sha256: null, updatedAt: "2026-11-19T00:00:00Z" }],
        });
      }
      if (name === "binary.dat") {
        return new Response(Uint8Array.of(0, 255, 10), { headers: { "content-length": "3" } });
      }
      if (name === "unsized.dat") return new Response(Uint8Array.of(1));
      if (name === "bad-size.dat") {
        return new Response(Uint8Array.of(1), { headers: { "content-length": "" } });
      }
      if (name === "large.dat") {
        return new Response(
          new ReadableStream(
            {
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          {
            headers: { "content-length": String(MCP_OUTPUT_MAX_BYTES + 1) },
          },
        );
      }
      return new Response(null, { status: 404 });
    },
  } satisfies Partial<ToolContext>;
  const server = createArmadaServer(context as unknown as ToolContext, "test");
  const client = new Client({ name: "test", version: "test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const list = await client.callTool({ name: "outputs_list", arguments: { id } });
    expect(sandboxOutputOperations.listSandboxOutputs.output.parse(list.structuredContent).files).toHaveLength(1);
    const read = (name: string) => client.callTool({ name: "output_read", arguments: { id, name } });
    const binary = sandboxOutputOperations.readSandboxOutput.mcpOutput.parse(
      (await read("binary.dat")).structuredContent,
    );
    expect(binary.base64).toBe("AP8K");
    const large = await read("large.dat");
    expect(large.isError).toBe(true);
    expect(large.content).toContainEqual({ type: "text", text: expect.stringContaining("REST output download") });
    expect(cancelled).toBe(true);
    expect((await read("unsized.dat")).isError).toBe(true);
    expect((await read("bad-size.dat")).isError).toBe(true);
    const missing = await read("missing.dat");
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toBeUndefined();
  } finally {
    await client.close();
    await server.close();
  }
});
