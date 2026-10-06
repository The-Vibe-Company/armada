// Coordinator-only tracker edits. A dry plan and sequential writes share the
// same pure planners; failures leave the unconfirmed work visible.
import {
  type ArmadaConfig,
  buildModel,
  type CreatedIssue,
  type Credentials,
  createLinearWriter,
  fetchProgram,
  LINEAR_KEY,
  planRenumber,
  planSpecInsert,
  type SpecPlan,
} from "@armada/core";
import { httpOptions, type Io, missingKey, UsageError } from "./io.ts";

export interface SpecArgs {
  rest: string[];
  options: Record<string, string>;
  json: boolean;
}

export function requireSpecCoordinator(credentials: Credentials) {
  if (credentials.armadaSignIn?.kind === "worker" || (!credentials.armadaSignIn && credentials.workerTickets.length))
    throw new UsageError("armada spec is coordinator-only; a worker session cannot create or rename specs");
}

const showRenames = (renames: SpecPlan["renames"]) => renames.map((r) => `  ${r.uuid}: ${r.from} → ${r.to}`).join("\n");

export async function specCommand(io: Io, config: ArmadaConfig, credentials: Credentials, args: SpecArgs) {
  requireSpecCoordinator(credentials);
  const [action, name, ...extra] = args.rest;
  if (action !== "add" && action !== "renumber") throw new UsageError('spec needs add "<name>" or renumber');
  if (extra.length || (action === "renumber" && name !== undefined)) throw new UsageError("unexpected spec argument");
  if (action === "add" && (!name?.trim() || /[\r\n]/.test(name)))
    throw new UsageError('spec add needs a non-empty name on one line: armada spec add "Search images"');
  if (action === "renumber" && args.options.at !== undefined) throw new UsageError("--at applies only to spec add");
  const at = args.options.at === undefined ? null : Number(args.options.at);
  if (at !== null && (!/^\d+$/.test(args.options.at ?? "") || !Number.isSafeInteger(at) || at < 1))
    throw new UsageError("--at must be a positive integer");
  if (!credentials.linearApiKey) throw missingKey(LINEAR_KEY);
  const opts = {
    apiKey: credentials.linearApiKey,
    labels: config.tracker.labels,
    ...httpOptions(io),
  };
  const program = await fetchProgram({ ...opts, rootId: config.tracker.programRoot, now: io.now });
  if (program.warnings.length)
    throw new UsageError(`the program read is incomplete; no specs changed:\n${program.warnings.join("\n")}`);
  const model = buildModel(program.issues, program.rootId);
  let plan: SpecPlan;
  try {
    plan =
      action === "add"
        ? planSpecInsert(model.specs, name ?? "", at, config.tracker.specTitles)
        : planRenumber(model.specs, config.tracker.specTitles);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : "invalid spec plan");
  }
  if (!args.json) {
    if (plan.renames.length) io.stdout(`Renames (${plan.renames.length}):\n${showRenames(plan.renames)}\n`);
    if (plan.create) io.stdout(`Create: ${plan.create.title}\nParent: ${model.root.id}\n`);
    if (!plan.create && !plan.renames.length) io.stdout("Spec titles are already in order.\n");
  }
  // A plain append with no renames is immediate. Explicit positions and
  // repairs are previews unless --apply was supplied.
  const apply = args.options.apply === "true" || (action === "add" && at === null && !plan.renames.length);
  if (!apply) {
    if (args.json) io.stdout(`${JSON.stringify({ ...plan, applied: false, created: null })}\n`);
    else if (plan.create || plan.renames.length)
      io.stdout("Preview only. Run the same command with --apply to make these changes.\n");
    return 0;
  }
  const writer = (io.linearWriter ?? createLinearWriter)(opts);
  let completed = 0;
  let created: CreatedIssue | null = null;
  try {
    const root = plan.create ? await writer.readTicket(model.root.id) : null;
    if (plan.create && !root) throw new Error(`program root ${model.root.id} is no longer readable`);
    // Move the suffix out of the new spec's position before creating it.
    for (const rename of plan.renames) {
      await writer.updateTicket(rename.uuid, { title: rename.to });
      completed++;
    }
    if (plan.create && root) {
      created = await writer.createIssue({ ...plan.create, teamId: root.teamId, parentId: model.root.uuid });
    }
  } catch (err) {
    const remaining = plan.renames.slice(completed);
    io.stderr("Spec changes stopped. Unconfirmed work (the failed request may have reached Linear):\n");
    if (remaining.length) io.stderr(`${showRenames(remaining)}\n`);
    if (plan.create && !created) io.stderr(`  Create: ${plan.create.title}\n`);
    io.stderr("Check the current titles in Linear before retrying; armada spec renumber previews a repair.\n");
    throw err;
  }
  if (args.json) io.stdout(`${JSON.stringify({ ...plan, applied: true, created })}\n`);
  else {
    if (completed) io.stdout(`Renamed ${completed} spec${completed === 1 ? "" : "s"}.\n`);
    if (created) io.stdout(`Created ${created.id}: ${plan.create?.title}\n${created.url}\n`);
  }
  return 0;
}
