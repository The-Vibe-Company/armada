// `armada merge`: the coordinator merges a handed-back pull request. The
// checklist is pure; GitHub, the local checkout, Linear and the fleet's live
// data (through Armada) are injected, so every rule and every failure path is tested with fakes.
// Order: take the per-project merge lease, check everything, merge pinned to
// the handed-back SHA, read MERGED back, then close the ticket. With --wait the
// pull request is first brought up to date and waited for, without the lease.
import type { ArmadaConfig } from "./config.ts";
import type { CommitShape, Comparison, MergePull } from "./github.ts";
import type { LinearWriter, Ticket } from "./linear-write.ts";
import type { Fleet, Lease, MergeRecorded, RuntimeHandle } from "./live.ts";
import { checkIssues, FULL_SHA } from "./phases.ts";
import { approvalUrl, decidedLine, type MergeApproval, mergeApproval, type Validation } from "./validations.ts";
import { activeClaimComments, firstState, live, others, Refusal, ticketFromBranch } from "./worker.ts";

// ------------------------------------------------------------------ adapters

export interface MergeAttempt {
  ok: boolean;
  /** What GitHub or gh said, for the output. */
  message: string;
  /** A GitHub 5xx or a network failure: the state must be read again before retrying. */
  transient: boolean;
}

/** GitHub as `armada merge` sees it. The CLI implements it with the GraphQL API and `gh`. */
export interface MergeForge {
  readPull(number: number): Promise<MergePull | null>;
  /** Where `head` stands against the branch `base`; null when GitHub cannot compare them. */
  compare(base: string, head: string): Promise<Comparison | null>;
  /** Unified diff of the pull request. */
  diff(number: number): Promise<string>;
  /** Squash-merges only if the head is still `sha`. Never deletes the branch. */
  merge(number: number, sha: string): Promise<MergeAttempt>;
  /** A commit's parents and tree; null when GitHub does not know it. */
  commit(sha: string): Promise<CommitShape | null>;
  /** GitHub's "update branch": merges the base into the head with a merge commit, only if the head is still `sha`. */
  updateBranch(number: number, sha: string): Promise<MergeAttempt>;
  /** The preview deployment of a commit, for the owner to try; null when none (THE-885). */
  preview?(sha: string): Promise<string | null>;
}

export type TestMergeResult = { ok: true } | { ok: false; step: string; output: string };

/** The project's git checkout, for what GitHub cannot answer. */
export interface LocalRepo {
  /** Files of commit `rev` of branch `branch` where each word appears as a whole word. */
  grepWords(o: { branch: string; rev: string; words: string[] }): Promise<Map<string, string[]>>;
  /**
   * Merges `head` into `base` (tip of `branch`) in a throwaway worktree, runs
   * `commands` there one by one, and removes the worktree whatever happens.
   */
  testMerge(o: {
    branch: string;
    base: string;
    head: string;
    number: number;
    commands: string[];
  }): Promise<TestMergeResult>;
  /**
   * The tree of a clean merge of `theirs` into `ours`, both reachable from the
   * pull request's head; null when they conflict.
   */
  mergeTree(o: { branch: string; number: number; ours: string; theirs: string }): Promise<string | null>;
}

/** A ticket in flight, as `armada status` reads it. */
export interface TicketInFlight {
  id: string;
  title: string;
  phase: string;
  runtime: string | null;
}

export interface MergeContext {
  config: ArmadaConfig;
  linear: LinearWriter;
  forge: MergeForge;
  /** Null when git cannot be run: a head behind its base is then refused and hints are skipped. */
  repo: LocalRepo | null;
  /** The fleet's live data, through Armada; null with a warning when this terminal cannot reach it. */
  fleet: () => Promise<{ fleet: Fleet | null; warning: string | null }>;
  /** True when this terminal is signed in to Armada: the merge lock is then required, and Armada being down refuses the merge. */
  lockRequired: boolean;
  /** Tickets in flight in the project (the merged one may be among them). */
  inFlight: () => Promise<TicketInFlight[]>;
  /** Identifies this coordinator in the merge lease. */
  holder: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Progress while the command waits (the lease, GitHub retries, --wait). */
  progress?: (line: string) => void;
  /** True when the repository has the skill `name` installed; only an installed runtime guide is named. */
  installedSkill: (name: string) => Promise<boolean>;
  /** The dashboard's address, for the owner's approval links; null when unknown. */
  appUrl?: string | null;
}

export interface MergeInput {
  pr: number;
  /** Defaults to the ticket named by the pull request's branch. */
  ticket?: string | null;
  /** A pull request no ticket owns (an `armada init` or release pull request): no hand-back, nothing written to Linear. */
  noTicket?: boolean;
  /** Run the checklist only. */
  dryRun?: boolean;
  /** Merge without the merge lock, e.g. while Armada is down; recorded on the ticket. */
  noLock?: boolean;
  /** Bring the head up to date with its base and wait for its checks, up to `timeoutMs`, before merging. */
  wait?: { timeoutMs: number } | null;
  /**
   * The coordinator's judgement of `[policy] merge_approval` (THE-885): why it
   * merges on its own, required when the project has the rule and the owner
   * approved nothing; with `askOwner`, why the owner must see it.
   */
  reason?: string | null;
}

export interface WorkerToTell {
  ticket: string;
  title: string;
  phase: string;
  runtime: string | null;
  /** Runtime session, when the fleet's live data knows it. */
  handle: string | null;
}

export interface MergeOutcome {
  merged: boolean;
  pr: { number: number; url: string; title: string; base: string; headSha: string; mergeCommit: string | null };
  /** Null for a pull request merged with --no-ticket. */
  ticket: { id: string; url: string } | null;
  /** What was checked or done, one line each. */
  lines: string[];
  /** For the coordinator to judge; never blocking. */
  hints: string[];
  /** In-flight workers to tell what landed; empty for a dry run. */
  workers: WorkerToTell[];
  /** False when the workers in flight could not be listed (or for a dry run): `workers` is then not the whole fleet. */
  workersListed: boolean;
  /**
   * The merged worker's session to archive with its runtime guide. `guide` is
   * the installed guide skill, or null when the repository has none for that
   * runtime (a local session or subagent then has nothing to archive).
   */
  archive: { runtime: string | null; handle: string | null; guide: string | null } | null;
  warnings: string[];
}

// ------------------------------------------------------------------ constants

export const MERGE_LEASE = "merge";
/** Long enough for a test merge; a crashed coordinator frees the lock after this. */
export const MERGE_LEASE_TTL_MS = 20 * 60_000;
const LEASE_POLL_MS = 5_000;
/** Waits between merge attempts after a GitHub 5xx. */
const MERGE_BACKOFF_MS = [2_000, 4_000, 8_000];
/** Waits between reads until GitHub shows the pull request as merged. */
const CONFIRM_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];
/** Waits while GitHub computes mergeability (mergeStateStatus UNKNOWN). */
const UNKNOWN_BACKOFF_MS = [2_000, 4_000];
/** Two retries of the fleet clean-up after GitHub confirmed the merge. */
const CLEANUP_BACKOFF_MS = [2_000, 4_000];
/** Default of `armada merge --wait --timeout`. */
export const MERGE_WAIT_DEFAULT_MS = 30 * 60_000;
/** How often `--wait` reads the pull request again. */
export const MERGE_WAIT_POLL_MS = 30_000;
/** How long an update GitHub accepted may take to show as a new head before --wait gives up on it. */
const UPDATE_STALL_MS = 3 * 60_000;
/** With --no-ticket, how long after a push a head with no check at all is still expected to get one. */
export const NO_CHECKS_GRACE_MS = 60_000;
/** Most merge commits of the base an accepted head may stand on above the handed-back SHA. */
const MAX_UPDATES = 20;

