// What a worker does to the tracker: claim a ticket, report a phase, release
// it. Linear is written first and is the record; the fleet's live data gets
// the detail afterwards, through Armada, and any failure there becomes a
// warning, never a failure.
import { ArmadaApiError } from "./armada-api.ts";
import type { ArmadaConfig } from "./config.ts";
import { herdrChoice } from "./herdr-profile.ts";
import { parsePullRequestUrl, sameName } from "./linear.ts";
import type { LinearWriter, Ticket, TicketLabel, WorkflowState } from "./linear-write.ts";
import type { Fleet, InboxItem } from "./live.ts";
import { handBackProblems, transitionProblem } from "./phases.ts";
import { chooseProfile, type ProfileChoice, ProfileError } from "./routing.ts";
import type { Comment, LabelPhase, PullRequest } from "./types.ts";
import { type ValidationChoice, validationClaimLine } from "./validations.ts";

/**
 * The command was understood but the tracker state forbids it (exit code 1).
 * `next` is the one command to run next, printed after the reason.
 */
export class Refusal extends Error {
  override name = "Refusal";
  constructor(
    message: string,
    readonly next: string,
  ) {
    super(message);
  }
}

export interface WorkerContext {
  config: ArmadaConfig;
  linear: LinearWriter;
  /**
   * The fleet's live data, asked for only once Linear has been written.
   * `fleet` is null when this terminal cannot reach it (not signed in to
   * Armada); `warning` then says why.
   */
  fleet: () => Promise<{ fleet: Fleet | null; warning: string | null }>;
  /** Reads one pull request of the project repository; null without a GitHub token. */
  readPull: ((number: number) => Promise<PullRequest | null>) | null;
  now: () => Date;
}

/** Where a ticket stands, as read back from Linear after a command wrote it. */
export interface TicketState {
  /** Workflow state name, e.g. In Progress. */
  status: string;
  phase: LabelPhase | null;
  runtime: string | null;
  /** Profile of the active claim, or null when it names none. */
  profile: string | null;
}

export interface Outcome {
  ticket: string;
  url: string;
  /** What was done, one line each. */
  lines: string[];
  warnings: string[];
  /** Unresolved inbox items addressed to this ticket's worker, when the fleet was read. */
  inbox: InboxItem[] | null;
  /** The ticket read back after the write (claim and report); null when it was not read. */
  state?: TicketState | null;
}

const LIVE_TIMEOUT_MS = 20_000;

