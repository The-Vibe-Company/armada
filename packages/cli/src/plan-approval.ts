import {
  type ArmadaConfig,
  type BriefTicket,
  type Credentials,
  createLinearWriter,
  routingLabelKey,
} from "@armada/core";
import { type Io, UsageError } from "./io.ts";

/** --reason can explain a profile choice, explicit pre-approval, or both. */
export function preApprovalReason(options: Record<string, string>): string | null {
  if (options["pre-approve"] !== "true") return null;
  const reason = options.reason?.trim();
  if (!reason) throw new UsageError('--pre-approve needs --reason "<why>"');
  return reason;
}

/** Read and refuse before writing anything. The returned action runs just before minting. */
export async function preparePreApproval(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  briefTicket: BriefTicket,
  reason: string,
) {
  const options = {
    apiKey: credentials.linearApiKey as string,
    labels: config.tracker.labels,
    fetch: io.fetch ?? fetch,
  };
  const linear = io.linearWriter ? io.linearWriter(options) : createLinearWriter(options);
  const ticket = await linear.readTicket(briefTicket.id);
  if (!ticket) throw new UsageError(`ticket ${briefTicket.id} not found in Linear`);
  if (ticket.labelsTruncated) throw new UsageError(`cannot pre-approve ${ticket.id}: its labels could not all be read`);
  if (ticket.statusType === "completed" || ticket.statusType === "canceled")
    throw new UsageError(`cannot pre-approve ${ticket.id}: it is ${ticket.statusType}`);
  const { approvalLabel, preApprovedLabel } = config.policy;
  if (
    [...briefTicket.labels, ...ticket.labels.map((l) => l.name)].some(
      (name) => routingLabelKey(name) === routingLabelKey(approvalLabel),
    )
  )
    throw new UsageError(`cannot pre-approve ${ticket.id}: remove ${approvalLabel} first`);
  const label = await linear.labelByName(preApprovedLabel, ticket.teamId);
  if (!label)
    throw new UsageError(
      `plan label ${preApprovedLabel} does not exist for ${ticket.id}`,
      `armada doctor; create the configured label ${preApprovedLabel} in Linear`,
    );
  const present = ticket.labels.some((l) => routingLabelKey(l.name) === routingLabelKey(preApprovedLabel));
  return {
    preview: `${present ? "Would keep" : "Would add"} ${preApprovedLabel} ${present ? "on" : "to"} ${ticket.id} at launch: ${reason}`,
    async apply() {
      if (!present) await linear.updateTicket(ticket.uuid, { addLabelIds: [label.id] });
      if (!briefTicket.labels.some((name) => routingLabelKey(name) === routingLabelKey(preApprovedLabel)))
        briefTicket.labels.push(label.name);
      return reason;
    },
  };
}
