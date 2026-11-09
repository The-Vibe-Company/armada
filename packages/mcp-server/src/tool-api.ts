export class ToolApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
  get status(): number {
    if (this.code === "not_found") return 404;
    if (this.code === "forbidden") return 403;
    if (["conflict", "no_running_turn"].includes(this.code)) return 409;
    if (["provider_not_configured", "unavailable", "internal"].includes(this.code)) return 503;
    return 400;
  }
}

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
      const marker = (result.content as { type: string; text?: string }[]).find(
        (item) => item.type === "text" && item.text?.startsWith("error code: "),
      );
      const code = marker?.text?.slice("error code: ".length) ?? "internal";
      throw new ToolApiError(code, block?.text ?? "Operation failed.");
    }
    return result.structuredContent;
  } finally {
    await client.close();
    await server.close();
  }
}
