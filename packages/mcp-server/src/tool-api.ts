import { VaultError } from "@armada/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createArmadaServer, type ToolContext } from "./tools.ts";

/** HTTP and MCP run precisely the same validated operations and authorization context. */
export async function callSharedTool(context: ToolContext, name: string, args: Record<string, unknown>) {
  const server = createArmadaServer(context, "2.0.2");
  const client = new Client({ name: "armada-http", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 660_000 });
    if (result.isError) {
      const block = (result.content as { type: string; text?: string }[]).find((item) => item.type === "text");
      throw new VaultError("invalid", block?.text ?? "Operation failed.");
    }
    return result.structuredContent;
  } finally {
    await client.close();
    await server.close();
  }
}
