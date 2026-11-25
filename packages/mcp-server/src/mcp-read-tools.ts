import { type AgentEvent, idlePauseMessage, observedPromptOutcome } from "@armada/core";
import {
  DEFAULT_WAIT_SECONDS,
  sandboxIdInput as id,
  LOGS_OUTPUT,
  MAX_LOG_PAGES,
  SANDBOX_STATUSES,
  sandboxOperations,
} from "@armada/core/contract";
import { type Provider, ProviderError, type SandboxStatus } from "@armada/core/server";
import * as z from "zod";
import type { SandboxView } from "./data.ts";
import { readEventPages } from "./event-pagination.ts";
import { publicLogEvents } from "./model-usage.ts";
import { ToolError } from "./tool-error.ts";
import type { ToolRegistrar } from "./tool-registration.ts";
import type { ToolContext } from "./tools.ts";
import {
  isStatusReadFenced,
  latestPromptEvent,
  type PromptReport,
  readStatus,
  recordedStatus,
  type StatusReport,
  waitSettled,
} from "./turns.ts";

export { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from "@armada/core/contract";

type VisibleSandbox = (sandboxId: string) => Promise<SandboxView>;

function hasConfirmedStop(sandbox: SandboxView) {
  return (
    (sandbox.status === "stopped" || sandbox.status === "failed") &&
    !sandbox.stopRequestedAt &&
    Boolean(sandbox.stoppedAt)
  );
}

export function logicalExpiry(expiresAt: string | null | undefined, now: Date) {
  const deadline = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const timeLeftSeconds = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - now.getTime()) / 1000)) : null;
  return {
    expiresAt: expiresAt ?? null,
    timeLeftSeconds,
    expiringSoon: timeLeftSeconds !== null && timeLeftSeconds <= 300,
  };
}

export function registerListTool(context: ToolContext, tool: ToolRegistrar) {
  const { caller, data } = context;
  tool("list", sandboxOperations.listSandboxes.tool, async (args) => {
    const statuses: readonly SandboxStatus[] = args.status ?? SANDBOX_STATUSES.filter((name) => name !== "deleted");
    const limit = args.limit ?? 25;
    const page = args.page ?? 1;
    const { rows, total } = await data.sandboxes.list({
      statuses,
      limit,
      page,
      ...(args.harness === undefined ? {} : { harness: args.harness }),
      ...(args.golden === undefined ? {} : { goldenId: args.golden }),
      ...(args.owner === undefined ? {} : { ownerId: args.owner === "me" ? caller.userId : args.owner }),
      ...(args.externalRef === undefined ? {} : { externalRef: args.externalRef }),
    });
    const hasMore = page * limit < total;
    return {
      total,
      page,
      limit,
      hasMore,
      nextPage: hasMore && page < 1_000_000 ? page + 1 : null,
      sandboxes: rows.map((row) => ({
        ...row,
        ...logicalExpiry(row.expiresAt, context.now()),
        statusMessage: idlePauseMessage(row, context.now()),
      })),
    };
  });
}

