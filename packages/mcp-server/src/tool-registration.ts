import { VaultError } from "@armada/core/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type * as z from "zod";
import { CREDENTIAL_BINDING_GUIDANCE } from "./credential-binding.ts";
import type { SandboxView } from "./data.ts";
import { validateLogPagination } from "./event-pagination.ts";
import { logicalExpiry } from "./mcp-read-tools.ts";
import { sandboxControlRefusal } from "./sandbox-control-refusal.ts";
import { ToolError } from "./tool-error.ts";
import { errorResult } from "./tool-failure.ts";
import type { ToolContext } from "./tools.ts";

type ToolInput = z.ZodRawShape | z.ZodObject;
type ToolArgs<In extends ToolInput> = z.infer<In extends z.ZodRawShape ? z.ZodObject<In> : In>;

type ToolContract<In extends ToolInput, Out extends z.ZodRawShape> = {
  title: string;
  description: string;
  input: In;
  output: Out;
  readOnly?: boolean;
  destructive?: boolean;
};

export type ToolRegistrar = <In extends ToolInput, Out extends z.ZodRawShape>(
  name: string,
  config: ToolContract<In, Out>,
  run: (args: ToolArgs<In>) => Promise<z.infer<z.ZodObject<Out>>>,
  restOnly?: boolean,
) => ToolContract<In, Out> & { invoke: (args: ToolArgs<In>) => Promise<CallToolResult> };

export function createToolRegistration(
  server: McpServer,
  context: ToolContext,
  surface: "mcp" | "rest",
  visible: (sandboxId: string) => Promise<SandboxView>,
) {
  const { caller, data } = context;
  const register = <In extends ToolInput, Out extends z.ZodRawShape>(
    name: string,
    config: ToolContract<In, Out>,
    invoke: (args: ToolArgs<In>) => Promise<CallToolResult>,
  ) => {
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.input,
        outputSchema: config.output,
        annotations: {
          readOnlyHint: config.readOnly ?? false,
          destructiveHint: config.destructive ?? false,
          openWorldHint: true,
        },
      },
      invoke as never,
    );
  };

  const tool = <In extends ToolInput, Out extends z.ZodRawShape>(
    name: string,
    config: ToolContract<In, Out>,
    run: (args: ToolArgs<In>) => Promise<z.infer<z.ZodObject<Out>>>,
    restOnly = false,
  ) => {
    const invoke: (args: ToolArgs<In>) => Promise<CallToolResult> = async (args) => {
      try {
        if (["send", "steer", "exec", "interrupt"].includes(name)) {
          const input = args as Record<string, unknown>;
          const found = data.sandboxes.controlState
            ? await data.sandboxes.controlState(input.id as string)
            : await visible(input.id as string);
          if (!found) throw new ToolError("not_found", `No sandbox with id '${input.id}' that you can see.`);
          // WARNING: Retained legacy Modal workspaces require explicit account binding before any control.
          if (found.provider === "modal" && !found.credentialId && !sandboxControlRefusal(found, context.now(), "send"))
            throw new VaultError("credential_binding_required", CREDENTIAL_BINDING_GUIDANCE);
          const refusal = sandboxControlRefusal(found, context.now(), name);
          if (refusal) throw new ToolError("sandbox_terminal", refusal);
        }
        if (
          name === "stop" &&
          !(args as Record<string, unknown>).only_if_idle &&
          typeof (args as Record<string, unknown>).id === "string"
        )
          await context.accountTurns?.cancelQueued(caller, (args as Record<string, unknown>).id as string);
        if (name === "report") {
          const input = args as Record<string, unknown>;
          const queued = await context.accountTurns?.status(caller, input.id as string, input.prompt_id as string);
          if (queued && "nativePromptId" in queued) input.prompt_id = queued.nativePromptId;
        }
        if (name === "logs") validateLogPagination(args as Record<string, unknown>);
        const routed = ["send", "status", "wait"].includes(name)
          ? undefined
          : await context.dockerControls?.invoke(caller, name, args);
        const raw = routed?.handled ? routed.result : await run(args);
        if (["logs", "status", "wait", "list"].includes(name) && context.accountTurns?.publicPromptIds) {
          type PublicReport = {
            id?: string;
            sandboxes?: PublicReport[];
            events?: { promptId?: string }[];
            prompt?: { promptId: string };
            usage?: { turns: { promptId: string }[] };
          };
          const root = raw as PublicReport;
          const reports = (name === "list" ? (root.sandboxes ?? []) : [root]).map((report) => {
            const items = [
              ...(report.events ?? []),
              ...(report.prompt ? [report.prompt] : []),
              ...(report.usage?.turns ?? []),
            ];
            return { sandboxId: report.id ?? ((args as Record<string, unknown>).id as string), items };
          });
          const aliases = await context.accountTurns.publicPromptIdsBatch(
            caller,
            reports.map(({ sandboxId, items }) => ({
              sandboxId,
              nativeIds: items.flatMap((item) => (item.promptId ? [item.promptId] : [])),
            })),
          );
          for (const { sandboxId, items } of reports) {
            const ids = aliases.get(sandboxId);
            for (const item of items)
              if (item.promptId && ids?.has(item.promptId)) item.promptId = ids.get(item.promptId)!;
          }
        }
        const value =
          routed?.handled && (name === "status" || name === "wait")
            ? {
                ...(raw as Record<string, unknown>),
                ...logicalExpiry((raw as { expiresAt: string | null }).expiresAt, context.now()),
                providerExpiresAt: null,
              }
            : raw;
        const sandboxId = (args as Record<string, unknown>).id;
        const result =
          (name === "status" || name === "wait") && context.sandboxBillingAccount && typeof sandboxId === "string"
            ? {
                ...(value as Record<string, unknown>),
                billingAccount: await context.sandboxBillingAccount(sandboxId),
              }
            : value;
        return {
          structuredContent: result as Record<string, unknown>,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        return errorResult(error, name, context.logError ?? ((line) => console.error(line)));
      }
    };
    if (!restOnly || surface === "rest") register(name, config, invoke);
    return { ...config, invoke };
  };

  return { register, tool };
}
