import type { LaunchError } from "@armada/core/server";
import type { ToolApiError } from "./tool-api.ts";

export function fail(
  status: number,
  code: string,
  message: string,
  details?: ToolApiError["details"] | Pick<LaunchError, "reason" | "action">,
): Response {
  return Response.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status, headers: { "cache-control": "no-store" } },
  );
}