// ------------------------------------------------------------------ the checklist (pure)

/** `type(scope)!: subject`, the Commitizen convention the changelog is built from. */
export const COMMITIZEN_TITLE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([\w./,-]+\))?!?: \S/;

export interface HandBack {
  /** PR number the hand-back names, if any. */
  pr: number | null;
  /** SHA as written by the worker (may be short or missing). */
  sha: string | null;
  at: string;
}

/** The newest `Agent status: ready-to-merge — PR #<n>, head <sha>, …` comment of the ticket. */
export function findHandBack(ticket: Ticket): HandBack | null {
  const c = ticket.comments.find((x) => x.status?.phase === "ready-to-merge");
  if (!c?.status) return null;
  const pr = c.status.summary.match(/\bPR #(\d+)/i)?.[1];
  const sha = c.status.summary.match(/\bhead ([0-9a-f]+)\b/i)?.[1];
  return { pr: pr ? Number(pr) : null, sha: sha?.toLowerCase() ?? null, at: c.createdAt };
}

/** States in which GitHub merges the pull request as it is (HAS_HOOKS: mergeable, with pre-receive hooks). */
const MERGEABLE_STATES = new Set(["CLEAN", "HAS_HOOKS"]);

const STATE_HELP: Record<string, string> = {
  BEHIND:
    "the base branch requires it to be up to date; ask the worker to bring the base branch in, or armada merge --wait updates it",
  BLOCKED: "a branch protection rule blocks it (a required review or check)",
  DIRTY: "it conflicts with its base; ask the worker to bring the base branch in and resolve the conflicts",
  DRAFT: "it is a draft",
  UNKNOWN: "GitHub is still computing mergeability; try again in a minute",
  UNSTABLE: "a check that is not required is failing",
};

const stateLine = (pull: MergePull) =>
  `GitHub reports #${pull.number} as ${pull.mergeStateStatus}, not CLEAN${STATE_HELP[pull.mergeStateStatus] ? `: ${STATE_HELP[pull.mergeStateStatus]}` : ""}`;

/**
 * How the head stands on the SHA it must be: the handed-back SHA (or, with
 * --no-ticket, the first head read) with `updates` merge commits that only
 * bring in the base; `why` says what disproved it.
 */
export type Lineage =
  | {
      from: string;
      updates: number;
      why: null;
      /** The commits walked, the head first and `from` last: each is `from` with only the base merged in. */
      chain?: string[];
    }
  | { from: string; updates: null; why: string };

export interface ChecklistInput {
  pull: MergePull;
  /** Null for a pull request merged with --no-ticket. */
  ticket: Ticket | null;
  handBack: HandBack | null;
  requiredChecks: readonly string[];
  /** How the head stands on the handed-back SHA, when it is another commit. */
  lineage?: Lineage | null;
  /** With --no-ticket, a head with no check at all passes once it is older than NO_CHECKS_GRACE_MS. */
  now?: Date;
}

export interface Assessment {
  /** Rules that refuse the merge. */
  problems: string[];
  /** What time settles: checks still running, GitHub still computing. */
  waits: string[];
  /** Said in the output, never blocking. */
  notes: string[];
  /** The head lacks commits of its base (GitHub says BEHIND); the comparison may say so too. */
  behind: boolean;
}

/** Every rule GitHub and Linear can decide on their own, sorted into what refuses and what time may settle. */
export function assess({ pull, ticket, handBack, requiredChecks, lineage, now }: ChecklistInput): Assessment {
  const n = `#${pull.number}`;
  const problems: string[] = [];
  const waits: string[] = [];
  const notes: string[] = [];
  if (ticket) {
    if (ticket.agentPhase !== "ready-to-merge")
      problems.push(
        `${ticket.id} has not been handed back: its agent phase is ${ticket.agentPhase ?? "not set"}, not ready-to-merge`,
      );
    if (!handBack) problems.push(`${ticket.id} has no "Agent status: ready-to-merge" comment carrying the head SHA`);
    else {
      if (handBack.pr !== null && handBack.pr !== pull.number)
        problems.push(`the hand-back on ${ticket.id} names PR #${handBack.pr}, not ${n}`);
      if (!handBack.sha) problems.push(`the hand-back on ${ticket.id} carries no head SHA`);
      else if (!FULL_SHA.test(handBack.sha))
        problems.push(
          `the handed-back SHA ${handBack.sha} is not a full 40-character SHA; ask the worker to report ready-to-merge again`,
        );
      else if (handBack.sha !== pull.headSha && (lineage?.from !== handBack.sha || lineage.why !== null))
        problems.push(
          `the head of ${n} is ${pull.headSha}, not the handed-back ${handBack.sha}: it moved after the hand-back${lineage?.why ? ` and ${lineage.why}` : ""}; ask the worker to report again`,
        );
    }
  } else if (lineage?.why)
    problems.push(
      `the head of ${n} moved from ${lineage.from} to ${pull.headSha} during this merge and ${lineage.why}`,
    );
  if (pull.state !== "open") problems.push(`${n} is ${pull.state}, not open`);
  if (pull.draft) problems.push(`${n} is a draft`);
  if (!COMMITIZEN_TITLE.test(pull.title))
    problems.push(`the title "${pull.title}" is not in Commitizen format, e.g. "feat(cli): add a command"`);

  const checks = checkStates(pull, requiredChecks, !ticket && !lineage?.updates, now);
  problems.push(...checks.failed);
  waits.push(...checks.pending);
  notes.push(...checks.notes);
  const state = pull.mergeStateStatus;
  // A required check not reported yet keeps GitHub's state BLOCKED with nothing running: that is still a wait.
  const running = checks.pending.length > 0 || pull.checks.some((c) => c.state === "pending");
  if (state === "UNKNOWN" || ((state === "BLOCKED" || state === "UNSTABLE") && running)) waits.push(stateLine(pull));
  else if (state === "UNSTABLE" && checks.skipped)
    // What a release pull request with no CI run looks like: nothing that ran failed.
    notes.push(`GitHub reports #${pull.number} as UNSTABLE with no check failing.`);
  else if (!MERGEABLE_STATES.has(state) && state !== "BEHIND") problems.push(stateLine(pull));

  const { total, read, unresolved } = pull.reviewThreads;
  if (unresolved) problems.push(`${n} has ${unresolved} unresolved review thread${unresolved > 1 ? "s" : ""}`);
  else if (total > read) problems.push(`${n} has more than ${read} review threads; check they are resolved by hand`);
  return { problems, waits, notes, behind: state === "BEHIND" };
}

/** Every rule of `assess`, with what time may settle refused too: the checklist of a merge that does not wait. */
export function mergeProblems(input: ChecklistInput): string[] {
  const a = assess(input);
  return [...a.problems, ...a.waits, ...(a.behind ? [stateLine(input.pull)] : [])];
}

/**
 * The checks on the head, as `checkIssues` sorts them. With --no-ticket, a
 * head on which none of the required checks ran, nothing runs and nothing
 * failed passes with a note once GitHub had time to start them: a release pull
 * request opened with the workflow's own token gets no CI run at all. A head
 * this run updated never does: its update starts CI.
 */
function checkStates(pull: MergePull, required: readonly string[], skippable: boolean, now: Date | undefined) {
  const on = `on head ${short(pull.headSha)}: `;
  const failed: string[] = [];
  const pending: string[] = [];
  const notes: string[] = [];
  const ran = required.length ? pull.checks.some((c) => required.includes(c.name)) : pull.checks.length > 0;
  const quiet = pull.checks.every((c) => c.state === "success");
  if (skippable && !ran && quiet) {
    const pushed = pull.updatedAt ? Date.parse(pull.updatedAt) : Number.NaN;
    if (!now || Number.isNaN(pushed) || now.getTime() - pushed >= NO_CHECKS_GRACE_MS) {
      const which = required.length ? `none of ${required.map((r) => `"${r}"`).join(", ")}` : "no CI check";
      notes.push(
        `${which} ran on head ${short(pull.headSha)}; with --no-ticket it passes on GitHub's own state${pull.checks.length ? " and the checks that ran" : ""}, as for a release pull request opened with the workflow's token.`,
      );
      return { failed, pending, notes, skipped: true };
    }
    pending.push(`${on}no check has reported yet, and it was updated less than ${NO_CHECKS_GRACE_MS / 60_000} min ago`);
    return { failed, pending, notes, skipped: false };
  }
  for (const issue of checkIssues(pull.checks, required)) (issue.pending ? pending : failed).push(`${on}${issue.text}`);
  return { failed, pending, notes, skipped: false };
}

/** Problem when the head lacks commits of its base and cannot be test-merged; null when it contains the base. */
export function baseProblem(pull: MergePull, cmp: Comparison | null, localCommands: readonly string[]): string | null {
  if (!cmp) return `GitHub could not compare the head of #${pull.number} with ${pull.baseRef}`;
  if (cmp.behindBy === 0) return null;
  if (!localCommands.length)
    return `the head lacks ${cmp.behindBy} commit${cmp.behindBy > 1 ? "s" : ""} of ${pull.baseRef}; ask the worker to bring ${pull.baseRef} in, or declare [gates] local_commands in armada.toml so armada merge can test the merge (armada merge --wait updates the branch instead)`;
  return null;
}

// ------------------------------------------------------------------ semantic hint (pure)

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs)$/;
const DECLARATIONS = [
  // JavaScript / TypeScript
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/,
  // Python
  /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/,
  // Go
  /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_]\w*)/,
  // Rust
  /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|mod|const|static)\s+([A-Za-z_]\w*)/,
];

