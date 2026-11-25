import { readLogsOperation } from "@armada/core/contract";
import { type Provider, VaultError } from "@armada/core/server";
import type { z } from "zod";
import type { Caller } from "./caller.ts";
import type { ControlOptions } from "./control.ts";
import { readBody } from "./control-body.ts";
import { scopedOrg, selectedCaller } from "./control-caller.ts";
import { readEventPages, validateLogPagination } from "./event-pagination.ts";
import { buildLogsThreadStatus } from "./mcp-read-tools.ts";
import { publicLogEvents } from "./model-usage.ts";
import { measureRequestPhase } from "./request-timing.ts";
import { defineRoutes } from "./routes.ts";
import { latestPromptEvent } from "./turns.ts";

type LogControlOptions = Pick<ControlOptions, "dockerControls" | "logs" | "timing" | "accountTurns" | "now">;

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
  threadStatus?: ReturnType<typeof buildLogsThreadStatus>["threadStatus"];
  source?: "armada-runtime";
  runtimeFailure?: { status: "failed"; reason: string };
  olderCursor?: string;
}> {
  validateLogPagination(body);
  async function project(
    events: { promptId?: string }[],
    threadStatus?: ReturnType<typeof buildLogsThreadStatus>["threadStatus"],
  ) {
    const items = [
      ...events,
      ...(threadStatus?.prompt ? [threadStatus.prompt] : []),
      ...(threadStatus?.usage?.turns ?? []),
    ];
    const ids = await options.accountTurns?.publicPromptIds(
      caller,
      id,
      items.flatMap((e) => (e.promptId ? [e.promptId] : [])),
    );
    for (const item of items) if (item.promptId && ids?.has(item.promptId)) item.promptId = ids.get(item.promptId)!;
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
      await project(result.events, result.threadStatus);
      return result;
    }
  }
  if (!options.logs) throw new VaultError("unavailable", "Sandbox logs are not configured on the server.");
  const target = await measureRequestPhase(options.timing, "logs_target", () => options.logs!(caller, id));
  const page = parseLogInput(nativePageInput, { ...body, all: body.all === true, follow: body.follow === true });
  const backward = page.direction === "backward";
  const sampledSettlement =
    target.provider.followSettled && (page.follow || target.sandbox)
      ? page.follow
        ? await measureRequestPhase(options.timing, "state", () => target.provider.followSettled!())
        : await target.provider.followSettled()
      : undefined;
  const { events, cursor, hasMore, source, runtimeFailure, olderCursor } = await readEventPages(
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
  );
  // Ordinary history reads need only the authorized event stream. Live compute is
  // consulted solely to decide whether a follow request should keep waiting.
  const checkingFollow = page.follow && !runtimeFailure;
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
  const followSettledValue =
    durableSettled ??
    (runtimeFailure !== undefined ||
      info?.state === "stopped" ||
      info?.state === "failed" ||
      (latest === null ? info?.state !== "running" && info?.state !== "starting" : prompt?.done === true));
  const thread = target.sandbox
    ? buildLogsThreadStatus(
        target.sandbox,
        events,
        options.now?.() ?? new Date(),
        page.follow ? followSettledValue : sampledSettlement,
      )
    : undefined;
  await project(publicEvents, thread?.threadStatus);
  return {
    ...(source ? { source } : {}),
    ...(runtimeFailure ? { runtimeFailure } : {}),
    ...(olderCursor ? { olderCursor } : {}),
    ...(thread ? { threadStatus: thread.threadStatus } : {}),
    events: publicEvents,
    cursor,
    hasMore,
    settled: page.follow ? followSettledValue : (thread?.settled ?? true),
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
