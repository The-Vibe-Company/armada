// What a worker does to the tracker: claim a ticket, report a phase, release
// it. Linear is written first and is the record; Turso gets the live detail
// afterwards, and any Turso failure becomes a warning, never a failure.
import type { ArmadaConfig } from "./config.ts";
import { parsePullRequestUrl, sameName } from "./linear.ts";
import type { LinearWriter, Ticket, TicketLabel, WorkflowState } from "./linear-write.ts";
import { handBackProblems, transitionProblem } from "./phases.ts";
import {
  type Db,
  ensureProject,
  type InboxItem,
  openInboxItems,
  putHandBack,
  recordEvent,
  redact,
  releaseRuntimeHandle,
  saveRuntimeHandle,
} from "./turso.ts";
import type { Comment, LabelPhase, PullRequest } from "./types.ts";

/** The command was understood but the tracker state forbids it (exit code 1). */
export class Refusal extends Error {
  override name = "Refusal";
}

export interface WorkerContext {
  config: ArmadaConfig;
  linear: LinearWriter;
  /**
   * Opens Turso, called only once Linear has been written. `db` is null when
   * Turso is not configured or could not be opened; `warning` then says why.
   */
  turso: () => Promise<{ db: Db | null; warning: string | null }>;
  /** Reads one pull request of the project repository; null without a GitHub token. */
  readPull: ((number: number) => Promise<PullRequest | null>) | null;
  now: () => Date;
}

export interface Outcome {
  ticket: string;
  url: string;
  /** What was done, one line each. */
  lines: string[];
  warnings: string[];
  /** Unresolved inbox items addressed to this ticket's worker, when Turso was read. */
  inbox: InboxItem[] | null;
}

const TURSO_TIMEOUT_MS = 10_000;

