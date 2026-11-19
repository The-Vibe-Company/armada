import { expect, test } from "bun:test";
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
