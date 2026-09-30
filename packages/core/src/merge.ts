// `armada merge`: the coordinator merges a handed-back pull request. The
// checklist is pure; GitHub, the local checkout, Linear and Turso are
// injected, so every rule and every failure path is tested with fakes.
// Order: take the per-project merge lease, check everything, merge pinned to
// the handed-back SHA, read MERGED back, then close the ticket.
import type { ArmadaConfig } from "./config.ts";
import type { Comparison, MergePull } from "./github.ts";
import type { LinearWriter, Ticket } from "./linear-write.ts";
import { checkProblems, FULL_SHA } from "./phases.ts";
import {
  acquireLease,
  type Db,
  ensureProject,
  getRuntimeHandle,
  type Lease,
  openRuntimeHandles,
  type RuntimeHandle,
  recordEvent,
  releaseLease,
  releaseRuntimeHandle,
  renewLease,
  resolveInboxItems,
} from "./turso.ts";
import { activeClaimComments, firstState, live, others, projectOf, Refusal, ticketFromBranch } from "./worker.ts";

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
  turso: () => Promise<{ db: Db | null; warning: string | null }>;
  /** True when a Turso URL is set: the merge lock is then required, and Turso being down refuses the merge. */
  tursoConfigured: boolean;
  /** Tickets in flight in the project (the merged one may be among them). */
  inFlight: () => Promise<TicketInFlight[]>;
  /** Identifies this coordinator in the merge lease. */
  holder: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Progress while the command waits (the lease, GitHub retries). */
  progress?: (line: string) => void;
  /** True when the repository has the skill `name` installed; only an installed runtime guide is named. */
  installedSkill: (name: string) => Promise<boolean>;
}

export interface MergeInput {
  pr: number;
  /** Defaults to the ticket named by the pull request's branch. */
  ticket?: string | null;
  /** Run the checklist only. */
  dryRun?: boolean;
  /** Merge without the merge lock, e.g. while Turso is down; recorded on the ticket. */
  noLock?: boolean;
}

export interface WorkerToTell {
  ticket: string;
  title: string;
  phase: string;
  runtime: string | null;
  /** Runtime session, when Turso knows it. */
  handle: string | null;
}

export interface MergeOutcome {
  merged: boolean;
  pr: { number: number; url: string; title: string; base: string; headSha: string; mergeCommit: string | null };
  ticket: { id: string; url: string };
  /** What was checked or done, one line each. */
  lines: string[];
  /** For the coordinator to judge; never blocking. */
  hints: string[];
  /** In-flight workers to tell what landed; empty for a dry run. */
  workers: WorkerToTell[];
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

const STATE_HELP: Record<string, string> = {
  BEHIND: "the base branch requires it to be up to date; ask the worker to rebase",
  BLOCKED: "a branch protection rule blocks it (a required review or check)",
  DIRTY: "it conflicts with its base; ask the worker to rebase",
  DRAFT: "it is a draft",
  HAS_HOOKS: "GitHub reports pre-receive hooks; merge it by hand",
  UNKNOWN: "GitHub is still computing mergeability; try again in a minute",
  UNSTABLE: "a check that is not required is failing",
};

export interface ChecklistInput {
  pull: MergePull;
  ticket: Ticket;
  handBack: HandBack | null;
  requiredChecks: readonly string[];
}

/** Every rule GitHub and Linear can decide on their own; each failure is named. */
export function mergeProblems({ pull, ticket, handBack, requiredChecks }: ChecklistInput): string[] {
  const n = `#${pull.number}`;
  const problems: string[] = [];
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
    else if (handBack.sha !== pull.headSha)
      problems.push(
        `the head of ${n} is ${pull.headSha}, not the handed-back ${handBack.sha}: it moved after the hand-back; ask the worker to report again`,
      );
  }
  if (pull.state !== "open") problems.push(`${n} is ${pull.state}, not open`);
  if (pull.draft) problems.push(`${n} is a draft`);
  if (!COMMITIZEN_TITLE.test(pull.title))
    problems.push(`the title "${pull.title}" is not in Commitizen format, e.g. "feat(cli): add a command"`);
  if (pull.mergeStateStatus !== "CLEAN")
    problems.push(
      `GitHub reports ${n} as ${pull.mergeStateStatus}, not CLEAN${STATE_HELP[pull.mergeStateStatus] ? `: ${STATE_HELP[pull.mergeStateStatus]}` : ""}`,
    );
  for (const p of checkProblems(pull.checks, requiredChecks))
    problems.push(`on head ${pull.headSha.slice(0, 7)}: ${p}`);
  const { total, read, unresolved } = pull.reviewThreads;
  if (unresolved) problems.push(`${n} has ${unresolved} unresolved review thread${unresolved > 1 ? "s" : ""}`);
  else if (total > read) problems.push(`${n} has more than ${read} review threads; check they are resolved by hand`);
  return problems;
}