export function registerStatusTools(
  context: ToolContext,
  tool: ToolRegistrar,
  visible: VisibleSandbox,
  measure: NonNullable<ToolContext["measure"]>,
) {
  const { caller, data } = context;
  const statusOf = async (
    sandboxId: string,
    promptId: string | undefined,
    stored = false,
    allowRecordedFallback = false,
    recorded = false,
  ) => {
    const currentTurn = promptId === undefined;
    const queued = await context.accountTurns?.status(caller, sandboxId, promptId);
    const publicPromptId = queued && "nativePromptId" in queued ? (promptId ?? queued.publicPromptId) : undefined;
    const publicReport = (report: StatusReport) =>
      publicPromptId
        ? {
            ...report,
            ...(report.prompt ? { prompt: { ...report.prompt, promptId: publicPromptId } } : {}),
            ...(report.usage
              ? {
                  usage: {
                    ...report.usage,
                    turns: report.usage.turns.map((turn) =>
                      turn.promptId === promptId ? { ...turn, promptId: publicPromptId } : turn,
                    ),
                  },
                }
              : {}),
          }
        : report;
    if (queued && "nativePromptId" in queued) promptId = queued.nativePromptId;
    const waiting = queued && !("nativePromptId" in queued) ? queued : undefined;
    const routed = await context.dockerControls?.invoke(caller, "status", {
      id: sandboxId,
      ...(promptId && !waiting ? { prompt_id: promptId } : {}),
      ...(recorded ? { recorded: true } : {}),
    });
    const queuePatch = waiting
      ? {
          statusMessage: waiting.message,
          settled: waiting.failed ?? false,
          prompt: {
            promptId: waiting.requestId!,
            conversationId: waiting.conversationId!,
            state: waiting.failed ? ("failed" as const) : ("running" as const),
            reason: waiting.message,
          },
        }
      : {};
    if (routed?.handled) {
      const report = publicReport(routed.result as StatusReport);
      return { ...report, ...logicalExpiry(report.expiresAt, context.now()), providerExpiresAt: null, ...queuePatch };
    }
    const found = await measure("sandbox_read", () => visible(sandboxId));
    const confirmedStop = hasConfirmedStop(found);
    const fenced = found.status === "deleted" || isStatusReadFenced(found);
    const enrolled = found.status === "ready" || found.status === "running";
    const jobReader =
      enrolled || (!recorded && (confirmedStop || (!waiting && !fenced)))
        ? await context.modalJobReader?.(found)
        : null;
    const enrolledStatus = enrolled ? jobReader?.enrolledStatus : undefined;
    const setupPending = enrolledStatus === "starting";
    if (setupPending || enrolledStatus === "failed")
      return {
        ...recordedStatus(found),
        ...logicalExpiry(found.expiresAt, context.now()),
        status: enrolledStatus,
        statusReason: setupPending ? null : jobReader!.setupFailure,
        settled: !setupPending,
        statusMessage: setupPending ? "Modal launch setup is still in progress." : "Modal launch setup failed.",
        ...(currentTurn ? {} : queuePatch),
      };
    const stopEvidence = async (status: SandboxStatus) => {
      const latest = await jobReader?.verify();
      return latest && latest.status === status && hasConfirmedStop(latest) ? { providerState: "stopped" } : {};
    };
    if (waiting)
      return {
        ...recordedStatus(found),
        ...logicalExpiry(found.expiresAt, context.now()),
        ...queuePatch,
        ...(await stopEvidence(found.status)),
      };
    if (recorded)
      return {
        ...publicReport(recordedStatus(found)),
        ...logicalExpiry(found.expiresAt, context.now()),
        statusMessage: `Recorded state only; use armada info ${sandboxId} --live for provider and prompt details.`,
      };
    try {
      const storedProvider = stored ? context.storedProviders?.[found.provider] : undefined;
      const provider = fenced
        ? null
        : (jobReader ?? (storedProvider ? await storedProvider(found) : await context.provider(found)));
      const result = await measure("state", () =>
        readStatus(provider, data.sandboxes, found, {
          stored: storedProvider !== undefined,
          ...(promptId ? { promptId } : {}),
          now: context.now(),
        }),
      );
      const settled = result.settled && (!jobReader || !currentTurn || (await jobReader.followSettled()));
      return {
        ...publicReport(result),
        settled,
        ...logicalExpiry(result.expiresAt, context.now()),
        statusMessage: idlePauseMessage(result, context.now()),
        ...(await stopEvidence(result.status)),
      };
    } catch (error) {
      if (jobReader || !allowRecordedFallback || !(error instanceof ProviderError)) throw error;
      return {
        ...publicReport(recordedStatus(found)),
        ...logicalExpiry(found.expiresAt, context.now()),
        statusMessage: "Provider observation unavailable; showing recorded state.",
      };
    }
  };

  const readStatusTool = tool(
    "status",
    sandboxOperations.sandboxStatus.tool,
    async (args) => {
      const report = await statusOf(args.id, args.prompt_id, args.recorded === undefined, true, args.recorded === true);
      const launch = data.sandboxes.launchTiming ? await data.sandboxes.launchTiming(report.id) : undefined;
      return launch === undefined ? report : { ...report, launch };
    },
    true,
  );

  const waitTool = tool(
    "wait",
    sandboxOperations.waitSandbox.tool,
    (args) =>
      waitSettled(() => statusOf(args.id, args.prompt_id), {
        timeoutMs: (args.timeout_seconds ?? DEFAULT_WAIT_SECONDS) * 1000,
        now: context.now,
        sleep: context.sleep,
      }),
    true,
  );

  return { statusOf, readStatusTool, waitTool };
}