/** Runs a step on the fleet's live data; a failure or a timeout becomes a warning. */
export async function live<T>(
  ctx: Pick<WorkerContext, "fleet">,
  warnings: string[],
  what: string,
  step: (fleet: Fleet) => Promise<T>,
) {
  const { fleet, warning } = await ctx.fleet();
  if (!fleet) {
    if (warning && !warnings.includes(warning)) warnings.push(warning);
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      step(fleet),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${LIVE_TIMEOUT_MS / 1000} s`)), LIVE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    // An outdated CLI says so once, whatever it tried.
    const warning =
      err instanceof ArmadaApiError && err.upgrade
        ? err.message
        : `Armada: could not ${what} (${err instanceof Error ? err.message : String(err)}); Linear is up to date`;
    if (!warnings.includes(warning)) warnings.push(warning);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The project as armada.toml describes it: every call to the fleet names it. */
export const projectOf = (config: ArmadaConfig) => ({
  slug: config.project.slug,
  name: config.project.name,
  repository: config.github.repository,
  programRoot: config.tracker.programRoot,
});

export async function readOpenTicket(ctx: WorkerContext, id: string): Promise<Ticket> {
  const ticket = await ctx.linear.readTicket(id);
  if (!ticket)
    throw new Refusal(`ticket ${id} not found in Linear`, "armada status, to see the tickets of the program");
  if (ticket.statusType === "completed" || ticket.statusType === "canceled")
    throw new Refusal(
      `${ticket.id} is ${ticket.statusType}; there is nothing to work on`,
      "armada status, to pick a ticket ready to start",
    );
  return ticket;
}

const ID = /(?:^|[^a-z0-9])([a-z][a-z0-9]*-\d+)(?=$|[^a-z0-9])/gi;

/** The ticket a branch names, e.g. `feature/abc-12-add-login` → ABC-12, preferring the program's team key. */
export function ticketFromBranch(branch: string, programRoot: string): string | null {
  const ids = [...branch.matchAll(ID)].map((m) => (m[1] ?? "").toUpperCase());
  const team = programRoot.split("-")[0]?.toUpperCase();
  return ids.find((id) => id.split("-")[0] === team) ?? ids[0] ?? null;
}

/** The state a worker sees on its ticket: workflow state, agent labels and the claim's profile. */
export function ticketState(ticket: Ticket): TicketState {
  return {
    status: ticket.states.find((s) => s.id === ticket.stateId)?.name ?? ticket.statusType,
    phase: ticket.agentPhase,
    runtime: ticket.agentRuntime,
    profile: activeClaimComments(ticket.comments)[0]?.claim?.profile ?? null,
  };
}

/** Reads the ticket back after a write; a failed read only warns, the write is done. */
async function readBack(ctx: WorkerContext, id: string, warnings: string[]): Promise<TicketState | null> {
  try {
    const t = await ctx.linear.readTicket(id);
    if (t) return ticketState(t);
    warnings.push(`${id} could not be read back from Linear; the change was written`);
  } catch (err) {
    warnings.push(
      `${id} could not be read back from Linear (${err instanceof Error ? err.message : String(err)}); the change was written`,
    );
  }
  return null;
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

const DOCTOR_LABELS = "armada doctor, which lists the missing labels (armada init creates them)";

/** The label of `group` whose name matches `name`, ignoring case, spaces and dashes. */
function findLabel(labels: TicketLabel[], name: string, group: string, next = DOCTOR_LABELS): TicketLabel {
  const found = labels.find((l) => sameName(l.name, name));
  if (found) return found;
  const names = labels.map((l) => l.name).join(", ") || "none";
  throw new Refusal(`no "${name}" label in the "${group}" label group (available: ${names})`, next);
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

/** The profile as the live data records it: the runtime is the claim's own. */
function liveProfile({ name, profile, routed, reason, why }: ProfileChoice) {
  const { runtime: _, ...settings } = profile;
  return { name, ...settings, routed, reason, why };
}

function claimLine(o: {
  runtime: string;
  handle: string;
  branch: string | null;
  started: string;
  profile: ProfileChoice | null;
}) {
  const line = `Agent claim — runtime: ${o.runtime} · session: ${o.handle} · branch: ${o.branch ?? "unknown"} · started: ${o.started}`;
  const p = o.profile;
  if (!p) return line;
  const settings = `agent ${p.profile.agent}, model ${p.profile.model}, effort ${p.profile.effort}${p.profile.fastMode ? ", fast mode" : ""}`;
  const why = p.why.startsWith("Chosen by the coordinator:") ? p.why : `chosen by ${p.why}`;
  return `${line} · profile: ${p.name}\nProfile: ${p.name} (${settings}), ${why}${p.reason ? `\nProfile reason: ${p.reason}` : ""}`;
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
  /** Conductor profile the worker runs on; recorded in the claim. */
  profile?: string | null;
  /** Why the coordinator chose or overrode the profile; required for semantic choices and routing overrides. */
  reason?: string | null;
  /** The `[[policy.validation]]` rules the coordinator judged apply (THE-885), recorded in the claim. */
  validation?: ValidationChoice | null;
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
  const runtime = findLabel(
    runtimeLabels,
    input.runtime,
    groups.runtimeGroup,
    runtimeLabels.length
      ? `armada claim ${ticket.id} --runtime "<one of: ${runtimeLabels.map((l) => l.name).join(", ")}>" --handle ${input.handle}`
      : DOCTOR_LABELS,
  );
  const branch = input.branch ?? ticket.branchName;
  const warnings = [...ticket.warnings];
  const lines: string[] = [];
  let profile: ProfileChoice | null = null;

  if (ticket.commentsTruncated || ticket.labelsTruncated)
    throw new Refusal(
      `not every ${ticket.commentsTruncated ? "comment" : "label"} of ${ticket.id} could be read, so ${ticket.commentsTruncated ? "an older claim" : "an agent label"} may be hidden; nothing was written`,
      `armada claim ${ticket.id} --runtime "${input.runtime}" --handle "${input.handle}" again once Linear answers`,
    );
  const viewer = await linear.viewer();
  const inProgress = ticket.statusType === "started" ? null : firstState(ticket.states, "started");

  const held = activeClaimComments(ticket.comments);
  const holder = held[0]?.claim;
  const resuming = !!holder && holder.session === input.handle;
  if (!resuming) {
    // Only the coordinator releases another worker's ticket: this worker picks another one.
    const another = "armada status, to pick another ticket ready to start";
    if (holder)
      throw new Refusal(
        `${ticket.id} is already claimed by ${holder.runtime ?? "an unknown runtime"} · ${holder.session ?? "unknown session"} since ${holder.at}`,
        another,
      );
    if (ticket.agentPhase)
      throw new Refusal(`${ticket.id} already carries the agent phase "${ticket.agentPhase}"`, another);
    if (input.profile)
      try {
        const selection = {
          ticket: ticket.id,
          labels: ticket.labels.map((l) => l.name),
          requested: input.profile,
          reason: input.reason ?? null,
        };
        const local = input.runtime.toLowerCase() === "herdr";
        const choice = local ? chooseProfile(config, selection, "herdr") : null;
        profile = local ? (choice ? herdrChoice(choice) : null) : chooseProfile(config, selection);
      } catch (err) {
        if (err instanceof ProfileError)
          throw new Refusal(err.message, `armada brief ${ticket.id}, which shows the profile the ticket routes to`);
        throw err;
      }
    const started = ctx.now().toISOString();
    const validation = validationClaimLine(input.validation ?? null);
    const body = `Agent status: planning — claimed by ${runtime.name} (${input.handle})\n\n${claimLine({ runtime: runtime.name, handle: input.handle, branch, started, profile })}${validation ? `\n${validation}` : ""}`;
    const mine = await linear.comment(ticket.uuid, body);
    // Linear has no compare-and-swap: read back and let the oldest claim win.
    const after = await linear.readTicket(ticket.id);
    const winner = after ? activeClaimComments(after.comments)[0] : undefined;
    if (winner && winner.id !== mine.id) {
      await linear.deleteComment(mine.id);
      throw new Refusal(
        `${ticket.id} was claimed first by ${winner.claim?.runtime ?? "another worker"} · ${winner.claim?.session ?? "unknown session"}; your claim was withdrawn`,
        "armada status, to pick another ticket ready to start",
      );
    }
    lines.push(
      `Claimed ${ticket.id} for ${runtime.name} (${input.handle})${profile ? ` on profile ${profile.name}${profile.profile.runtime === "herdr" ? ` (${profile.profile.agent})` : ""}` : ""}.`,
    );
  } else {
    lines.push(`${ticket.id} is already claimed by this session (${input.handle}); labels and state repaired.`);
    // The claim keeps the profile it was made with, even if the labels changed since.
    if (input.profile && (holder?.profile ?? null) !== input.profile)
      warnings.push(
        `the claim keeps ${holder?.profile ? `profile ${holder.profile}` : "no profile"}, not ${input.profile}; release and claim again to change it`,
      );
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

  // The launch the owner asked for from the dashboard is done: the claim resolves it.
  const launched = await live(ctx, warnings, "record the claim", (fleet) =>
    fleet.claim({
      ticket: ticket.id,
      runtime: runtime.name,
      handle: input.handle,
      branch,
      phase: phaseLabel ? "planning" : ticket.agentPhase,
      resuming,
      profile: profile ? liveProfile(profile) : null,
    }),
  );
  if (launched?.length) {
    const who = [...new Set(launched.map((r) => r.author ?? "the owner"))].join(", ");
    const ids = launched.map((r) => `#${r.id}`).join(", ");
    await linear.comment(
      ticket.uuid,
      `Agent status: planning — launched as ${who} asked from the dashboard (request ${ids})`,
    );
    lines.push(`Launch request ${ids} from ${who} resolved.`);
  }
  const state = await readBack(ctx, ticket.id, warnings);
  return { ticket: ticket.id, url: ticket.url, lines, warnings, inbox: null, state };
}