/** Problem when the head lacks commits of its base and cannot be test-merged; null when it contains the base. */
export function baseProblem(pull: MergePull, cmp: Comparison | null, localCommands: readonly string[]): string | null {
  if (!cmp) return `GitHub could not compare the head of #${pull.number} with ${pull.baseRef}`;
  if (cmp.behindBy === 0) return null;
  if (!localCommands.length)
    return `the head lacks ${cmp.behindBy} commit${cmp.behindBy > 1 ? "s" : ""} of ${pull.baseRef}; ask the worker to rebase, or declare [gates] local_commands in armada.toml so armada merge can test the merge`;
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
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
  /** Give up after waiting this long; defaults to the TTL, after which a crashed holder's lease has expired. */
  maxWaitMs?: number;
  onWait?: (held: Lease | null) => void;
  /** Longest wait for one Turso call on the lease; a hung database refuses instead of hanging. */
  timeoutMs?: number;
}

const LOCK_CALL_TIMEOUT_MS = 10_000;

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
                `Turso did not answer within ${ms / 1000} s to ${what}; nothing was merged`,
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
 * Runs `body` while holding a Turso lease; waits (polling) while another
 * holder has it. `renew` extends the lease and returns false if it was lost.
 */
export async function withLease<T>(
  db: Db,
  o: LeaseOptions,
  body: (renew: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  const key = { project: o.project, name: o.name, holder: o.holder, ttlMs: o.ttlMs };
  const poll = o.pollMs ?? LEASE_POLL_MS;
  const maxWait = o.maxWaitMs ?? o.ttlMs;
  const lockTimeout = o.timeoutMs ?? LOCK_CALL_TIMEOUT_MS;
  let waited = 0;
  let lastHolder: string | null | undefined;
  for (;;) {
    const got = await timed(acquireLease(db, { ...key, at: o.now() }), lockTimeout, `take the ${o.name} lock`).catch(
      async (err: unknown) => {
        // The write may still land later: give back whatever we might hold.
        await timed(releaseLease(db, key), lockTimeout, `release the ${o.name} lock`).catch(() => {});
        throw err;
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
    return await body(() =>
      timed(renewLease(db, { ...key, at: o.now() }), lockTimeout, `renew the ${o.name} lock`).catch(() => false),
    );
  } finally {
    await timed(releaseLease(db, key), lockTimeout, `release the ${o.name} lock`).catch(() => {});
  }
}

// ------------------------------------------------------------------ the command

const say = (ctx: MergeContext, line: string) => ctx.progress?.(line);

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

async function readTicketFor(ctx: MergeContext, pull: MergePull, explicit: string | null | undefined) {
  const id =
    explicit?.trim().toUpperCase() ||
    (pull.headRef ? ticketFromBranch(pull.headRef, ctx.config.tracker.programRoot) : null);
  if (!id)
    throw new Refusal(
      `the branch of #${pull.number} (${pull.headRef ?? "unknown"}) names no ticket`,
      `armada merge ${pull.number} --ticket <id>`,
    );
  const ticket = await ctx.linear.readTicket(id);
  if (!ticket)
    throw new Refusal(`ticket ${id} not found in Linear`, `armada merge ${pull.number} --ticket <id>, with its ticket`);
  return ticket;
}

interface Checked {
  pull: MergePull;
  ticket: Ticket;
  sha: string;
  /** Tip of the base branch the checklist compared the head with. */
  baseSha: string | null;
  lines: string[];
  hints: string[];
  warnings: string[];
}

/** Every checklist rule, the base-branch rule (with a test merge when allowed) and the hints. */
async function checklist(ctx: MergeContext, input: MergeInput): Promise<Checked> {
  const { config } = ctx;
  const pull = await readSettled(ctx, input.pr);
  const ticket = await readTicketFor(ctx, pull, input.ticket);
  const handBack = findHandBack(ticket);
  const warnings = [...ticket.warnings];
  const lines: string[] = [];
  const problems = mergeProblems({ pull, ticket, handBack, requiredChecks: config.gates.requiredChecks });

  const cmp = await ctx.forge.compare(pull.baseRef, pull.headSha);
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
  if (problems.length)
    throw new Refusal(
      `#${pull.number} (${ticket.id}) cannot be merged:\n${problems.map((p) => `  - ${p}`).join("\n")}${
        hints.length ? `\nHints (not blocking):\n${hints.map((h) => `  - ${h}`).join("\n")}` : ""
      }`,
      `armada answer --note ${ticket.id} "<what to fix>" once you told its worker, then armada merge ${pull.number} after the next hand-back`,
    );
  lines.unshift(
    `Checklist passed for #${pull.number} (${ticket.id}): handed back at ${pull.headSha}, CLEAN, checks green, no open review thread.`,
  );
  return { pull, ticket, sha: pull.headSha, baseSha: cmp?.baseSha ?? null, lines, hints, warnings };
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
 * (a test merge): the same rules on a fresh read, and the same base tip.
 */
async function recheck(ctx: MergeContext, c: Checked): Promise<void> {
  const pull = await readSettled(ctx, c.pull.number);
  const ticket = (await ctx.linear.readTicket(c.ticket.id)) ?? c.ticket;
  const problems = mergeProblems({
    pull,
    ticket,
    handBack: findHandBack(ticket),
    requiredChecks: ctx.config.gates.requiredChecks,
  });
  if (pull.headSha === c.sha) {
    const cmp = await ctx.forge.compare(pull.baseRef, pull.headSha);
    if (cmp?.baseSha !== c.baseSha)
      problems.push(
        `${pull.baseRef} moved to ${cmp?.baseSha ?? "an unknown commit"} while #${pull.number} was checked`,
      );
  }
  if (problems.length)
    throw new Refusal(
      `#${pull.number} changed while it was checked; nothing was merged:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
      `armada merge ${pull.number} again`,
    );
}

/** Merges pinned to `sha`, retrying GitHub 5xx after re-reading the state; then reads MERGED back. */
async function mergePinned(ctx: MergeContext, pull: MergePull, sha: string, ticket: string): Promise<MergePull> {
  const n = `#${pull.number}`;
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
        `GitHub failed (${res.message}) and ${n} could not be read back (${readError || "not found"}); if it merged, close ${ticket} by hand`,
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
    say(ctx, `GitHub answered ${res.message}; ${n} is still open at ${sha.slice(0, 7)}, retrying in ${wait / 1000} s…`);
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
          ? `the merge of ${n} was accepted but GitHub shows it as ${seen.state}, not merged (auto-merge or a merge queue?); the ticket was left as is`
          : `the merge of ${n} was accepted but GitHub could not be read back (${readError || "not found"}); if it merged, close ${ticket} by hand`,
        `gh pr view ${pull.number} --repo ${ctx.config.github.repository}`,
      );
    await ctx.sleep(wait);
  }
  if (seen.headSha !== sha)
    throw new Refusal(
      `${n} was merged at ${seen.headSha}, not at the handed-back ${sha}; check ${pull.baseRef} now`,
      `git log origin/${pull.baseRef}`,
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
async function closeTicket(ctx: MergeContext, ticket: Ticket, merged: MergePull, unlocked: boolean): Promise<string[]> {
  const groups = ctx.config.tracker.labels;
  const done = ticket.statusType === "completed" ? null : firstState(ticket.states, "completed");
  await ctx.linear.updateTicket(ticket.uuid, {
    ...(done ? { stateId: done.id } : {}),
    removeLabelIds: [...others(ticket, groups.phaseGroup, null), ...others(ticket, groups.runtimeGroup, null)],
  });
  if (!ticket.prs.some((p) => p.url === merged.url))
    await ctx.linear.linkUrl(ticket.uuid, merged.url, merged.title || `Pull request #${merged.number}`);
  await ctx.linear.comment(
    ticket.uuid,
    `Agent status: merged — PR #${merged.number} squash-merged into ${merged.baseRef} as ${merged.mergeCommit ?? "unknown"}, head ${merged.headSha}${unlocked ? ", merged without lock (--no-lock)" : ""}`,
  );
  return [
    `${ticket.id}: ${done ? `moved to ${done.name}` : "state unchanged"}, agent labels removed, merged status posted.`,
  ];
}

/**
 * Merges a handed-back pull request: lease, checklist, merge pinned to the
 * handed-back SHA, MERGED read back, ticket closed, workers to tell listed.
 * Any refused rule throws `Refusal` naming every failure; nothing is written.
 */
export async function mergePullRequest(ctx: MergeContext, input: MergeInput): Promise<MergeOutcome> {
  if (input.dryRun) {
    const c = await checklist(ctx, input);
    return outcome(c, false, null, c.lines.concat("Dry run: nothing was merged."), [], null);
  }
  const { config } = ctx;
  const slug = config.project.slug;
  const early: string[] = [];
  const run = async (renew: () => Promise<boolean>) => {
    const c = await checklist(ctx, input);
    c.warnings.unshift(...early);
    await recheck(ctx, c);
    if (!(await renew()))
      throw new Refusal(
        "the merge lock could not be renewed (it expired and another coordinator took it, or Turso did not answer); nothing was merged",
        `armada merge ${input.pr} again`,
      );
    say(ctx, `Merging #${c.pull.number} at ${c.sha}…`);
    const merged = await mergePinned(ctx, c.pull, c.sha, c.ticket.id);
    const lines = [
      ...c.lines,
      `Merged #${merged.number} into ${merged.baseRef} as ${merged.mergeCommit ?? "unknown"} (head ${merged.headSha}).`,
    ];
    try {
      lines.push(...(await closeTicket(ctx, c.ticket, merged, !!input.noLock)));
    } catch (err) {
      throw new Error(
        `#${merged.number} is merged, but Linear could not be updated (${err instanceof Error ? err.message : String(err)}); close ${c.ticket.id} by hand: Done, agent labels removed, pull request linked`,
      );
    }
    return after(ctx, c, merged, lines);
  };
  if (input.noLock) {
    early.push(`merged without the merge lock (--no-lock): make sure no other coordinator merges in ${slug} now`);
    return run(async () => true);
  }
  const { db, warning } = await ctx.turso();
  if (!db && ctx.tursoConfigured)
    throw new Refusal(
      `the merge lock needs Turso, which is unavailable (${warning ?? "no answer"}); nothing was merged`,
      `armada merge ${input.pr} again once Turso answers, or armada merge ${input.pr} --no-lock if you are sure no other coordinator merges in ${slug} now`,
    );
  if (!db) {
    early.push(
      `${warning ?? "Turso is not configured"}; the merge lock was not taken, so make sure no other coordinator merges in ${slug} now`,
    );
    return run(async () => true);
  }
  return withLease(
    db,
    {
      project: slug,
      name: MERGE_LEASE,
      holder: ctx.holder,
      ttlMs: MERGE_LEASE_TTL_MS,
      now: ctx.now,
      sleep: ctx.sleep,
      onWait: (held) =>
        say(
          ctx,
          `Waiting for the merge lock held by ${held?.holder ?? "another coordinator"} (until ${held?.expiresAt ?? "?"})…`,
        ),
    },
    run,
  );
}

/** Turso bookkeeping and the list of workers to tell, after the ticket is closed. */
async function after(ctx: MergeContext, c: Checked, merged: MergePull, lines: string[]): Promise<MergeOutcome> {
  const { config } = ctx;
  const slug = config.project.slug;
  const at = ctx.now();
  const live$ = await live(ctx, c.warnings, "record the merge", async (db) => {
    await ensureProject(db, projectOf(config), at);
    const handle = await getRuntimeHandle(db, slug, c.ticket.id);
    await recordEvent(db, {
      project: slug,
      ticket: c.ticket.id,
      kind: "merge",
      phase: "merged",
      message: `PR #${merged.number} merged as ${merged.mergeCommit ?? "unknown"}`,
      prUrl: merged.url,
      headSha: merged.headSha,
      at,
    });
    const resolved = await resolveInboxItems(db, {
      project: slug,
      ticket: c.ticket.id,
      kind: "hand-back",
      resolution: `merged as ${merged.mergeCommit ?? "unknown"}`,
      at,
    });
    // No worker is left to take an answer.
    await resolveInboxItems(db, { project: slug, ticket: c.ticket.id, kind: "question", resolution: "merged", at });
    await releaseRuntimeHandle(db, slug, c.ticket.id, at);
    return { handle, resolved, open: await openRuntimeHandles(db, slug) };
  });
  if (live$?.resolved) lines.push(`Hand-back resolved in the coordinator's inbox.`);

  let workers: WorkerToTell[] = [];
  try {
    const handles = new Map<string, RuntimeHandle>((live$?.open ?? []).map((h) => [h.ticket, h]));
    workers = (await ctx.inFlight())
      .filter((t) => t.id !== c.ticket.id)
      .map((t) => ({
        ticket: t.id,
        title: t.title,
        phase: t.phase,
        runtime: t.runtime ?? handles.get(t.id)?.runtime ?? null,
        handle: handles.get(t.id)?.handle ?? null,
      }));
  } catch (err) {
    c.warnings.push(
      `could not list the workers in flight (${err instanceof Error ? err.message : String(err)}); run armada status`,
    );
  }

  const claim = activeClaimComments(c.ticket.comments)[0]?.claim;
  const runtime = live$?.handle?.runtime ?? c.ticket.agentRuntime ?? claim?.runtime ?? null;
  const expected = runtimeGuide(runtime);
  let guide: string | null = null;
  try {
    guide = expected && (await ctx.installedSkill(expected)) ? expected : null;
  } catch (err) {
    c.warnings.push(`could not look for the ${expected} skill (${err instanceof Error ? err.message : String(err)})`);
  }
  const archive = { runtime, handle: live$?.handle?.handle ?? claim?.session ?? null, guide };
  return outcome(c, true, merged, lines, workers, archive);
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
    ticket: { id: c.ticket.id, url: c.ticket.url },
    lines,
    hints: c.hints,
    workers,
    archive,
    warnings: c.warnings,
  };
}
