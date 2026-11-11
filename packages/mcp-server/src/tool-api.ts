import { API_FAILURE_STATUS, type ApiFailureCode, type GitHubHydrationPhase, type LaunchError, githubHydrationPhase } from "@armada/core";
import { PRIVATE_SKILL_FAILURES } from "../../core/src/private-skill-error.ts";

type LaunchDetails = {
  reason?: NonNullable<LaunchError["reason"]>;
  action?: NonNullable<LaunchError["action"]>;
  stage?: NonNullable<LaunchError["stage"]>;
};
type ToolErrorDetails = LaunchDetails | { phase: GitHubHydrationPhase };

const launchDetails = z.object({
  reason: z.enum([
    ...PRIVATE_SKILL_FAILURES,
    "skillpack_credential_missing", "skillpack_credential_refused", "skillpack_skill_unavailable",
    "helper_missing", "helper_receipt_invalid", "helper_capability_unsupported",
  ]).optional(),
  action: z.literal("rebuild_golden").optional(),
  stage: z.enum(["credential", "auth", "install", "receipt", "transport"]).optional(),
});
const structuredError = z.object({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/).max(100),
  message: z.string().min(1),
  details: z.unknown().optional(),
});
import { z } from "zod";

export class ToolApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: ToolErrorDetails,
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
      const parsed = structuredError.safeParse(result.structuredContent?.error);
      const structured = parsed.success ? parsed.data : undefined;
      const code = structured?.code ?? marker?.text?.slice("error code: ".length) ?? "internal";
      // Copy only closed diagnostic values, never arbitrary transport fields.
      const metadata = result._meta as { error?: { details?: { phase?: unknown } } } | undefined;
      const phase = code === "github_hydration_failed"
        ? githubHydrationPhase(metadata?.error?.details?.phase)
        : undefined;
      const decoded = launchDetails.safeParse(structured?.details);
      const details = phase ? { phase } : decoded.success && Object.keys(decoded.data).length ? decoded.data : undefined;
      throw new ToolApiError(code, structured?.message ?? block?.text ?? "Operation failed.", details);
    }
    return result.structuredContent;
  } finally {
    await client.close();
    await server.close();
  }
}
