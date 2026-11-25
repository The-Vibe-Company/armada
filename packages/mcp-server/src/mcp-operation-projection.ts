import { launchOptionsOperation, operations } from "@armada/core/contract";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type LaunchDiscoveryOptions, readLaunchOptions } from "./launch-options.ts";
import { bindOutputTools } from "./mcp-output-bindings.ts";
import { configureTools } from "./sandbox-tool-handlers.ts";
import { registerTool, type ToolBinding } from "./tool-registration.ts";
import type { ToolContext } from "./tools.ts";

export function registerAgentTools(server: McpServer, context: ToolContext, launchDiscovery: LaunchDiscoveryOptions) {
  const handlers = new Map<
    string,
    (operation: { description: string; mcpDescription?: string; readOnly: boolean; destructive: boolean }) => void
  >();
  const bind: ToolBinding = (name, config, invoke) => {
    handlers.set(name, (operation) => {
      const { description, mcpDescription, readOnly, destructive } = operation;
      registerTool(
        server,
        name,
        { ...config, description: mcpDescription ?? description, readOnly, destructive },
        invoke,
      );
    });
  };
  configureTools(context, "mcp", undefined, bind);
  bind(
    launchOptionsOperation.toolName,
    {
      title: "Launch options",
      description: launchOptionsOperation.description,
      input: launchOptionsOperation.input.body,
      output: launchOptionsOperation.output.shape,
    },
    async () => {
      const result = readLaunchOptions(launchDiscovery);
      return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
  bindOutputTools(context, bind);
  for (const operation of Object.values(operations)) {
    if (operation.audience !== "agent") continue;
    if (!("toolName" in operation)) throw new Error("Agent operation is missing an MCP tool name.");
    const bindHandler = handlers.get(operation.toolName);
    if (!bindHandler) throw new Error(`Missing MCP handler for ${operation.name}.`);
    bindHandler(operation);
  }
}
