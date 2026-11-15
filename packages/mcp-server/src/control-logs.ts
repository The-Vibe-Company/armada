import { type Provider, VaultError } from "@armada/core/server";
import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";
import { optional } from "./control-input.ts";
import { readEventPages } from "./event-pagination.ts";
import { publicLogEvents } from "./model-usage.ts";
import { measureRequestPhase } from "./request-timing.ts";
import { latestPromptEvent } from "./turns.ts";

type LogControlOptions = Pick<ControlOptions, "dockerControls" | "logs" | "timing">;

export async function readLogs(
  options: LogControlOptions,
  caller: Caller,
  id: string,
  body: Record<string, unknown>,
): Promise<{
  events: Awaited<ReturnType<Provider["events"]>>["events"];
  cursor: string | null;
  hasMore: boolean;
  settled: boolean;
  source?: "armada-runtime";
  runtimeFailure?: { status: "failed"; reason: string };
  olderCursor?: string;
}> {
  if (options.dockerControls) {
    const routed = await options.dockerControls.invoke(caller, "logs", {
      id,
      ...(body.cursor === undefined ? {} : { since_cursor: body.cursor }),
      ...(body.conversationId === undefined ? {} : { conversation_id: body.conversationId }),
      ...Object.fromEntries(
        ["limit", "all", "direction", "maxBytes", "coalesce", "follow"]
          .filter((key) => body[key] !== undefined)
          .map((key) => [key, body[key]]),
      ),
    });
    if (routed.handled) return routed.result as Awaited<ReturnType<typeof readLogs>>;
  }
  if (!options.logs) throw new VaultError("unavailable", "Sandbox logs are not configured on the server.");
  const target = await measureRequestPhase(options.timing, "logs_target", () => options.logs!(caller, id));
  if (body.direction !== undefined && body.direction !== "forward" && body.direction !== "backward")
    throw new VaultError("invalid", "Invalid event direction.");
  for (const key of ["limit", "maxBytes"])
    if (body[key] !== undefined && typeof body[key] !== "number")
      throw new VaultError("invalid", "Invalid event pagination.");
  if (body.coalesce !== undefined && typeof body.coalesce !== "boolean")
    throw new VaultError("invalid", "Invalid coalesce option.");
  const backward = body.direction === "backward";
  const all = body.all === true;
  if (backward && all) throw new VaultError("invalid", "Backward reads cannot drain all pages.");
  const follow = body.follow === true;
  const { events, cursor, hasMore, source, runtimeFailure, olderCursor } = await readEventPages(
    (cursor) =>
      measureRequestPhase(options.timing, "events", () =>
        target.provider.events({
          sandboxId: target.providerSandboxId,
          ...(cursor ? { cursor } : {}),
          ...(backward ? { direction: "backward" as const } : {}),
          ...(typeof body.limit === "number" ? { limit: body.limit } : {}),
          ...(typeof body.maxBytes === "number" ? { maxBytes: body.maxBytes } : {}),
          ...(typeof body.coalesce === "boolean" ? { coalesce: body.coalesce } : {}),
          ...(optional(body, "conversationId") ? { conversationId: optional(body, "conversationId")! } : {}),
        }),
      ),
    optional(body, "cursor"),
    all,
  );
  // Ordinary history reads need only the authorized event stream. Live compute is
  // consulted solely to decide whether a follow request should keep waiting.
  const info =
    follow && !runtimeFailure
      ? await measureRequestPhase(options.timing, "state", () => target.provider.get(target.providerSandboxId))
      : null;
  const latest = latestPromptEvent(events)?.promptId ?? null;
  // A live sandbox with no turn is idle, so following has nothing to wait for.
  const prompt =
    follow && !runtimeFailure && latest && info?.state !== "stopped" && info?.state !== "failed"
      ? await measureRequestPhase(options.timing, "prompt", () =>
          target.provider.getPrompt({ sandboxId: target.providerSandboxId, promptId: latest }),
        )
      : null;
  return {
    ...(source ? { source } : {}),
    ...(runtimeFailure ? { runtimeFailure } : {}),
    ...(olderCursor ? { olderCursor } : {}),
    events: publicLogEvents(events),
    cursor,
    hasMore,
    settled:
      !follow ||
      runtimeFailure !== undefined ||
      info?.state === "stopped" ||
      info?.state === "failed" ||
      (latest === null ? info?.state !== "running" && info?.state !== "starting" : prompt?.done === true),
  };
}
