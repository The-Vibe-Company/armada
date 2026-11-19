import {
  API_FAILURE_STATUS,
  type ApiFailureCode,
  type GitHubHydrationPhase,
  githubHydrationPhase,
  type LaunchError,
  type ProviderRateLimitDetails,
  providerRateLimitDetails,
} from "@armada/core";
import { PRIVATE_SKILL_FAILURES } from "../../core/src/private-skill-error.ts";

type LaunchDetails = {
  reason?: LaunchError["reason"];
  action?: LaunchError["action"];
  stage?: LaunchError["stage"];
};
type ToolErrorDetails = LaunchDetails | ProviderRateLimitDetails | { phase: GitHubHydrationPhase };

const launchDetails = z.object({
  reason: z
    .enum([
      ...PRIVATE_SKILL_FAILURES,
      "skillpack_credential_missing",
      "skillpack_credential_refused",
      "skillpack_skill_unavailable",
      "helper_missing",
      "helper_receipt_invalid",
      "helper_capability_unsupported",
    ])
    .optional(),
  action: z.literal("rebuild_golden").optional(),
  stage: z.enum(["credential", "auth", "install", "receipt", "transport"]).optional(),
});
const structuredError = z.object({
  code: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(100),
  message: z.string().min(1),
  details: z.unknown().optional(),
});

import { z } from "zod";

export class ToolApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: ToolErrorDetails,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
  get status(): number {
    if (Object.hasOwn(API_FAILURE_STATUS, this.code)) return API_FAILURE_STATUS[this.code as ApiFailureCode];
    if (["unknown", "start_failed", "init_failed", "prompt_failed"].includes(this.code)) return 502;
    if (this.code === "rate_limited") return 429;
    if (this.code === "payment_required") return 402;
    if (this.code === "host_full" || this.code === "host_draining") return 409;
    if (this.code === "not_found") return 404;
    if (this.code === "forbidden") return 403;
    if (
      [
        "credential_binding_required",
        "credential_binding_unsafe",
        "credential_binding_unsupported",
        "conflict",
        "sandbox_not_ready",
        "sandbox_terminal",
        "sandbox_retention_ended",
        "no_running_turn",
      ].includes(this.code)
    )
      return 409;
    if (["provider_routing_unavailable", "provider_not_configured", "unavailable", "internal"].includes(this.code))
      return 503;
    return 400;
  }
}

import { sandboxOperations } from "@armada/core/contract";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { INTERNAL_FAILURE_MESSAGE } from "./control-response.ts";
import { refuseConversationSelector, SINGLE_CONVERSATION_GUIDANCE } from "./sandbox-conversation.ts";
import { bindRestTool, type ToolContext } from "./tools.ts";

function parseSandboxToolInput(name: string, body: Record<string, unknown>) {
  const operation = Object.values(sandboxOperations).find((entry) => entry.toolName === name);
  return operation?.input.body.safeParse(body);
}

export async function callSharedTool(
  context: ToolContext,
  name: string,
  args: Record<string, unknown>,
  parsed = parseSandboxToolInput(name, args),
) {
  if (name === "send") {
    try {
      refuseConversationSelector(args);
    } catch {
      throw new ToolApiError("conflict", SINGLE_CONVERSATION_GUIDANCE);
    }
  }
  if ((name === "steer" || name === "interrupt") && Object.hasOwn(args, "conversation_id"))
    throw new ToolApiError("invalid_request", "Turn controls target the sandbox by ID. Omit conversation_id.");
  const measure: NonNullable<ToolContext["measure"]> = context.measure ?? ((_phase, work) => work());
  let invoke: (() => Promise<CallToolResult>) | undefined;
  bindRestTool(context, name, (_name, config, run) => {
    invoke = async () => {
      const input =
        parsed ?? (config.input instanceof z.ZodObject ? config.input : z.object(config.input)).safeParse(args);
      if (!input.success) {
        const details = input.error.issues.map((issue) => `${issue.message} at ${issue.path.join(".")}`).join("\n");
        throw new ToolApiError("internal", `Input validation error: Invalid arguments for tool ${name}: ${details}`);
      }
      // Organization scope was selected from the original body. Tool handlers never receive it.
      const { org: _org, ...toolInput } = input.data;
      const result = await run(toolInput as Parameters<typeof run>[0]);
      if (!result.isError && !z.object(config.output).safeParse(result.structuredContent).success)
        throw new ToolApiError("internal", `Output validation error for tool ${name}.`);
      return result;
    };
  });
  if (!invoke) throw new ToolApiError("internal", `Unknown sandbox tool ${name}.`);
  const result = await measure("tool_call", () => boundedToolCall(invoke));
  if (result.isError) {
    const block = (result.content as { type: string; text?: string }[]).find((item) => item.type === "text");
    const marker = (result.content as { type: string; text?: string }[]).find(
      (item) => item.type === "text" && item.text?.startsWith("error code: "),
    );
    const parsed = z.object({ error: structuredError }).safeParse(result.structuredContent);
    const structured = parsed.success ? parsed.data.error : undefined;
    const code = structured?.code ?? marker?.text?.slice("error code: ".length) ?? "internal";
    // Copy only closed diagnostic values, never arbitrary transport fields.
    const metadata = result._meta as { error?: { details?: { phase?: unknown } } } | undefined;
    const phase =
      code === "github_hydration_failed" ? githubHydrationPhase(metadata?.error?.details?.phase) : undefined;
    const decoded = launchDetails.safeParse(structured?.details);
    const details =
      code === "rate_limited"
        ? providerRateLimitDetails(structured?.details)
        : phase
          ? { phase }
          : decoded.success && Object.keys(decoded.data).length
            ? decoded.data
            : undefined;
    throw new ToolApiError(
      code,
      structured?.message ?? (block !== marker ? block?.text : undefined) ?? INTERNAL_FAILURE_MESSAGE,
      details,
    );
  }
  const response: unknown = result.structuredContent;
  return response;
}

async function boundedToolCall(invoke: () => Promise<CallToolResult>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      invoke(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Sandbox tool request timed out.")), 660_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
