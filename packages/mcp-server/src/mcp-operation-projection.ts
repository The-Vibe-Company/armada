import { operations } from "@armada/core/contract";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { configureTools } from "./sandbox-tool-handlers.ts";
import { registerTool, type ToolBinding } from "./tool-registration.ts";
import type { ToolContext } from "./tools.ts";

export function registerAgentTools(server: McpServer, context: ToolContext) {
  const handlers = new Map<
    string,
    (operation: { description: string; readOnly: boolean; destructive: boolean }) => void
  >();
  const bind: ToolBinding = (name, config, invoke) => {
    handlers.set(name, (operation) => {
      const { description, readOnly, destructive } = operation;
      registerTool(server, name, { ...config, description, readOnly, destructive }, invoke);
    });
  };
  configureTools(context, "mcp", undefined, undefined, bind);
  for (const operation of Object.values(operations)) {
    if (operation.audience !== "agent" || !("toolName" in operation)) continue;
    const bindHandler = handlers.get(operation.toolName);
    if (!bindHandler) throw new Error(`Missing MCP handler for ${operation.name}.`);
    bindHandler(operation);
  }
}