function declared(line: string): string | null {
  for (const re of DECLARATIONS) {
    const name = line.match(re)?.[1];
    if (name) return name;
  }
  return null;
}

export interface DiffSymbols {
  /** Top-level declarations the diff removes and does not declare again anywhere, with the file. */
  removed: Map<string, string>;
  /** Every file the diff touches (old and new paths). */
  files: Set<string>;
}

/** Reads a unified diff: symbols it deletes or renames, and the files it touches. */
export function removedSymbols(diff: string): DiffSymbols {
  const removed = new Map<string, string>();
  const added = new Set<string>();
  const files = new Set<string>();
  let file = "";
  for (const line of diff.split("\n")) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header?.[1] && header[2]) {
      files.add(header[1]).add(header[2]);
      file = header[1];
      continue;
    }
    if (!CODE_FILE.test(file) || line.startsWith("---") || line.startsWith("+++")) continue;
    // Top level only: an indented line is a local or a member, too noisy to report.
    const name = line[0] === "-" || line[0] === "+" ? declared(line.slice(1)) : null;
    if (!name || name.length < 3) continue;
    if (line[0] === "-") removed.set(name, file);
    else added.add(name);
  }
  for (const name of added) removed.delete(name);
  return { removed, files };
}

/** One line per removed symbol still used on the base branch outside the files the pull request touches. */
export function semanticHints(symbols: DiffSymbols, uses: Map<string, string[]>, base: string): string[] {
  const hints: string[] = [];
  for (const [name, from] of symbols.removed) {
    const elsewhere = (uses.get(name) ?? []).filter((f) => !symbols.files.has(f));
    if (!elsewhere.length) continue;
    const shown = elsewhere.slice(0, 5).join(", ");
    const more = elsewhere.length > 5 ? ` and ${elsewhere.length - 5} more` : "";
    hints.push(`\`${name}\`, removed from ${from}, still appears on ${base} in ${shown}${more}`);
  }
  return hints;
}

// ------------------------------------------------------------------ lease

export interface LeaseOptions {
  project: string;
  name: string;
  holder: string;
  ttlMs: number;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Give up after waiting this long; defaults to the TTL, after which a crashed holder's lease has expired. */
  maxWaitMs?: number;
  onWait?: (held: Lease | null) => void;
  /** Longest wait for one call to Armada on the lease; a hung server refuses instead of hanging. */
  timeoutMs?: number;
}

const LOCK_CALL_TIMEOUT_MS = 20_000;

