// Readability checks are an explicit CLI read, never a dashboard page or poll.
import {
  type ArmadaConfig,
  buildModel,
  type Credentials,
  fetchProgram,
  fetchTicketDescriptions,
  frontier,
  isClosed,
  LINEAR_KEY,
  lintTicket,
  lintWarning,
} from "@armada/core";
import { httpOptions, type Io, missingKey, UsageError } from "./io.ts";

export async function lint(
  io: Io,
  config: ArmadaConfig,
  credentials: Credentials,
  args: {
    rest: string[];
    options: Record<string, string>;
    json: boolean;
  },
): Promise<number> {
  const ready = args.options.ready === "true";
  if (!ready && !args.rest.length)
    throw new UsageError("lint needs --ready or ticket identifiers: armada lint --ready [<ticket>…]");
  const requested = [...new Set(args.rest.map((id) => id.toUpperCase()))];
  if (requested.some((id) => !/^[A-Z][A-Z0-9]*-\d+$/.test(id)))
    throw new UsageError("lint arguments must be ticket identifiers, e.g. ABC-12");
  if (!credentials.linearApiKey) throw missingKey(LINEAR_KEY);
  const linear = { apiKey: credentials.linearApiKey, ...httpOptions(io) };
  const program = await fetchProgram({ ...linear, rootId: config.tracker.programRoot, labels: config.tracker.labels });
  const model = buildModel(program.issues, program.rootId);
  // A malformed Spec prefix is still a spec to lint, even though the model cannot parse its ordinal.
  const specs = model.program.filter((i) => i.parentId === model.root.id && /^Spec\b/i.test(i.title));
  const specIds = new Set(specs.map((i) => i.id));
  const selected = new Set(requested);
  if (ready) {
    for (const c of frontier(model, { ready: config.tracker.readyLabel, parked: config.tracker.parkedLabel }))
      if (c.readyForAgent && !specIds.has(c.issue.id)) selected.add(c.issue.id);
    for (const spec of specs) if (!isClosed(spec)) selected.add(spec.id);
  }
  for (const id of requested)
    if (!model.byId.has(id)) throw new UsageError(`${id} is not in the program ${program.rootId}`);
  const issues = [...selected].map((id) => model.byId.get(id)).filter((i) => i !== undefined);
  const tickets = await fetchTicketDescriptions(
    linear,
    issues.map((i) => i.uuid),
  );
  const results = tickets
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))
    .map((ticket) => ({
      id: ticket.id,
      title: ticket.title,
      problems: lintTicket({ ...ticket, isSpec: specIds.has(ticket.id) }, config.tracker.lint),
    }));
  const errors = results.flatMap((r) => r.problems).filter((p) => p.severity === "error").length;
  if (args.json) io.stdout(`${JSON.stringify({ tickets: results, errors, warnings: program.warnings }, null, 2)}\n`);
  else {
    for (const result of results) {
      io.stdout(`${result.id} — ${result.title}\n`);
      if (!result.problems.length) io.stdout("  OK\n");
      for (const problem of result.problems) io.stdout(`  ${problem.severity}: ${lintWarning(result.id, problem)}\n`);
    }
    io.stdout(`Checked ${results.length} tickets; ${errors} errors.\n`);
    for (const warning of program.warnings) io.stderr(`armada: warning: ${warning}\n`);
  }
  return errors || program.warnings.length ? 1 : 0;
}