/** Runs a Turso step; a failure or a timeout becomes a warning. */
export async function live<T>(
  ctx: Pick<WorkerContext, "turso">,
  warnings: string[],
  what: string,
  step: (db: Db) => Promise<T>,
) {
  const { db, warning } = await ctx.turso();
  if (!db) {
    if (warning) warnings.push(warning);
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      step(db),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${TURSO_TIMEOUT_MS / 1000} s`)), TURSO_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    warnings.push(`Turso: could not ${what} (${redact(err)}); Linear is up to date`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const projectOf = (config: ArmadaConfig) => ({
  slug: config.project.slug,
  name: config.project.name,
  repository: config.github.repository,
  programRoot: config.tracker.programRoot,
});

async function readOpenTicket(ctx: WorkerContext, id: string): Promise<Ticket> {
  const ticket = await ctx.linear.readTicket(id);
  if (!ticket) throw new Refusal(`ticket ${id} not found in Linear`);
  if (ticket.statusType === "completed" || ticket.statusType === "canceled")
    throw new Refusal(`${ticket.id} is ${ticket.statusType}; there is nothing to work on`);
  return ticket;
}

const ID = /(?:^|[^a-z0-9])([a-z][a-z0-9]*-\d+)(?=$|[^a-z0-9])/gi;

/** The ticket a branch names, e.g. `feature/abc-12-add-login` → ABC-12, preferring the program's team key. */
export function ticketFromBranch(branch: string, programRoot: string): string | null {
  const ids = [...branch.matchAll(ID)].map((m) => (m[1] ?? "").toUpperCase());
  const team = programRoot.split("-")[0]?.toUpperCase();
  return ids.find((id) => id.split("-")[0] === team) ?? ids[0] ?? null;
}

/** Comments that carry a claim since the last release, oldest first. */
export function activeClaimComments(comments: Comment[]): Comment[] {
  const asc = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  let active: Comment[] = [];
  for (const c of asc) {
    if (c.status?.phase === "released") active = [];
    if (c.claim) active.push(c);
  }
  return active;
}

/** The label of `group` whose name matches `name`, ignoring case, spaces and dashes. */
function findLabel(labels: TicketLabel[], name: string, group: string): TicketLabel {
  const found = labels.find((l) => sameName(l.name, name));
  if (found) return found;
  const names = labels.map((l) => l.name).join(", ") || "none";
  throw new Refusal(`no "${name}" label in the "${group}" label group (available: ${names})`);
}

/** Labels of `group` on the ticket other than `keep`. */
export const others = (ticket: Ticket, group: string, keep: string | null) =>
  ticket.labels.filter((l) => l.group === group && l.id !== keep).map((l) => l.id);

export const firstState = (states: WorkflowState[], ...types: WorkflowState["type"][]) => {
  for (const type of types) {
    const s = states.find((x) => x.type === type);
    if (s) return s;
  }
  return null;
};

function claimLine(o: { runtime: string; handle: string; branch: string | null; started: string }) {
  return `Agent claim — runtime: ${o.runtime} · session: ${o.handle} · branch: ${o.branch ?? "unknown"} · started: ${o.started}`;
}

// ------------------------------------------------------------------ claim

export interface ClaimInput {
  ticket: string;
  /** Runtime name, matched against the runtime label group (e.g. conductor → Conductor). */
  runtime: string;
  /** Runtime-specific session handle, e.g. <workspace>/<session>. */
  handle: string;
  /** Defaults to the branch name Linear suggests for the ticket. */
  branch?: string | null;
}

/**
 * Claims a ticket for one worker. Refuses a ticket another worker holds; when
 * two claims race, the older comment wins and the loser removes its own.
 * Claiming again with the same handle resumes (repairs labels and state).
 */
export async function claimTicket(ctx: WorkerContext, input: ClaimInput): Promise<Outcome> {
  const { config, linear } = ctx;
  const groups = config.tracker.labels;
  const ticket = await readOpenTicket(ctx, input.ticket);
  const [phaseLabels, runtimeLabels] = await Promise.all([
    linear.groupLabels(groups.phaseGroup, ticket.teamId),
    linear.groupLabels(groups.runtimeGroup, ticket.teamId),
  ]);
  const planning = findLabel(phaseLabels, "planning", groups.phaseGroup);
  const runtime = findLabel(runtimeLabels, input.runtime, groups.runtimeGroup);
  const branch = input.branch ?? ticket.branchName;
  const warnings = [...ticket.warnings];
  const lines: string[] = [];

  if (ticket.commentsTruncated)
    throw new Refusal(
      `${ticket.id} has more comments than Armada reads, so an older claim may be hidden; claim it by hand`,
    );
  const viewer = await linear.viewer();
  const inProgress = ticket.statusType === "started" ? null : firstState(ticket.states, "started");

  const held = activeClaimComments(ticket.comments);
  const holder = held[0]?.claim;
  const resuming = !!holder && holder.session === input.handle;
  if (!resuming) {
    if (holder)
      throw new Refusal(
        `${ticket.id} is already claimed by ${holder.runtime ?? "an unknown runtime"} · ${holder.session ?? "unknown session"} since ${holder.at}; release it first with \`armada release\``,
      );
    if (ticket.agentPhase)
      throw new Refusal(
        `${ticket.id} already carries the agent phase "${ticket.agentPhase}"; release it first with \`armada release\``,
      );
    const started = ctx.now().toISOString();
    const body = `Agent status: planning — claimed by ${runtime.name} (${input.handle})\n\n${claimLine({ runtime: runtime.name, handle: input.handle, branch, started })}`;
    const mine = await linear.comment(ticket.uuid, body);
    // Linear has no compare-and-swap: read back and let the oldest claim win.
    const after = await linear.readTicket(ticket.id);
    const winner = after ? activeClaimComments(after.comments)[0] : undefined;
    if (winner && winner.id !== mine.id) {
      await linear.deleteComment(mine.id);
      throw new Refusal(
        `${ticket.id} was claimed first by ${winner.claim?.runtime ?? "another worker"} · ${winner.claim?.session ?? "unknown session"}; your claim was withdrawn`,
      );
    }
    lines.push(`Claimed ${ticket.id} for ${runtime.name} (${input.handle}).`);
  } else {
    lines.push(`${ticket.id} is already claimed by this session (${input.handle}); labels and state repaired.`);
  }

  if (ticket.statusType !== "started" && !inProgress)
    warnings.push(`the team of ${ticket.id} has no started state; the ticket was not moved`);
  // On resume the phase label may already have moved on: keep it.
  const phaseLabel = resuming && ticket.agentPhase ? null : planning;
  await linear.updateTicket(ticket.uuid, {
    ...(inProgress ? { stateId: inProgress.id } : {}),
    ...(ticket.assigneeId !== viewer.id ? { assigneeId: viewer.id } : {}),
    addLabelIds: [phaseLabel, runtime]
      .filter((l): l is TicketLabel => !!l && !ticket.labels.some((x) => x.id === l.id))
      .map((l) => l.id),
    removeLabelIds: [
      ...(phaseLabel ? others(ticket, groups.phaseGroup, phaseLabel.id) : []),
      ...others(ticket, groups.runtimeGroup, runtime.id),
    ],
  });
  lines.push(
    `${inProgress ? `Moved to ${inProgress.name}` : "State unchanged"}, assigned to ${viewer.name}, labels ${phaseLabel?.name ?? ticket.agentPhase} and ${runtime.name}.`,
  );

  const at = ctx.now();
  await live(ctx, warnings, "record the claim", async (db) => {
    await ensureProject(db, projectOf(config), at);
    await saveRuntimeHandle(db, {
      project: config.project.slug,
      ticket: ticket.id,
      runtime: runtime.name,
      handle: input.handle,
      branch,
      at,
    });
    await recordEvent(db, {
      project: config.project.slug,
      ticket: ticket.id,
      kind: "claim",
      phase: phaseLabel ? "planning" : ticket.agentPhase,
      runtime: runtime.name,
      handle: input.handle,
      at,
    });
  });
  return { ticket: ticket.id, url: ticket.url, lines, warnings, inbox: null };
}

