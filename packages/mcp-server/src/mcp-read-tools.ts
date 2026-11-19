import { idlePauseMessage } from "@armada/core";
import { ProviderError, type SandboxStatus } from "@armada/core/server";
import * as z from "zod";
import type { SandboxView } from "./data.ts";
import {
  sandboxIdInput as id,
  SANDBOX_STATUSES,
  sandboxListInput,
  sandboxListMetadata,
  statusOutput,
} from "./sandbox-tool-schemas.ts";
import type { ToolRegistrar } from "./tool-registration.ts";
import type { ToolContext } from "./tools.ts";
import { isStatusReadFenced, readStatus, recordedStatus, type StatusReport, waitSettled } from "./turns.ts";

export const DEFAULT_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 600;

type VisibleSandbox = (sandboxId: string) => Promise<SandboxView>;

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
  tool(
    "list",
    {
      title: "List sandboxes",
      description:
        "Allowlisted metadata of sandboxes in your current organizations, newest first. Interior is owner/admin only. " +
        "Deleted ones are left out unless asked for. Statuses are as recorded; call status for a fresh read.",
      input: sandboxListInput.shape,
      output: {
        sandboxes: z.array(sandboxListMetadata),
        total: z.number().int(),
        page: z.number().int(),
        limit: z.number().int(),
        hasMore: z.boolean(),
        nextPage: z.number().int().nullable(),
      },
      readOnly: true,
    },
    async (args) => {
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
    },
  );
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
    if (waiting) return { ...recordedStatus(found), ...logicalExpiry(found.expiresAt, context.now()), ...queuePatch };
    if (recorded)
      return {
        ...publicReport(recordedStatus(found)),
        ...logicalExpiry(found.expiresAt, context.now()),
        statusMessage: `Recorded state only; use armada status ${sandboxId} --live for provider and prompt details.`,
      };
    try {
      const storedProvider = stored ? context.storedProviders?.[found.provider] : undefined;
      const provider =
        found.status === "deleted" || isStatusReadFenced(found)
          ? null
          : storedProvider
            ? await storedProvider(found)
            : await context.provider(found);
      const result = await measure("state", () =>
        readStatus(provider, data.sandboxes, found, {
          stored: storedProvider !== undefined,
          ...(promptId ? { promptId } : {}),
          now: context.now(),
        }),
      );
      return {
        ...publicReport(result),
        ...logicalExpiry(result.expiresAt, context.now()),
        statusMessage: idlePauseMessage(result, context.now()),
      };
    } catch (error) {
      if (!allowRecordedFallback || !(error instanceof ProviderError)) throw error;
      return {
        ...publicReport(recordedStatus(found)),
        ...logicalExpiry(found.expiresAt, context.now()),
        statusMessage: "Provider observation unavailable; showing recorded state.",
      };
    }
  };

  const readStatusTool = tool(
    "status",
    {
      title: "Sandbox status",
      description:
        "Where a sandbox and its latest turn are. Modal uses authorized stored observations; physical state is refreshed by the lifecycle worker. Boat is read live. prompt.state is " +
        "queued (accepted by a starting Docker sandbox, not yet admitted by its runtime), running, finished, interrupted or failed; failed includes a usage limit or an expired login, with " +
        "the reason. settled is true when the agent is not working.",
      input: {
        id,
        prompt_id: z.string().min(1).optional().describe("A specific turn. Default: the latest."),
        recorded: z
          .boolean()
          .optional()
          .describe(
            "True: database-only state. False: live provider probe. Omitted: provider-specific detail read. CLI defaults to true; --live sets false.",
          ),
      },
      output: statusOutput,
      readOnly: true,
    },
    async (args) => {
      const report = await statusOf(args.id, args.prompt_id, args.recorded === undefined, true, args.recorded === true);
      const launch = data.sandboxes.launchTiming ? await data.sandboxes.launchTiming(report.id) : undefined;
      return launch === undefined ? report : { ...report, launch };
    },
    true,
  );

  const waitTool = tool(
    "wait",
    {
      title: "Wait for the agent",
      description:
        `Blocks until the agent settles (its turn finished, failed or was interrupted, or the machine stopped) ` +
        `or the timeout passes, then answers like status with timedOut. Default ${DEFAULT_WAIT_SECONDS}s, ` +
        `at most ${MAX_WAIT_SECONDS}s: call again to keep waiting.`,
      input: {
        id,
        timeout_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional(),
        prompt_id: z.string().min(1).optional().describe("A specific turn. Default: the latest."),
      },
      output: { ...statusOutput, timedOut: z.boolean() },
      readOnly: true,
    },
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
