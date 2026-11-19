import { MCP_OUTPUT_MAX_BYTES, sandboxOutputOperations } from "@armada/core/contract";
import { ToolError } from "./tool-error.ts";
import { errorResult } from "./tool-failure.ts";
import type { ToolBinding } from "./tool-registration.ts";
import type { ToolContext } from "./tools.ts";

export function bindOutputTools(context: ToolContext, bind: ToolBinding) {
  const { listSandboxOutputs: list, readSandboxOutput: read } = sandboxOutputOperations;

  function invoke<T extends Record<string, unknown>>(toolName: string, decode: (response: Response) => Promise<T>) {
    return async ({ id, name }: { id: string; name?: string }) => {
      try {
        if (!context.readOutputSnapshot) throw new ToolError("unavailable", "Snapshot reads are unavailable.");
        const response = await context.readOutputSnapshot(
          context.caller,
          id,
          name,
          new Headers(),
          context.outputSignal ?? new AbortController().signal,
        );
        if (response.status === 404) throw new ToolError("not_found", "No output snapshot or file found.");
        if (!response.ok) throw new ToolError("unavailable", "Snapshot reads are unavailable.");
        const result = await decode(response);
        return {
          structuredContent: result,
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (error) {
        return errorResult(error, toolName, context.logError ?? ((line) => console.error(line)));
      }
    };
  }

  bind(
    list.toolName,
    {
      title: "List sandbox outputs",
      description: list.description,
      input: list.input.path,
      output: list.output.shape,
    },
    invoke(list.toolName, async (response) => list.output.parse(await response.json())),
  );

  bind(
    read.toolName,
    {
      title: "Read sandbox output",
      description: read.mcpDescription,
      input: read.input.path,
      output: read.mcpOutput.shape,
    },
    invoke(read.toolName, async (response) => {
      const length = response.headers.get("content-length");
      if (length === null || !/^\d+$/.test(length) || Number(length) > MCP_OUTPUT_MAX_BYTES) {
        await response.body?.cancel();
        throw new ToolError("invalid", "This output exceeds the MCP download limit. Use the REST output download.");
      }
      return { base64: Buffer.from(await response.arrayBuffer()).toString("base64") };
    }),
  );
}
