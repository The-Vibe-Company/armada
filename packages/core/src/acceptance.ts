// Live checks are bounded local commands. Linear records attempts and evidence;
// fleet report events are optional, as for every worker command.

import type { AcceptanceRule } from "./config.ts";
import { findHandBack } from "./merge.ts";
import { acceptancePasses, applicableAcceptance, FULL_SHA, transitionProblem } from "./phases.ts";
import { Refusal } from "./refusal.ts";
import {
  live,
  type Outcome,
  readOpenTicket,
  reportPhase,
  resolvePr,
  ticketState,
  type WorkerContext,
} from "./worker.ts";

export interface AcceptanceRunner {
  /** Refuses a dirty checkout or a HEAD other than the expected pull request head. */
  checkHead: (head: string) => Promise<void>;
  run: (rule: AcceptanceRule) => Promise<{ ok: boolean; output: string }>;
}

/** Run one named check, or every applicable check, stopping at the first failure. */
export async function runAcceptance(
  ctx: WorkerContext,
  input: { ticket: string; name?: string },
  runner: AcceptanceRunner,
): Promise<{ ok: boolean; outcomes: Outcome[] }> {
  const ticket = await readOpenTicket(ctx, input.ticket);
  if (ticket.commentsTruncated)
    throw new Refusal(
      "not every Linear comment could be read; acceptance run counts are incomplete",
      "try again once Linear answers",
    );
  const problem = transitionProblem(ticket.agentPhase, "shipping");
  if (problem) throw new Refusal(problem, "report implementing before running acceptance");
  const reference = resolvePr(ticket, ctx.config.github.repository, null);
  if (!reference || !ctx.readPull)
    throw new Refusal(
      "acceptance needs a linked pull request and GitHub access",
      "link the pull request and sign in to GitHub",
    );
  const pr = await ctx.readPull(reference.number);
  if (!pr?.headSha || !FULL_SHA.test(pr.headSha) || (pr.state && pr.state !== "open"))
    throw new Refusal(
      "acceptance needs an open pull request with a full head SHA",
      "push the ticket branch and check its pull request",
    );
  const rules = applicableAcceptance(ctx.config.acceptance, pr);
  if (input.name !== undefined && !ctx.config.acceptance.some((r) => r.name === input.name))
    throw new Refusal(
      `unknown acceptance check ${JSON.stringify(input.name)}`,
      "use a name from armada.toml [[acceptance]]",
    );
  const selected = input.name === undefined ? rules : rules.filter((r) => r.name === input.name);
  const outcomes: Outcome[] = [];
  for (const rule of selected) {
    // Re-read for each check: prior runs and allowances live only in Linear.
    const fresh = await readOpenTicket(ctx, ticket.id);
    if (fresh.commentsTruncated)
      throw new Refusal(
        "not every Linear comment could be read; acceptance run counts are incomplete",
        "try again once Linear answers",
      );
    const evidence = acceptancePasses(fresh.comments);
    const runs = evidence.checks.find((c) => c.name === rule.name)?.runs ?? 0;
    const cap = rule.maxRuns + evidence.allowance;
    if (runs >= cap)
      throw new Refusal(
        `acceptance ${JSON.stringify(rule.name)} used ${runs}/${cap} runs; ask the coordinator`,
        `armada ask "Please allow more acceptance runs for ${rule.name}" --ticket ${ticket.id}`,
      );
    const head = pr.headSha;
    await runner.checkHead(head);
    const prefix = `acceptance ${JSON.stringify(rule.name)}`;
    const attempt = `(run ${runs + 1}/${cap})`;
    // A durable start prevents a timeout or session interruption from refunding the attempt.
    const receipt = await reportPhase(ctx, {
      ticket: ticket.id,
      phase: "shipping",
      acceptanceRecord: true,
      message: `${prefix} started on ${head} ${attempt}`,
    });
    outcomes.push(receipt);
    const started = ctx.now().getTime();
    let result: { ok: boolean; output: string };
    try {
      result = await runner.run(rule);
      await runner.checkHead(head);
      const after = await ctx.readPull(reference.number);
      if (after?.headSha !== head)
        result = { ok: false, output: `${result.output}\nPR head changed during acceptance; push and run again.` };
    } catch {
      // Native exceptions can carry environment values; the adapter supplies masked diagnostics.
      result = {
        ok: false,
        output: "Acceptance could not finish, or the checkout changed; restore a clean PR head and run again.",
      };
    }
    const seconds = Math.max(0, Math.floor((ctx.now().getTime() - started) / 1000));
    const duration = `${Math.floor(seconds / 60)}m${seconds % 60}s`;
    const tail = result.output
      .trimEnd()
      .split("\n")
      .slice(-40)
      .map((line) => `> ${line}`)
      .join("\n");
    const message = `${prefix} ${result.ok ? "passed" : "failed"} on ${head} in ${duration} ${attempt} (attempt ${receipt.commentId})${!result.ok && tail ? `\n\n${tail}` : ""}`;
    const outcome = await reportPhase(ctx, { ticket: ticket.id, phase: "shipping", message, acceptanceRecord: true });
    outcome.lines.push(message.split("\n", 1)[0] ?? message);
    outcomes.push(outcome);
    if (!result.ok) return { ok: false, outcomes };
  }
  return { ok: true, outcomes };
}

/** Coordinator allowances apply independently to every declared check on this ticket. */
export async function allowAcceptance(
  ctx: WorkerContext,
  input: { ticket: string; runs: number; reason: string },
): Promise<Outcome> {
  if (ctx.workerSession)
    throw new Refusal("only the coordinator can allow more acceptance runs", "ask the coordinator");
  if (!Number.isSafeInteger(input.runs) || input.runs <= 0 || !input.reason.trim() || /[\r\n]/.test(input.reason))
    throw new Refusal(
      "--runs must be a positive integer and --reason a nonempty single line",
      'armada acceptance allow <ticket> --runs 2 --reason "<why>"',
    );
  const ticket = await readOpenTicket(ctx, input.ticket);
  if (!ticket.agentPhase) throw new Refusal("acceptance allowances need a claimed ticket", "claim the ticket first");
  const phase = ticket.agentPhase;
  const handedBack = phase === "ready-to-merge" ? findHandBack(ticket) : null;
  const pr =
    phase === "ready-to-merge" ? resolvePr(ticket, ctx.config.github.repository, handedBack?.pr?.toString()) : null;
  const summary = `acceptance: ${input.runs} more runs allowed by the coordinator: ${input.reason.trim()}`;
  await ctx.linear.comment(ticket.uuid, `Agent status: ${phase} — ${summary}`);
  const warnings = [...ticket.warnings];
  const recorded = await live(ctx, warnings, "record the acceptance allowance", (fleet) =>
    fleet.report({
      ticket: ticket.id,
      phase,
      previous: phase,
      shippingStage: null,
      summary:
        phase === "ready-to-merge"
          ? `${ticket.comments.find((c) => c.status?.phase === phase && c.status.summary.includes("PR #"))?.status?.summary ?? ""}; ${summary}`
          : summary,
      message: summary,
      prUrl: pr?.url ?? null,
      headSha: handedBack?.sha ?? null,
    }),
  );
  return {
    ticket: ticket.id,
    url: ticket.url,
    lines: [summary],
    warnings,
    inbox: recorded?.inbox ?? null,
    state: ticketState(ticket),
  };
}
