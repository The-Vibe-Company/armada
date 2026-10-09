import {
  type AckResult,
  ArmadaApiError,
  type ArmadaConfig,
  type Credentials,
  createLinearWriter,
  isLabelPhase,
  Refusal,
} from "@armada/core";
import { coordinatorName } from "./coordinator.ts";
import { httpOptions, type Io, UsageError } from "./io.ts";
import { requireSignIn } from "./login.ts";
import { outgoingRedactor } from "./redact.ts";
import { coordinatorHandle, rearmFor, remember } from "./watch.ts";
import { liveFleet, type WorkerArgs } from "./worker.ts";

/** Record the durable acknowledgement first, then post exactly one tracker note. */
export async function ack(io: Io, config: ArmadaConfig, credentials: Credentials, args: WorkerArgs): Promise<number> {
  const [target, ...extra] = args.rest;
  const reason = args.options.reason?.trim();
  if (!target || extra.length || !reason)
    throw new UsageError('ack needs one target and a reason: armada ack <#id or key> --reason "<why>"');
  requireSignIn(credentials);
  if (credentials.armadaSignIn?.kind === "worker")
    throw new Refusal("only a coordinator can acknowledge inbox entries", "the coordinator runs armada ack");
  const { fleet, warning } = liveFleet(io, config, credentials);
  if (!fleet) throw new Refusal(`cannot record an acknowledgement: ${warning}`, "armada whoami");
  const mask = await outgoingRedactor(io, config, credentials);
  const text = mask.text(reason);
  const coordinator = await coordinatorName(io, config.project.slug);
  const policy = {
    silentAfterMinutes: config.policy.silentAfterMinutes,
    launchGraceMinutes: config.policy.launchGraceMinutes,
    ciWaitMinutes: config.policy.ciWaitMinutes,
    quietAfterMinutes: config.policy.quietAfterMinutes,
    notStartedMinutes: config.policy.notStartedMinutes,
  };
  let result: AckResult;
  try {
    result = await fleet.ack({ target, reason: text, coordinator, ...policy });
  } catch (error) {
    if (error instanceof ArmadaApiError && error.status === 404 && /no fleet operation ack/.test(error.message))
      throw new Refusal("this Armada does not know ack yet; deploy the API first", "deploy the API before the CLI");
    throw error;
  }
  const lines = [
    result.status === "already-resolved"
      ? `${target}: already resolved.`
      : `${target}: acknowledged ${result.kind}: ${text}`,
  ];
  const warnings: string[] = [];
  const recorded = result.status === "acknowledged" || result.recorded === true;
  if (recorded && result.ticket) {
    let phase = isLabelPhase(result.phase ?? "") ? result.phase : null;
    const note = () =>
      phase
        ? `Agent status: ${phase} — note: acknowledged ${result.kind}: ${text}`
        : `Coordinator ${result.coordinator} acknowledged ${result.kind}: ${text}`;
    try {
      if (!credentials.linearApiKey) throw new Error("no Linear key is available");
      const options = { apiKey: credentials.linearApiKey, labels: config.tracker.labels, ...httpOptions(io) };
      const linear = io.linearWriter ? io.linearWriter(options) : createLinearWriter(options);
      const ticket = await linear.readTicket(result.ticket);
      if (!ticket) throw new Error("the ticket could not be read");
      phase = ticket.agentPhase;
      await linear.comment(ticket.uuid, note(), { retry: false });
      lines.push(`Reason posted on ${result.ticket}.`);
    } catch (error) {
      warnings.push(
        mask.text(
          `acknowledgement recorded in Armada, but the Linear comment failed (${error instanceof Error ? error.message : String(error)}); creation was not retried`,
        ),
      );
      lines.push(`Post this on ${result.ticket}:\n${note()}`);
    }
  } else if (recorded) {
    lines.push("Ticketless entry: reason recorded in Armada only.");
  }
  let inFlight: string[] | null = null;
  let open: number | null = null;
  let openJobs: number[] | undefined;
  try {
    const read = await fleet.inbox({
      ...policy,
      coordinator: coordinatorHandle(io),
      coordinatorName: coordinator,
      scope: "all",
      etag: null,
    });
    if (read) {
      inFlight = coordinator === "default" ? (read.inFlight ?? null) : (read.ownedInFlight ?? null);
      openJobs = coordinator === "default" ? read.openJobs : read.ownedOpenJobs;
      open = read.items.filter((entry) => !entry.queue && (entry.owner == null || entry.owner === coordinator)).length;
      await remember(io, config.project.slug, { inFlight, openJobs, readAt: (io.now?.() ?? new Date()).toISOString() });
    }
  } catch (error) {
    warnings.push(
      mask.text(
        `acknowledgement recorded, but the watch reading failed (${error instanceof Error ? error.message : String(error)}); run armada inbox`,
      ),
    );
  }
  const watch = await rearmFor(io, config.project.slug, { inFlight, open, openJobs, act: open !== null && open > 0 });
  io.stdout(
    args.json
      ? `${JSON.stringify({ ...result, lines, warnings, watch }, null, 2)}\n`
      : `${[...lines, watch.line].join("\n")}\n`,
  );
  for (const warning of warnings) io.stderr(`armada: warning: ${warning}\n`);
  return 0;
}