// ------------------------------------------------------------------ report

export interface ReportInput {
  ticket: string;
  phase: LabelPhase;
  /** First line becomes the status summary; the rest is the comment body. Optional only for ready-to-merge. */
  message?: string | null;
  /** Pull request number or URL; defaults to the newest one linked to the ticket. */
  pr?: string | null;
  /** Full head SHA; required for ready-to-merge. */
  sha?: string | null;
}

/** Resolves --pr (number or URL) against the project repository and the ticket's links. */
export function resolvePr(ticket: Ticket, repository: string, pr: string | null | undefined): PullRequest | null {
  if (pr) {
    const trimmed = pr.trim().replace(/^#/, "");
    if (/^\d+$/.test(trimmed)) {
      const url = `https://github.com/${repository}/pull/${trimmed}`;
      return parsePullRequestUrl(url);
    }
    const parsed = parsePullRequestUrl(trimmed);
    if (!parsed) throw new Refusal(`--pr must be a pull request number or URL, got "${pr}"`);
    return parsed;
  }
  const inRepo = ticket.prs.filter((p) => p.repo.toLowerCase() === repository.toLowerCase());
  return [...inRepo].sort((a, b) => b.number - a.number)[0] ?? null;
}

/**
 * Reports a phase: validates the transition (and the hand-back gate for
 * ready-to-merge), swaps the phase label, posts the `Agent status:` comment
 * and records the event. Returns the inbox items waiting for the worker.
 */
export async function reportPhase(ctx: WorkerContext, input: ReportInput): Promise<Outcome> {
  const { config, linear } = ctx;
  const groups = config.tracker.labels;
  const ticket = await readOpenTicket(ctx, input.ticket);
  const problem = transitionProblem(ticket.agentPhase, input.phase);
  if (problem) throw new Refusal(`${ticket.id}: ${problem}`);
  const warnings = [...ticket.warnings];
  const message = input.message?.trim() ?? "";
  let pr = resolvePr(ticket, config.github.repository, input.pr);
  const sha = input.sha?.trim().toLowerCase() || null;

  let summary: string;
  let body: string;
  if (input.phase === "ready-to-merge") {
    const inRepo = !!pr && pr.repo.toLowerCase() === config.github.repository.toLowerCase();
    if (inRepo && !ctx.readPull)
      throw new Refusal(
        "a hand-back needs GitHub to check the pull request head and CI; set GITHUB_TOKEN or run `gh auth login`",
      );
    if (pr && inRepo && ctx.readPull) {
      const fresh = await ctx.readPull(pr.number);
      if (!fresh) throw new Refusal(`pull request #${pr.number} was not found in ${config.github.repository}`);
      pr = fresh;
    }
    const problems = handBackProblems({
      pr,
      repository: config.github.repository,
      sha,
      requiredChecks: config.gates.requiredChecks,
    });
    if (problems.length)
      throw new Refusal(`${ticket.id}: hand-back refused:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    summary = `PR #${pr?.number}, head ${sha}, CI green`;
    body = message;
  } else {
    if (!message) throw new Refusal("--message is required: say what you did or what you are doing");
    const [first = "", ...rest] = message.split("\n");
    summary = first.trim();
    body = rest.join("\n").trim();
  }

  // Every lookup that can refuse happens before the first write.
  const target =
    ticket.agentPhase === input.phase
      ? null
      : findLabel(await linear.groupLabels(groups.phaseGroup, ticket.teamId), input.phase, groups.phaseGroup);
  if (pr && input.pr && !ticket.prs.some((p) => p.url === pr?.url)) {
    await linear.linkUrl(ticket.uuid, pr.url, pr.title || `Pull request #${pr.number}`);
  }
  if (target) {
    await linear.updateTicket(ticket.uuid, {
      addLabelIds: [target.id],
      removeLabelIds: others(ticket, groups.phaseGroup, target.id),
    });
  }
  const statusLine = `Agent status: ${input.phase} — ${summary}`;
  await linear.comment(ticket.uuid, body ? `${statusLine}\n\n${body}` : statusLine);
  const lines = [
    ticket.agentPhase === input.phase
      ? `Status update posted on ${ticket.id} (${input.phase}).`
      : `${ticket.id}: ${ticket.agentPhase} → ${input.phase}.`,
  ];

  const at = ctx.now();
  const inbox = await live(ctx, warnings, "record the report", async (db) => {
    await ensureProject(db, projectOf(config), at);
    await recordEvent(db, {
      project: config.project.slug,
      ticket: ticket.id,
      kind: "report",
      phase: input.phase,
      message: summary,
      prUrl: pr?.url ?? null,
      headSha: sha,
      at,
    });
    if (input.phase === "ready-to-merge")
      await putHandBack(db, {
        project: config.project.slug,
        ticket: ticket.id,
        author: null,
        body: statusLine,
        at,
      });
    return openInboxItems(db, { project: config.project.slug, recipient: "worker", ticket: ticket.id });
  });
  return { ticket: ticket.id, url: ticket.url, lines, warnings, inbox };
}

// ------------------------------------------------------------------ release

/** Gives a ticket back: agent labels removed, ticket moved back to not started, `released` status posted. */
export async function releaseTicket(ctx: WorkerContext, input: { ticket: string; reason: string }): Promise<Outcome> {
  const { config, linear } = ctx;
  const groups = config.tracker.labels;
  const ticket = await readOpenTicket(ctx, input.ticket);
  if (!ticket.agentPhase && !ticket.agentRuntime && !activeClaimComments(ticket.comments).length)
    throw new Refusal(`${ticket.id} is not claimed; there is nothing to release`);
  const warnings = [...ticket.warnings];
  const back = ticket.statusType === "started" ? firstState(ticket.states, "unstarted", "backlog") : null;
  await linear.updateTicket(ticket.uuid, {
    ...(back ? { stateId: back.id } : {}),
    removeLabelIds: [...others(ticket, groups.phaseGroup, null), ...others(ticket, groups.runtimeGroup, null)],
  });
  await linear.comment(ticket.uuid, `Agent status: released — ${input.reason.trim()}`);
  const lines = [`Released ${ticket.id}${back ? `, moved back to ${back.name}` : ""}.`];
  const at = ctx.now();
  await live(ctx, warnings, "record the release", async (db) => {
    await ensureProject(db, projectOf(config), at);
    await releaseRuntimeHandle(db, config.project.slug, ticket.id, at);
    await recordEvent(db, {
      project: config.project.slug,
      ticket: ticket.id,
      kind: "release",
      message: input.reason.trim(),
      at,
    });
  });
  return { ticket: ticket.id, url: ticket.url, lines, warnings, inbox: null };
}
