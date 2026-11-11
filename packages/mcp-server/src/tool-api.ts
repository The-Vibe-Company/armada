import { API_FAILURE_STATUS, type ApiFailureCode, type GitHubHydrationPhase, githubHydrationPhase } from "@armada/core";
export class ToolApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: { phase: GitHubHydrationPhase },
  ) {
    super(message);
  }
  get status(): number {
    if (Object.hasOwn(API_FAILURE_STATUS, this.code)) return API_FAILURE_STATUS[this.code as ApiFailureCode];
    if (this.code === "unknown") return 502;
    if (this.code === "not_found") return 404;
    if (this.code === "forbidden") return 403;
    if (
      [
        "credential_binding_required",
        "credential_binding_unsafe",
        "conflict",
        "sandbox_not_ready",
        "no_running_turn",
      ].includes(this.code)
    )
      return 409;
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
      // Error details cross the MCP transport only through this closed, secret-free field.
      const structured = result._meta as { error?: { details?: { phase?: unknown } } } | undefined;
      const phase =
        code === "github_hydration_failed" ? githubHydrationPhase(structured?.error?.details?.phase) : undefined;
      throw new ToolApiError(code, block?.text ?? "Operation failed.", phase ? { phase } : undefined);
    }
    return result.structuredContent;
  } finally {
    await client.close();
    await server.close();
  }
}