// ------------------------------------------------------------------ report

export interface ReportInput {
  ticket: string;
  phase: LabelPhase;
  /** First line becomes the status summary; the rest is the comment body. Optional for ready-to-merge and with a plan. */
  message?: string | null;
  /** The plan, posted as its own block under the status line; without a message, its first line is the summary. */
  plan?: string | null;
  /** Pull request number or URL; defaults to the newest one linked to the ticket. */
  pr?: string | null;
  /** Full head SHA; required for ready-to-merge. */
  sha?: string | null;
  /** ship-pr-dev, or fallback: <reason>. Optional for older workers. */
  shippedWith?: string | null;
}

/** The heading of the plan block in a status comment, which `armada status` and the dashboard look for. */
export const PLAN_HEADING = "## Plan";
const SUMMARY_MAX = 100;

/** A one-line summary of a plan: its first line that says something, without Markdown markers, cut at 100 characters. */
export function planSummary(plan: string): string {
  const lines = plan
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*(?:#+|>|[-*+]|\d+[.)])\s*/, "")
        .replace(/[*_`]/g, "")
        .trim(),
    )
    .filter((l) => l && !/^plan\s*:?$/i.test(l));
  const first = lines[0] ?? "plan posted";
  return first.length > SUMMARY_MAX ? `${first.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : first;
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
    if (!parsed)
      throw new Refusal(
        `--pr must be a pull request number or URL, got "${pr}"`,
        `armada report <phase> --ticket ${ticket.id} --pr <number>`,
      );
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
  if (problem)
    throw new Refusal(
      `${ticket.id}: ${problem}`,
      ticket.agentPhase
        ? `armada report <one of the phases above> --ticket ${ticket.id} --message "<what you did>"`
        : `armada claim ${ticket.id} --runtime <name> --handle <id>`,
    );
  const warnings = [...ticket.warnings];
  const message = input.message?.trim() ?? "";
  const plan = input.plan?.trim() ?? "";
  let pr = resolvePr(ticket, config.github.repository, input.pr);
  const sha = input.sha?.trim().toLowerCase() || null;

  const shippedWith = input.shippedWith?.trim();
  if (
    input.shippedWith != null &&
    (input.phase !== "ready-to-merge" ||
      /[\r\n]/.test(input.shippedWith) ||
      !(shippedWith === "ship-pr-dev" || /^fallback: \S.*$/.test(shippedWith ?? "")))
  )
    throw new Refusal(
      "--shipped-with is for ready-to-merge: use ship-pr-dev or fallback: <nonempty reason>, on one line",
      'armada report ready-to-merge --pr <number> --sha <full sha> --shipped-with "ship-pr-dev"',
    );
  const shippingPath =
    shippedWith === "ship-pr-dev"
      ? "shipped with ship-pr-dev"
      : shippedWith
        ? `shipped with the ${shippedWith}`
        : "shipping path unreported";

  let summary: string;
  let body: string;
  if (input.phase === "ready-to-merge") {
    const inRepo = !!pr && pr.repo.toLowerCase() === config.github.repository.toLowerCase();
    if (inRepo && !ctx.readPull)
      throw new Refusal(
        "a hand-back needs GitHub to check the pull request head and CI; set GITHUB_TOKEN",
        "gh auth login, then report again",
      );
    if (pr && inRepo && ctx.readPull) {
      const fresh = await ctx.readPull(pr.number);
      if (!fresh)
        throw new Refusal(
          `pull request #${pr.number} was not found in ${config.github.repository}`,
          `armada report ready-to-merge --ticket ${ticket.id} --pr <number> --sha <head sha>, with the pull request of this ticket`,
        );
      pr = fresh;
    }
    const problems = handBackProblems({
      pr,
      repository: config.github.repository,
      sha,
      requiredChecks: config.gates.requiredChecks,
    });
    if (problems.length)
      throw new Refusal(
        `${ticket.id}: hand-back refused:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
        `fix the points above, then armada report ready-to-merge --ticket ${ticket.id} --pr ${pr?.number ?? "<number>"} --sha <head sha>; report shipping meanwhile if the work is not done`,
      );
    summary = `PR #${pr?.number}, head ${sha}, CI green; ${shippingPath}`;
    body = message;
  } else {
    if (!message && !plan)
      throw new Refusal(
        "--message is required: say what you did or what you are doing",
        `armada report ${input.phase} --ticket ${ticket.id} --message "<what you did>"`,
      );
    const [first = "", ...rest] = message.split("\n");
    summary = message ? first.trim() : planSummary(plan);
    body = rest.join("\n").trim();
  }
  if (plan) body = [body, `${PLAN_HEADING}\n\n${plan}`].filter(Boolean).join("\n\n");

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

  const inbox = await live(ctx, warnings, "record the report", (fleet) =>
    fleet.report({
      ticket: ticket.id,
      phase: input.phase,
      previous: ticket.agentPhase,
      summary,
      // The whole report: an awaiting-approval plan reaches the coordinator's inbox in full.
      message: plan ? [summary, body].join("\n\n") : message,
      prUrl: pr?.url ?? null,
      headSha: sha,
    }),
  );
  const state = await readBack(ctx, ticket.id, warnings);
  return { ticket: ticket.id, url: ticket.url, lines, warnings, inbox, state };
}

// ------------------------------------------------------------------ release

/** Gives a ticket back: agent labels removed, ticket moved back to not started, `released` status posted. */
export async function releaseTicket(ctx: WorkerContext, input: { ticket: string; reason: string }): Promise<Outcome> {
  const { config, linear } = ctx;
  const groups = config.tracker.labels;
  const ticket = await readOpenTicket(ctx, input.ticket);
  if (!ticket.agentPhase && !ticket.agentRuntime && !activeClaimComments(ticket.comments).length)
    throw new Refusal(
      `${ticket.id} is not claimed; there is nothing to release`,
      "armada status, to see which tickets are in flight",
    );
  const warnings = [...ticket.warnings];
  const back = ticket.statusType === "started" ? firstState(ticket.states, "unstarted", "backlog") : null;
  await linear.updateTicket(ticket.uuid, {
    ...(back ? { stateId: back.id } : {}),
    removeLabelIds: [...others(ticket, groups.phaseGroup, null), ...others(ticket, groups.runtimeGroup, null)],
  });
  await linear.comment(ticket.uuid, `Agent status: released — ${input.reason.trim()}`);
  const lines = [`Released ${ticket.id}${back ? `, moved back to ${back.name}` : ""}.`];
  await live(ctx, warnings, "record the release", (fleet) =>
    fleet.release({ ticket: ticket.id, reason: input.reason.trim() }),
  );
  return { ticket: ticket.id, url: ticket.url, lines, warnings, inbox: null };
}