export function registerLogsTool(
  context: ToolContext,
  tool: ToolRegistrar,
  visible: VisibleSandbox,
  surface: "mcp" | "rest",
) {
  tool(
    "logs",
    {
      title: "Read events",
      description:
        "The agent's events oldest first: prompts (with status and failure reason), messages and tool calls, " +
        "steers. The default is one bounded page (100 events). Set all to read every available page (up to " +
        `${MAX_LOG_PAGES} pages) in one response. Pass the returned cursor as since_cursor to read only what is new. ` +
        "An event read twice has the same id and the newer body; each id appears once per response.",
      input: {
        id,
        since_cursor: z.string().min(1).optional().describe("The cursor of the previous page."),
        limit: z.number().int().min(1).max(500).optional(),
        all: z.boolean().optional().describe("Read up to 100 pages. Use forward direction only."),
        direction: z.enum(["forward", "backward"]).optional(),
        maxBytes: z.number().int().min(256).max(1048576).optional(),
        coalesce: z.boolean().optional(),
      },
      output: {
        ...LOGS_OUTPUT,
        settled:
          surface === "rest"
            ? LOGS_OUTPUT.settled.describe("Whether the current turn has settled. Use status or wait for live probes.")
            : LOGS_OUTPUT.settled.describe("Whether the current turn has settled. Use status for live probes."),
      },
      readOnly: true,
    },
    async (args) => {
      const found = await visible(args.id);
      if (found.status === "deleted") throw new ToolError("conflict", "Sandbox is deleted.");
      const resolveProvider = context.logProvider ?? context.storedProviders?.[found.provider] ?? context.provider;
      const provider = await resolveProvider(found);
      const durableSettled =
        "followSettled" in provider && typeof provider.followSettled === "function"
          ? await provider.followSettled()
          : undefined;
      const page = await readLogs(provider, found.providerSandboxId, {
        ...(args.since_cursor ? { since_cursor: args.since_cursor } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
        ...(args.all ? { all: true } : {}),
        ...(args.direction ? { direction: args.direction } : {}),
        ...(args.maxBytes ? { maxBytes: args.maxBytes } : {}),
        ...(args.coalesce !== undefined ? { coalesce: args.coalesce } : {}),
      });
      const { threadStatus, settled } = buildLogsThreadStatus(found, page.rawEvents, context.now(), durableSettled);
      return {
        ...page.response,
        events: page.response.events.map((item) => ({ ...item })),
        threadStatus,
        settled,
      };
    },
  );
}

export function buildLogsThreadStatus(
  sandbox: SandboxView,
  events: readonly AgentEvent[],
  now: Date,
  durableSettled?: boolean,
) {
  const latest = latestPromptEvent(events);
  const terminal = sandbox.status === "stopped" || sandbox.status === "failed" || sandbox.status === "deleted";
  const terminalState = sandbox.status === "failed" ? ("failed" as const) : ("interrupted" as const);
  let prompt: PromptReport | null = null;
  if (latest?.kind === "prompt" && latest.promptId) {
    const outcome = observedPromptOutcome(latest.status, latest.promptId, events);
    const state = outcome.state === "running" && terminal ? terminalState : outcome.state;
    const reason = outcome.state === "failed" || outcome.state === "interrupted" ? (outcome.reason ?? null) : null;
    prompt = {
      promptId: latest.promptId,
      conversationId: latest.conversationId ?? null,
      state,
      reason: state === "failed" || state === "interrupted" ? reason : null,
      ...(outcome.state === "failed" && outcome.limit ? { limit: outcome.limit } : {}),
    };
  } else if (sandbox.taskPromptId && (durableSettled !== undefined || sandbox.status === "running" || terminal)) {
    prompt = {
      promptId: sandbox.taskPromptId,
      conversationId: sandbox.conversationIds?.at(-1) ?? null,
      state: terminal ? terminalState : durableSettled ? "finished" : "running",
      reason: null,
    };
  }
  const down =
    sandbox.status === "stopped" ||
    sandbox.status === "deleted" ||
    (sandbox.status === "failed" && !sandbox.stopRequestedAt);
  const baseSettled =
    !sandbox.stopRequestedAt &&
    sandbox.status !== "stopping" &&
    (down || (prompt ? prompt.state !== "running" : sandbox.status !== "running" && sandbox.status !== "starting"));
  return {
    threadStatus: {
      status: sandbox.status,
      statusMessage: idlePauseMessage(sandbox, now),
      prompt,
      usage: sandbox.usage ?? null,
    },
    settled: durableSettled === undefined ? baseSettled : baseSettled && durableSettled,
  };
}

async function readLogs(
  provider: Pick<Provider, "events">,
  sandboxId: string,
  args: {
    since_cursor?: string;
    limit?: number;
    all?: boolean;
    direction?: "forward" | "backward";
    maxBytes?: number;
    coalesce?: boolean;
  },
) {
  const { events, cursor, hasMore, olderCursor, source, runtimeFailure } = await readEventPages(
    (cursor) =>
      provider.events({
        sandboxId,
        ...(args.direction ? { direction: args.direction } : {}),
        ...(args.maxBytes ? { maxBytes: args.maxBytes } : {}),
        ...(args.coalesce !== undefined ? { coalesce: args.coalesce } : {}),
        ...(cursor ? { cursor } : {}),
        ...(args.limit ? { limit: args.limit } : {}),
      }),
    args.since_cursor,
    args.all === true,
  );
  return {
    rawEvents: events,
    response: {
      ...(olderCursor ? { olderCursor } : {}),
      ...(source ? { source } : {}),
      ...(runtimeFailure ? { runtimeFailure } : {}),
      events: publicLogEvents(events),
      cursor,
      hasMore,
    },
  };
}