/** `p`, or a Refusal once `ms` pass without an answer. */
async function timed<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Refusal(
                `Armada did not answer within ${ms / 1000} s to ${what}; nothing was merged`,
                "the same armada merge again, or with --no-lock if you are sure no other coordinator merges now",
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs `body` while holding a lease of the project, taken through Armada
 * (atomic on its database, with its clock); waits (polling) while another
 * holder has it. `renew` extends the lease and returns false if it was lost.
 */
export async function withLease<T>(
  fleet: Fleet,
  o: LeaseOptions,
  body: (renew: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  const key = { name: o.name, holder: o.holder, ttlMs: o.ttlMs };
  const poll = o.pollMs ?? LEASE_POLL_MS;
  const maxWait = o.maxWaitMs ?? o.ttlMs;
  const lockTimeout = o.timeoutMs ?? LOCK_CALL_TIMEOUT_MS;
  let waited = 0;
  let lastHolder: string | null | undefined;
  for (;;) {
    const got = await timed(fleet.acquireLease(key), lockTimeout, `take the ${o.name} lock`).catch(
      async (err: unknown) => {
        // The write may still land later: give back whatever we might hold.
        await timed(fleet.releaseLease(key), lockTimeout, `release the ${o.name} lock`).catch(() => {});
        throw err instanceof Refusal
          ? err
          : new Refusal(
              `the ${o.name} lock could not be taken (${err instanceof Error ? err.message : String(err)}); nothing was merged`,
              "the same armada merge again, or with --no-lock if you are sure no other coordinator merges now",
            );
      },
    );
    if (got.acquired) break;
    if (waited >= maxWait)
      throw new Refusal(
        `the ${o.name} lock of ${o.project} is still held by ${got.held?.holder ?? "another coordinator"} (until ${got.held?.expiresAt ?? "unknown"})`,
        "the same armada merge again once that coordinator is done",
      );
    if (got.held?.holder !== lastHolder) {
      lastHolder = got.held?.holder ?? null;
      o.onWait?.(got.held);
    }
    await o.sleep(poll);
    waited += poll;
  }
  try {
    return await body(() => timed(fleet.renewLease(key), lockTimeout, `renew the ${o.name} lock`).catch(() => false));
  } finally {
    await timed(fleet.releaseLease(key), lockTimeout, `release the ${o.name} lock`).catch(() => {});
  }
}

// ------------------------------------------------------------------ the command

const say = (ctx: MergeContext, line: string) => ctx.progress?.(line);
const short = (sha: string) => sha.slice(0, 7);
const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;

/** What one `armada merge` remembers between its reads of the pull request. */
interface Run {
  /** With --no-ticket: the head first read, which later heads must stand on with only the base merged in. */
  pin: string | null;
  /** Heads this run asked GitHub to update with the base, with when it asked (ms). */
  updated: Map<string, number>;
  /** Lineages already established, by head SHA. */
  lineages: Map<string, Lineage>;
}

/** Thrown inside the lease with --wait when the pull request needs time again (the base moved): the wait resumes. */
class NotYet extends Error {
  override name = "NotYet";
}

/** Reads the pull request, waiting a little while GitHub still computes its mergeability. */
async function readSettled(ctx: MergeContext, number: number): Promise<MergePull> {
  let pull = await ctx.forge.readPull(number);
  for (const ms of UNKNOWN_BACKOFF_MS) {
    if (pull?.state !== "open" || pull.mergeStateStatus !== "UNKNOWN") break;
    await ctx.sleep(ms);
    pull = await ctx.forge.readPull(number);
  }
  if (!pull)
    throw new Refusal(
      `pull request #${number} was not found in ${ctx.config.github.repository}`,
      "armada status, which lists the pull requests waiting",
    );
  return pull;
}

async function readTicketFor(ctx: MergeContext, pull: MergePull, input: MergeInput): Promise<Ticket | null> {
  const named = pull.headRef ? ticketFromBranch(pull.headRef, ctx.config.tracker.programRoot) : null;
  if (input.noTicket) {
    if (input.ticket) throw new Refusal("--no-ticket and --ticket cannot go together", `armada merge ${pull.number}`);
    // Only an id of the program's team counts: `armada/init-0.2.2` names no ticket, `feature/abc-12-…` does.
    const team = ctx.config.tracker.programRoot.split("-")[0]?.toUpperCase();
    if (named && named.split("-")[0] === team)
      throw new Refusal(
        `the branch of #${pull.number} (${pull.headRef}) names ${named}: merge it on its worker's hand-back, not with --no-ticket`,
        `armada merge ${pull.number}`,
      );
    return null;
  }
  const id = input.ticket?.trim().toUpperCase() || named;
  if (!id)
    throw new Refusal(
      `the branch of #${pull.number} (${pull.headRef ?? "unknown"}) names no ticket`,
      `armada merge ${pull.number} --ticket <id>, or --no-ticket for a pull request no ticket owns (armada init, a release)`,
    );
  const ticket = await ctx.linear.readTicket(id);
  if (!ticket)
    throw new Refusal(
      `ticket ${id} not found in Linear`,
      `armada merge ${pull.number} --ticket <id>, with its ticket, or --no-ticket for a pull request no ticket owns`,
    );
  return ticket;
}

/**
 * Whether `head` is `from` with only the base merged in: each commit between
 * them is a merge whose first parent is the commit before, whose second
 * parent is on the base branch, and whose tree is the clean merge of the two.
 * Then the only change since `from` is the base coming in (GitHub's "update
 * branch", or the same merge made by hand).
 */
async function lineageOf(ctx: MergeContext, pull: MergePull, from: string, run: Run): Promise<Lineage> {
  const known = run.lineages.get(pull.headSha);
  if (known?.from === from) return known;
  const base = pull.baseRef;
  const fail = (why: string): Lineage => ({ from, updates: null, why });
  try {
    const lineage = await (async (): Promise<Lineage> => {
      let sha = pull.headSha;
      const chain: string[] = [];
      for (let updates = 0; ; updates++) {
        chain.push(sha);
        if (sha === from) return { from, updates, why: null, chain };
        if (updates >= MAX_UPDATES) return fail(`more than ${MAX_UPDATES} merge commits stand on it`);
        const commit = await ctx.forge.commit(sha);
        const [first, second] = commit?.parents ?? [];
        if (commit?.parents.length !== 2 || !first || !second)
          return fail(`${short(sha)} is not a merge commit of ${base}`);
        const cmp = await ctx.forge.compare(base, second);
        if (cmp?.status !== "BEHIND" && cmp?.status !== "IDENTICAL")
          return fail(`the merge commit ${short(sha)} brings in ${short(second)}, which is not on ${base}`);
        if (!ctx.repo) return fail(`git is not available to check what the merge commit ${short(sha)} changes`);
        const tree = await ctx.repo.mergeTree({ branch: base, number: pull.number, ours: first, theirs: second });
        if (tree !== commit.tree)
          return fail(`the merge commit ${short(sha)} changes more than a clean merge of ${base}`);
        sha = first;
      }
    })();
    run.lineages.set(pull.headSha, lineage);
    return lineage;
  } catch (err) {
    // Not remembered: the next read tries again.
    return fail(`what it changes could not be checked (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** One read of everything the merge depends on, sorted by `assess`. */
interface Look extends Assessment {
  /**
   * With --wait, the head must be updated on GitHub before it can merge: it is
   * behind, and GitHub requires it up to date or no local command can test the merge.
   */
  mustUpdate: boolean;
  pull: MergePull;
  ticket: Ticket | null;
  cmp: Comparison | null;
  lineage: Lineage | null;
}

async function look(ctx: MergeContext, input: MergeInput, run: Run): Promise<Look> {
  const pull = await readSettled(ctx, input.pr);
  const ticket = await readTicketFor(ctx, pull, input);
  if (!ticket) run.pin ??= pull.headSha;
  const handBack = ticket ? findHandBack(ticket) : null;
  // The SHA the head must stand on: the hand-back, or with --no-ticket the first head read.
  const from = ticket ? (handBack?.sha && FULL_SHA.test(handBack.sha) ? handBack.sha : null) : run.pin;
  let lineage: Lineage | null = null;
  if (from === pull.headSha) lineage = { from, updates: 0, why: null };
  else if (from && pull.state === "open") lineage = await lineageOf(ctx, pull, from, run);
  const cmp = await ctx.forge.compare(pull.baseRef, pull.headSha);
  const a = assess({
    pull,
    ticket,
    handBack,
    requiredChecks: ctx.config.gates.requiredChecks,
    lineage,
    now: ctx.now(),
  });
  const behind = a.behind || (cmp?.behindBy ?? 0) > 0;
  const testable =
    MERGEABLE_STATES.has(pull.mergeStateStatus) && ctx.config.gates.localCommands.length > 0 && ctx.repo !== null;
  return { ...a, behind, mustUpdate: behind && !testable, pull, ticket, cmp, lineage };
}

const label = (pull: MergePull, ticket: Ticket | null) => `#${pull.number}${ticket ? ` (${ticket.id})` : ""}`;

/** Said in every refusal after this run updated the branch: the worker's copy is now behind. */
function updatedNote(run: Run, pull: MergePull): string {
  if (!run.updated.size) return "";
  return `\nThis run updated the branch of #${pull.number} with ${pull.baseRef} (head now ${pull.headSha}): whoever pushes to it next pulls first.`;
}

function refuse(ctx: MergeContext, run: Run, l: Look, problems: string[], hints: string[] = []) {
  const { pull, ticket } = l;
  const n = pull.number;
  return new Refusal(
    `${label(pull, ticket)} cannot be merged:\n${problems.map((p) => `  - ${p}`).join("\n")}${
      hints.length ? `\nHints (not blocking):\n${hints.map((h) => `  - ${h}`).join("\n")}` : ""
    }${updatedNote(run, pull)}`,
    pull.state !== "open"
      ? `gh pr view ${n} --repo ${ctx.config.github.repository}`
      : !ticket
        ? `gh pr checks ${n} --repo ${ctx.config.github.repository}; armada merge ${n} --no-ticket once it is fixed`
        : ticket.agentPhase !== "ready-to-merge"
          ? ctx.lockRequired
            ? `armada inbox --wait, until ${ticket.id} is handed back`
            : `armada status, until ${ticket.id} shows ready-to-merge`
          : `armada answer --note ${ticket.id} "<what to fix>", once you told its worker; merge again after its next hand-back`,
  );
}

interface Checked {
  pull: MergePull;
  ticket: Ticket | null;
  sha: string;
  /** The handed-back SHA when the head is that SHA with the base merged in; null when they are the same. */
  updatedFrom: string | null;
  /** Tip of the base branch the checklist compared the head with. */
  baseSha: string | null;
  lines: string[];
  hints: string[];
  warnings: string[];
  /** How the merge was decided (THE-885), for the ticket and the dashboard; null with --no-ticket. */
  decided?: string | null;
  /** The commits the head stands for: itself, and those it is with only the base merged in. */
  chain?: string[];
}

/** Every checklist rule, the base-branch rule (with a test merge when allowed) and the hints. */
async function checklist(ctx: MergeContext, input: MergeInput, run: Run): Promise<Checked> {
  const { config } = ctx;
  const l = await look(ctx, input, run);
  const { pull, ticket, cmp } = l;
  const warnings = [...(ticket?.warnings ?? [])];
  const lines: string[] = [];
  const problems = [...l.problems];
  if (input.wait && !input.dryRun) {
    // Whatever time settles goes back to the wait, out of the lease.
    if (!problems.length && (l.waits.length || l.mustUpdate))
      throw new NotYet(l.mustUpdate ? `${pull.baseRef} moved` : (l.waits[0] ?? "not ready"));
  } else problems.push(...l.waits, ...(l.pull.mergeStateStatus === "BEHIND" ? [stateLine(pull)] : []));

  const behind = baseProblem(pull, cmp, config.gates.localCommands);
  if (behind) problems.push(behind);
  else if (cmp && cmp.behindBy > 0) {
    if (!ctx.repo)
      problems.push(`the head lacks commits of ${pull.baseRef} and git is not available to test the merge`);
    else if (!problems.length) {
      say(
        ctx,
        `The head lacks ${cmp.behindBy} commit(s) of ${pull.baseRef}; testing the merge in a throwaway worktree…`,
      );
      const test = await ctx.repo.testMerge({
        branch: pull.baseRef,
        base: cmp.baseSha,
        head: pull.headSha,
        number: pull.number,
        commands: config.gates.localCommands,
      });
      if (test.ok)
        lines.push(
          `Head lacks ${cmp.behindBy} commit(s) of ${pull.baseRef}; the test merge passed every local command.`,
        );
      else problems.push(`the test merge into ${pull.baseRef} failed at \`${test.step}\`:\n${indent(test.output)}`);
    }
  }

  const hints = await hintsFor(ctx, pull, cmp, warnings);
  if (problems.length) throw refuse(ctx, run, l, problems, hints);
  const updates = l.lineage?.updates ?? 0;
  const updatedFrom = updates && l.lineage ? l.lineage.from : null;
  const head = ticket
    ? updatedFrom
      ? `handed back at ${updatedFrom}, now ${pull.headSha} with only ${pull.baseRef} merged in (${plural(updates, "merge commit")})`
      : `handed back at ${pull.headSha}`
    : updatedFrom
      ? `head ${pull.headSha}, which is ${updatedFrom} with only ${pull.baseRef} merged in`
      : `head ${pull.headSha}`;
  lines.unshift(
    `Checklist passed for ${label(pull, ticket)}: ${head}, ${pull.mergeStateStatus}, checks green, no open review thread.`,
    ...l.notes,
  );
  const chain = [pull.headSha, ...(l.lineage?.why === null ? (l.lineage.chain ?? [l.lineage.from]) : [])];
  return { pull, ticket, sha: pull.headSha, updatedFrom, baseSha: cmp?.baseSha ?? null, lines, hints, warnings, chain };
}

const indent = (text: string) =>
  text
    .trimEnd()
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");

async function hintsFor(ctx: MergeContext, pull: MergePull, cmp: Comparison | null, warnings: string[]) {
  try {
    const symbols = removedSymbols(await ctx.forge.diff(pull.number));
    if (!symbols.removed.size) return [];
    if (!ctx.repo || !cmp) {
      warnings.push(
        `semantic hint skipped: ${ctx.repo ? `GitHub could not compare the head with ${pull.baseRef}` : "git is not available to search the base branch"}`,
      );
      return [];
    }
    const uses = await ctx.repo.grepWords({
      branch: pull.baseRef,
      rev: cmp.baseSha,
      words: [...symbols.removed.keys()],
    });
    return semanticHints(symbols, uses, pull.baseRef);
  } catch (err) {
    warnings.push(`semantic hint skipped: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * The last look before merging, since the checklist may have taken minutes
 * (a test merge): the same rules on a fresh read, the same head and the same base tip.
 */
async function recheck(ctx: MergeContext, input: MergeInput, run: Run, c: Checked): Promise<void> {
  const l = await look(ctx, input, run);
  const { pull } = l;
  const moved: string[] = [];
  if (pull.headSha !== c.sha) moved.push(`the head of #${pull.number} moved to ${pull.headSha} while it was checked`);
  else if (l.cmp?.baseSha !== c.baseSha)
    moved.push(`${pull.baseRef} moved to ${l.cmp?.baseSha ?? "an unknown commit"} while #${pull.number} was checked`);
  if (input.wait && !l.problems.length && (moved.length || l.waits.length))
    throw new NotYet(moved[0] ?? l.waits[0] ?? "not ready");
  const problems = [...l.problems, ...l.waits, ...moved];
  if (problems.length)
    throw new Refusal(
      `#${pull.number} changed while it was checked; nothing was merged:\n${problems.map((p) => `  - ${p}`).join("\n")}${updatedNote(run, pull)}`,
      `armada merge ${pull.number} again`,
    );
}

/**
 * How this merge is decided (THE-885). A pull request the owner was asked
 * about merges only once they approved that exact head (or that head with only
 * the base merged in); otherwise, with `[policy] merge_approval`, the
 * coordinator says why it merges on its own (`--reason`). A dry run only says
 * where it stands.
 */
async function ownerDecision(
  ctx: MergeContext,
  input: MergeInput,
  c: Checked,
  dryRun: boolean,
): Promise<{ lines: string[]; decided: string | null }> {
  const n = c.pull.number;
  // The rule judges a ticket's merge; a pull request no ticket owns (a release) is still held by an approval asked for it.
  const rule = c.ticket ? (ctx.config.policy.mergeApproval ?? null) : null;
  const reason = input.reason?.replace(/\s+/g, " ").trim() || null;
  const lines = rule ? [`Merge rule (armada.toml [policy] merge_approval): "${rule}"`] : [];
  let approval: MergeApproval = { state: "none" };
  let unreadable: string | null = null;
  const { fleet, warning } = await ctx.fleet();
  try {
    if (fleet) approval = mergeApproval(await fleet.validations({ pr: n }), n, { sha: c.sha, sameAs: c.chain ?? [] });
    else unreadable = warning ?? "not signed in to Armada";
  } catch (err) {
    unreadable = err instanceof Error ? err.message : String(err);
  }
  const link = (v: Validation) => approvalUrl(ctx.appUrl ?? null, v.id);
  const judge = `armada merge ${n} --reason "<why it may merge on its own>", or armada merge ${n} --ask-owner --reason "<why the owner must see it>"`;
  let problem: string | null = null;
  let next = "";
  let decided: string | null = null;
  if (unreadable && rule) {
    // An approval the owner gave or refused cannot be checked: never merge past it.
    problem = `the owner's approvals of #${n} could not be read (${unreadable})`;
    next = `armada merge ${n} again once Armada answers`;
  } else if (approval.state === "approved") decided = decidedLine(approval.decision);
  else if (approval.state === "pending") {
    problem = `the owner has not decided on the merge of #${n} yet (asked ${approval.validation.createdAt}): ${link(approval.validation)}`;
    next = "armada inbox --wait: the owner's decision arrives there";
  } else if (approval.state === "changes") {
    const d = approval.validation.decision;
    problem = `the owner requested changes on #${n}${d?.note ? `: ${d.note}` : ""}`;
    next = c.ticket
      ? `armada answer --note ${c.ticket.id} "<the owner's changes>", once you told its worker; then armada merge ${n} --ask-owner again on its next hand-back`
      : `armada merge ${n} --ask-owner --reason "<why>" once the changes are made`;
  } else if (approval.state === "stale") {
    problem = `the owner approved #${n} at ${approval.validation.pr?.headSha}, but its head is now ${c.sha}: a new head needs a new approval`;
    next = `armada merge ${n} --ask-owner --reason "<why the owner must see it>"`;
  } else if (rule && !reason) {
    problem = `the merge rule asks you to judge #${n}: look at its files and what users will see, and record why`;
    next = judge;
  } else if (c.ticket)
    decided = rule
      ? `merged on its own (rule: ${rule})${reason ? `: ${reason}` : ""}`
      : `merged on its own (no merge rule)${reason ? `: ${reason}` : ""}`;
  // Signed out with no rule, nothing could have been asked from here: no warning.
  if (unreadable && !rule && fleet)
    c.warnings.push(
      `the owner's approvals of #${n} could not be read (${unreadable}); none is required without a merge rule`,
    );
  if (problem) {
    if (dryRun) return { lines: [...lines, `Not mergeable yet: ${problem}`, `Next: ${next}`], decided: null };
    throw new Refusal(`#${n}${c.ticket ? ` (${c.ticket.id})` : ""} cannot be merged: ${problem}`, next);
  }
  return { lines: decided ? [...lines, `Decided: ${decided}.`] : lines, decided };
}

/**
 * Asks the owner to approve a merge (THE-885, `armada merge <pr> --ask-owner
 * --reason`): records the pull request as GitHub shows it now (title, files,
 * CI, the preview of its head) for the owner's Validations page, posts the
 * approval link on the ticket and merges nothing. `armada merge` then waits
 * for the owner's approval of that exact head.
 */
export async function askOwnerToMerge(
  ctx: MergeContext,
  input: { pr: number; ticket?: string | null; reason: string },
): Promise<MergeOutcome> {
  const reason = input.reason.replace(/\s+/g, " ").trim();
  if (!reason)
    throw new Refusal(
      "say why the owner must see this merge",
      `armada merge ${input.pr} --ask-owner --reason "<what in it the owner checks>"`,
    );
  const { fleet, warning } = await ctx.fleet();
  if (!fleet)
    throw new Refusal(
      `asking the owner needs Armada (${warning ?? "not signed in"}); nothing was asked`,
      "armada login, then the same command again",
    );
  const pull = await readSettled(ctx, input.pr);
  if (pull.state !== "open")
    throw new Refusal(`#${pull.number} is ${pull.state}: there is nothing to approve`, `gh pr view ${pull.number}`);
  const ticket = await readTicketFor(ctx, pull, { pr: input.pr, ticket: input.ticket ?? null });
  if (!ticket)
    throw new Refusal(`#${pull.number} names no ticket`, `armada merge ${pull.number} --ticket <id> --ask-owner`);
  const warnings = [...ticket.warnings];
  let preview: string | null = null;
  try {
    preview = (await ctx.forge.preview?.(pull.headSha)) ?? null;
  } catch (err) {
    warnings.push(`no preview link: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { url } = await fleet.validate({
    ticket: ticket.id,
    kind: "merge",
    what: pull.title || `Pull request #${pull.number}`,
    reason,
    choices: null,
    pr: {
      number: pull.number,
      url: pull.url,
      title: pull.title,
      headSha: pull.headSha,
      files: pull.files ?? null,
      additions: pull.additions ?? null,
      deletions: pull.deletions ?? null,
      ci: pull.ci ?? null,
      preview,
    },
    attachments: [],
  });
  await ctx.linear.comment(
    ticket.uuid,
    `Owner approval asked for the merge of PR #${pull.number} at ${pull.headSha}: ${reason}\n\n${url}`,
  );
  const rule = ctx.config.policy.mergeApproval;
  return {
    merged: false,
    pr: {
      number: pull.number,
      url: pull.url,
      title: pull.title,
      base: pull.baseRef,
      headSha: pull.headSha,
      mergeCommit: null,
    },
    ticket: { id: ticket.id, url: ticket.url },
    lines: [
      ...(rule ? [`Merge rule (armada.toml [policy] merge_approval): "${rule}"`] : []),
      `Asked the owner to approve the merge of #${pull.number} at ${pull.headSha}${preview ? ` (preview ${preview})` : ""}: ${reason}`,
      `Approval link, posted on ${ticket.id}: ${url}`,
      `The owner's decision arrives in your inbox; once approved, armada merge ${pull.number}. A new head needs a new approval.`,
    ],
    hints: [],
    workers: [],
    workersListed: false,
    archive: null,
    warnings,
  };
}

/** Merges pinned to `sha`, retrying GitHub 5xx after re-reading the state; then reads MERGED back. */
async function mergePinned(ctx: MergeContext, pull: MergePull, sha: string, ticket: string | null): Promise<MergePull> {
  const n = `#${pull.number}`;
  const closeByHand = ticket ? `; if it merged, close ${ticket} by hand` : "";
  let readError = "";
  // A failed read is not an answer: the merge may have landed, so it is said, never hidden.
  const read = () => {
    readError = "";
    return ctx.forge.readPull(pull.number).catch((err: unknown) => {
      readError = err instanceof Error ? err.message : String(err);
      return null;
    });
  };
  for (let attempt = 0; ; attempt++) {
    const res = await ctx.forge.merge(pull.number, sha);
    if (res.ok) break;
    // Whatever the error, GitHub may have merged anyway: read the state first.
    const fresh = await read();
    if (fresh?.state === "merged") break;
    const view = `gh pr view ${pull.number} --repo ${ctx.config.github.repository}`;
    if (!fresh)
      throw new Refusal(
        `GitHub failed (${res.message}) and ${n} could not be read back (${readError || "not found"})${closeByHand}`,
        view,
      );
    if (!res.transient)
      throw new Refusal(`GitHub refused to merge ${n}: ${res.message}`, `armada merge ${pull.number} --dry-run`);
    if (fresh.state !== "open")
      throw new Refusal(`GitHub failed (${res.message}) and ${n} is now ${fresh.state}; not retrying`, view);
    if (fresh.headSha !== sha)
      throw new Refusal(
        `GitHub failed (${res.message}) and the head of ${n} moved to ${fresh.headSha}; not retrying`,
        `armada merge ${pull.number} --dry-run, once its worker hands back the new head`,
      );
    const wait = MERGE_BACKOFF_MS[attempt];
    if (wait === undefined)
      throw new Refusal(
        `GitHub kept failing (${res.message}) after ${attempt + 1} attempts; ${n} is still open and nothing was merged`,
        `armada merge ${pull.number} again once GitHub answers`,
      );
    say(ctx, `GitHub answered ${res.message}; ${n} is still open at ${short(sha)}, retrying in ${wait / 1000} s…`);
    await ctx.sleep(wait);
  }
  // Success is what GitHub shows, not what the merge call said.
  let seen: MergePull | null = null;
  for (let i = 0; ; i++) {
    seen = await read();
    if (seen?.state === "merged") break;
    const wait = CONFIRM_BACKOFF_MS[i];
    if (wait === undefined)
      throw new Refusal(
        seen
          ? `the merge of ${n} was accepted but GitHub shows it as ${seen.state}, not merged (auto-merge or a merge queue?)${ticket ? "; the ticket was left as is" : ""}`
          : `the merge of ${n} was accepted but GitHub could not be read back (${readError || "not found"})${closeByHand}`,
        `gh pr view ${pull.number} --repo ${ctx.config.github.repository}`,
      );
    await ctx.sleep(wait);
  }
  if (seen.headSha !== sha)
    throw new Refusal(
      `${n} was merged at ${seen.headSha}, not at the ${ticket ? "handed-back" : "checked"} ${sha}; check ${pull.baseRef} now`,
      `gh pr view ${pull.number} --repo ${ctx.config.github.repository}`,
    );
  return seen;
}

/** Name the runtime guide skill of a runtime label would have, e.g. Conductor → armada-runtime-conductor. */
export const runtimeGuide = (runtime: string | null) =>
  runtime
    ? `armada-runtime-${runtime
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}`
    : null;

/** Closes the ticket in Linear: Done, agent labels removed, PR linked, merged status posted. */
async function closeTicket(ctx: MergeContext, ticket: Ticket, merged: MergePull, c: Checked, unlocked: boolean) {
  const groups = ctx.config.tracker.labels;
  const done = ticket.statusType === "completed" ? null : firstState(ticket.states, "completed");
  await ctx.linear.updateTicket(ticket.uuid, {
    ...(done ? { stateId: done.id } : {}),
    removeLabelIds: [
      ...others(ticket, groups.phaseGroup, null),
      ...others(ticket, groups.runtimeGroup, null),
      ...ticket.labels.filter((label) => label.name === ctx.config.tracker.readyLabel).map((label) => label.id),
    ],
  });
  if (!ticket.prs.some((p) => p.url === merged.url))
    await ctx.linear.linkUrl(ticket.uuid, merged.url, merged.title || `Pull request #${merged.number}`);
  await ctx.linear.comment(
    ticket.uuid,
    `Agent status: merged — PR #${merged.number} squash-merged into ${merged.baseRef} as ${merged.mergeCommit ?? "unknown"}, head ${merged.headSha}${
      c.updatedFrom ? `, the handed-back ${c.updatedFrom} updated with ${merged.baseRef}` : ""
    }${unlocked ? ", merged without lock (--no-lock)" : ""}${c.decided ? `; ${c.decided}` : ""}`,
  );
  return [
    `${ticket.id}: ${done ? `moved to ${done.name}` : "state unchanged"}, agent and ready labels removed, merged status posted.`,
  ];
}

/**
 * With --wait, until the pull request can be merged as it is: a head behind its
 * base is updated on GitHub (a merge commit, no force-push), running checks
 * are waited for. Anything else refuses at once. Holds no lock.
 */
async function waitUntilReady(ctx: MergeContext, input: MergeInput, run: Run, deadline: number): Promise<void> {
  const minutes = Math.round((input.wait?.timeoutMs ?? 0) / 60_000);
  let shown = "";
  for (;;) {
    const l = await look(ctx, input, run);
    const { pull } = l;
    const n = `#${pull.number}`;
    if (l.problems.length) throw refuse(ctx, run, l, l.problems);
    let reason: string;
    const asked = run.updated.get(pull.headSha);
    if (l.mustUpdate) {
      if (pull.mergeable === "CONFLICTING")
        throw refuse(ctx, run, l, [`${n} conflicts with ${pull.baseRef}; ask the worker to merge it in or rebase`]);
      if (pull.mergeable !== "MERGEABLE")
        reason = `GitHub is still computing whether ${n} merges cleanly with ${pull.baseRef}`;
      else if (asked !== undefined) {
        if (ctx.now().getTime() - asked >= UPDATE_STALL_MS)
          throw refuse(ctx, run, l, [
            `GitHub accepted to update the branch of ${n} with ${pull.baseRef}, but its head is still ${pull.headSha} after ${UPDATE_STALL_MS / 60_000} min; update it on GitHub, or ask the worker to merge ${pull.baseRef} in`,
          ]);
        reason = `GitHub is updating the branch of ${n} with ${pull.baseRef}`;
      } else {
        const res = await ctx.forge.updateBranch(pull.number, pull.headSha);
        const fresh = res.ok ? null : await ctx.forge.readPull(pull.number).catch(() => null);
        if (res.ok) {
          run.updated.set(pull.headSha, ctx.now().getTime());
          say(ctx, `Updated the branch of ${n} with ${pull.baseRef} (a merge commit on ${short(pull.headSha)}).`);
          reason = `the checks on the updated head of ${n}`;
        } else if (res.transient || (fresh && fresh.headSha !== pull.headSha))
          reason = `GitHub could not update the branch of ${n} yet (${res.message})`;
        else
          throw refuse(ctx, run, l, [
            `GitHub refused to update the branch of ${n} with ${pull.baseRef}: ${res.message}. A branch protection rule or ruleset can forbid it (signed commits, restricted pushes); ask the worker to merge ${pull.baseRef} in or rebase`,
          ]);
      }
    } else if (l.waits.length) reason = l.waits.join("; ");
    else return;
    if (reason !== shown) say(ctx, `Waiting: ${reason}…`);
    shown = reason;
    if (ctx.now().getTime() >= deadline)
      throw new Refusal(
        `${label(pull, l.ticket)} is still not ready after ${minutes} min: ${reason}; nothing was merged${updatedNote(run, pull)}`,
        `armada merge ${pull.number} --wait again${input.noTicket ? " --no-ticket" : ""}, or armada merge ${pull.number} --dry-run to see the checklist`,
      );
    await ctx.sleep(MERGE_WAIT_POLL_MS);
  }
}

/**
 * Merges a handed-back pull request: lease, checklist, merge pinned to the
 * handed-back SHA, MERGED read back, ticket closed, workers to tell listed.
 * Any refused rule throws `Refusal` naming every failure; nothing is written.
 * With --wait, the head is first brought up to date and its checks waited
 * for, out of the lease, and the lease is given back whenever it needs time again.
 */
export async function mergePullRequest(ctx: MergeContext, input: MergeInput): Promise<MergeOutcome> {
  const run: Run = { pin: null, updated: new Map(), lineages: new Map() };
  if (input.dryRun) {
    const c = await checklist(ctx, input, run);
    const owner = await ownerDecision(ctx, input, c, true);
    return outcome(c, false, null, [...c.lines, ...owner.lines, "Dry run: nothing was merged."], [], null);
  }
  if (!input.wait) return locked(ctx, input, run);
  // Before touching the branch or waiting: a merge that will need the lock and cannot have it is refused now.
  if (!input.noLock && ctx.lockRequired) {
    const { fleet, warning } = await ctx.fleet();
    if (!fleet) throw lockUnavailable(ctx, input, warning);
  }
  const deadline = ctx.now().getTime() + input.wait.timeoutMs;
  for (;;) {
    await waitUntilReady(ctx, input, run, deadline);
    try {
      return await locked(ctx, input, run);
    } catch (err) {
      if (!(err instanceof NotYet)) throw err;
      say(ctx, `Not ready under the merge lock (${err.message}); lock given back, waiting again…`);
    }
  }
}

const lockUnavailable = (ctx: MergeContext, input: MergeInput, warning: string | null) =>
  new Refusal(
    `the merge lock needs Armada, which is unavailable (${warning ?? "no answer"}); nothing was merged`,
    `armada merge ${input.pr} again once Armada answers, or armada merge ${input.pr} --no-lock if you are sure no other coordinator merges in ${ctx.config.project.slug} now`,
  );

/** The merge itself, under the project's merge lease. */
async function locked(ctx: MergeContext, input: MergeInput, run: Run): Promise<MergeOutcome> {
  const { config } = ctx;
  const slug = config.project.slug;
  const early: string[] = [];
  const body = async (renew: () => Promise<boolean>) => {
    const c = await checklist(ctx, input, run);
    c.warnings.unshift(...early);
    const owner = await ownerDecision(ctx, input, c, false);
    c.lines.push(...owner.lines);
    c.decided = owner.decided;
    const handBacks = c.ticket
      ? await live(ctx, c.warnings, "read the hand-back for merge recovery", (fleet) =>
          fleet.ticketItems(c.ticket?.id ?? ""),
        )
      : null;
    const handBackId = handBacks?.find((item) => item.kind === "hand-back")?.id ?? null;
    await recheck(ctx, input, run, c);
    if (!(await renew()))
      throw new Refusal(
        "the merge lock could not be renewed (it expired and another coordinator took it, or Armada did not answer); nothing was merged",
        `armada merge ${input.pr} again`,
      );
    say(ctx, `Merging #${c.pull.number} at ${c.sha}…`);
    const merged = await mergePinned(ctx, c.pull, c.sha, c.ticket?.id ?? null);
    const lines = [
      ...c.lines,
      `Merged #${merged.number} into ${merged.baseRef} as ${merged.mergeCommit ?? "unknown"} (head ${merged.headSha}).`,
    ];
    if (c.ticket)
      try {
        lines.push(...(await closeTicket(ctx, c.ticket, merged, c, !!input.noLock)));
      } catch (err) {
        throw new Error(
          `#${merged.number} is merged, but Linear could not be updated (${err instanceof Error ? err.message : String(err)}); close ${c.ticket.id} by hand: Done, agent and ready labels removed, pull request linked`,
        );
      }
    else lines.push("No ticket: nothing was written to Linear.");
    return after(ctx, c, merged, lines, handBackId);
  };
  if (input.noLock) {
    early.push(`merged without the merge lock (--no-lock): make sure no other coordinator merges in ${slug} now`);
    return body(async () => true);
  }
  const { fleet, warning } = await ctx.fleet();
  if (!fleet && ctx.lockRequired) throw lockUnavailable(ctx, input, warning);
  if (!fleet) {
    early.push(
      `${warning ?? "not signed in to Armada"}; the merge lock was not taken, so make sure no other coordinator merges in ${slug} now`,
    );
    return body(async () => true);
  }
  return withLease(
    fleet,
    {
      project: slug,
      name: MERGE_LEASE,
      holder: ctx.holder,
      ttlMs: MERGE_LEASE_TTL_MS,
      sleep: ctx.sleep,
      onWait: (held) =>
        say(
          ctx,
          `Waiting for the merge lock held by ${held?.holder ?? "another coordinator"} (until ${held?.expiresAt ?? "?"})…`,
        ),
    },
    body,
  );
}

/** The fleet's bookkeeping and the list of workers to tell, after the ticket is closed. */
async function after(
  ctx: MergeContext,
  c: Checked,
  merged: MergePull,
  lines: string[],
  handBackId: number | null,
): Promise<MergeOutcome> {
  const ticket = c.ticket;
  let live$: MergeRecorded | null = null;
  if (ticket) {
    for (let attempt = 0; ; attempt++) {
      live$ = await live(ctx, c.warnings, "record the merge", (fleet) =>
        fleet.merge({
          ticket: ticket.id,
          number: merged.number,
          url: merged.url,
          mergeCommit: merged.mergeCommit,
          headSha: merged.headSha,
          decision: c.decided ?? null,
        }),
      );
      if (live$) break;
      if (!(await ctx.fleet()).fleet) {
        if (ctx.lockRequired) lines.push(`Next: armada answer ${handBackId ?? "<hand-back id>"} "resolved: PR merged"`);
        break;
      }
      const wait = CLEANUP_BACKOFF_MS[attempt];
      if (wait === undefined) {
        lines.push(`Next: armada answer ${handBackId ?? "<hand-back id>"} "resolved: PR merged"`);
        break;
      }
      say(ctx, `#${merged.number} is merged; retrying Armada clean-up in ${wait / 1000} s…`);
      await ctx.sleep(wait);
    }
  }
  if (live$?.resolved) lines.push(`Hand-back resolved in the coordinator's inbox.`);

  let workers: WorkerToTell[] = [];
  let listed = false;
  try {
    const handles = new Map<string, RuntimeHandle>((live$?.open ?? []).map((h) => [h.ticket, h]));
    workers = (await ctx.inFlight())
      .filter((t) => t.id !== ticket?.id)
      .map((t) => ({
        ticket: t.id,
        title: t.title,
        phase: t.phase,
        runtime: t.runtime ?? handles.get(t.id)?.runtime ?? null,
        handle: handles.get(t.id)?.handle ?? null,
      }));
    listed = true;
  } catch (err) {
    c.warnings.push(
      `could not list the workers in flight (${err instanceof Error ? err.message : String(err)}); run armada status`,
    );
  }
  if (!ticket) return { ...outcome(c, true, merged, lines, workers, null), workersListed: listed };

  const claim = activeClaimComments(ticket.comments)[0]?.claim;
  const runtime = live$?.handle?.runtime ?? ticket.agentRuntime ?? claim?.runtime ?? null;
  const expected = runtimeGuide(runtime);
  let guide: string | null = null;
  try {
    guide = expected && (await ctx.installedSkill(expected)) ? expected : null;
  } catch (err) {
    c.warnings.push(`could not look for the ${expected} skill (${err instanceof Error ? err.message : String(err)})`);
  }
  const archive = { runtime, handle: live$?.handle?.handle ?? claim?.session ?? null, guide };
  return { ...outcome(c, true, merged, lines, workers, archive), workersListed: listed };
}

function outcome(
  c: Checked,
  merged: boolean,
  pr: MergePull | null,
  lines: string[],
  workers: WorkerToTell[],
  archive: MergeOutcome["archive"],
): MergeOutcome {
  const p = pr ?? c.pull;
  return {
    merged,
    pr: {
      number: p.number,
      url: p.url,
      title: p.title,
      base: p.baseRef,
      headSha: p.headSha,
      mergeCommit: pr?.mergeCommit ?? null,
    },
    ticket: c.ticket ? { id: c.ticket.id, url: c.ticket.url } : null,
    lines,
    hints: c.hints,
    workers,
    workersListed: false,
    archive,
    warnings: c.warnings,
  };
}
