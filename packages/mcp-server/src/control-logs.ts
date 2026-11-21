import { readLogsOperation } from "@armada/core/contract";
import { type Provider, VaultError } from "@armada/core/server";
import type { z } from "zod";
import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";
import { readBody } from "./control-body.ts";
import { scopedOrg, selectedCaller } from "./control-caller.ts";
import { readEventPages, validateLogPagination } from "./event-pagination.ts";
import { publicLogEvents } from "./model-usage.ts";
import { measureRequestPhase } from "./request-timing.ts";
import { defineRoutes } from "./routes.ts";
import { latestPromptEvent } from "./turns.ts";

type LogControlOptions = Pick<ControlOptions, "dockerControls" | "logs" | "timing" | "accountTurns">;

const { body: logsInput } = readLogsOperation.input;
const nativePageInput = logsInput.omit({ id: true, org: true });

function parseLogInput<T extends z.ZodType>(schema: T, input: unknown) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new VaultError("invalid", parsed.error.issues[0]!.message);
  return parsed.data;
}

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
  validateLogPagination(body);
  async function project(events: { promptId?: string }[]) {
    const ids = await options.accountTurns?.publicPromptIds(
      caller,
      id,
      events.flatMap((e) => (e.promptId ? [e.promptId] : [])),
    );
    for (const event of events)
      if (event.promptId && ids?.has(event.promptId)) event.promptId = ids.get(event.promptId)!;
  }
  if (options.dockerControls) {
    const routed = await options.dockerControls.invoke(caller, "logs", {
      id,
      ...(body.cursor === undefined ? {} : { since_cursor: body.cursor }),
      ...Object.fromEntries(
        ["limit", "all", "direction", "maxBytes", "coalesce", "follow"]
          .filter((key) => body[key] !== undefined)
          .map((key) => [key, body[key]]),
      ),
    });
    if (routed.handled) {
      const result = routed.result as Awaited<ReturnType<typeof readLogs>>;
      await project(result.events);
      return result;
    }
  }
  if (!options.logs) throw new VaultError("unavailable", "Sandbox logs are not configured on the server.");
  const target = await measureRequestPhase(options.timing, "logs_target", () => options.logs!(caller, id));
  const page = parseLogInput(nativePageInput, { ...body, all: body.all === true, follow: body.follow === true });
  const backward = page.direction === "backward";
  const sampledSettlement =
    page.follow && target.provider.followSettled
      ? await measureRequestPhase(options.timing, "state", () => target.provider.followSettled!())
      : undefined;
  const { events, cursor, hasMore, source, runtimeFailure, olderCursor, paused } = await readEventPages(
    (cursor) =>
      measureRequestPhase(options.timing, "events", () =>
        target.provider.events({
          sandboxId: target.providerSandboxId,
          ...(cursor ? { cursor } : {}),
          ...(backward ? { direction: "backward" as const } : {}),
          ...(page.limit !== undefined ? { limit: page.limit } : {}),
          ...(page.maxBytes !== undefined ? { maxBytes: page.maxBytes } : {}),
          ...(page.coalesce !== undefined ? { coalesce: page.coalesce } : {}),
        }),
      ),
    page.cursor ?? undefined,
    page.all === true,
    { pauseOnNativeLease: !backward },
  );
  // Ordinary history reads need only the authorized event stream. Live compute is
  // consulted solely to decide whether a follow request should keep waiting.
  const checkingFollow = page.follow && !paused && !runtimeFailure;
  const durableSettled = checkingFollow ? sampledSettlement : undefined;
  const info =
    checkingFollow && durableSettled === undefined
      ? await measureRequestPhase(options.timing, "state", () => target.provider.get(target.providerSandboxId))
      : null;
  const latest = latestPromptEvent(events)?.promptId ?? null;
  // A live sandbox with no turn is idle, so following has nothing to wait for.
  const prompt =
    checkingFollow && durableSettled === undefined && latest && info?.state !== "stopped" && info?.state !== "failed"
      ? await measureRequestPhase(options.timing, "prompt", () =>
          target.provider.getPrompt({ sandboxId: target.providerSandboxId, promptId: latest }),
        )
      : null;
  const publicEvents = publicLogEvents(events);
  await project(publicEvents);
  return {
    ...(source ? { source } : {}),
    ...(runtimeFailure ? { runtimeFailure } : {}),
    ...(olderCursor ? { olderCursor } : {}),
    events: publicEvents,
    cursor,
    hasMore,
    settled:
      !page.follow ||
      (durableSettled ??
        (!paused &&
          (runtimeFailure !== undefined ||
            info?.state === "stopped" ||
            info?.state === "failed" ||
            (latest === null ? info?.state !== "running" && info?.state !== "starting" : prompt?.done === true)))),
  };
}

export const logRoutes = defineRoutes("logs", {
  [readLogsOperation.route.path.slice("/api/v1/".length)]: {
    methods: [readLogsOperation.route.method],
    readBody: (request) => readBody(request, 512 * 1024),
    handler: async ({ caller, body, options }) => {
      const org = parseLogInput(logsInput.shape.org, body.org) ?? undefined;
      scopedOrg(caller, org);
      const scoped = await selectedCaller(options, caller, org);
      return readLogs(options, scoped, parseLogInput(logsInput.shape.id, body.id), body);
    },
  },
});
