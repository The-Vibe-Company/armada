import type { EventInput, EventKind, EventPayloads, GithubPullRequest, PullRequest } from "@armada/daemon/events";
import { z } from "zod";
import { emptyCheckpoint, emptyPr, type GithubCheckpoint, githubCheckpoint } from "./checkpoint.ts";
import { GithubHttp, GithubReadError } from "./http.ts";
import { githubToken } from "./keychain.ts";
import { normalize } from "./normalize.ts";
import { readReviews } from "./reviews.ts";
import {
  type Forge,
  type ForgeEvents,
  type ForgeReadContext,
  type ForgeRefresh,
  type Schedule,
  schedule,
} from "./types.ts";

// Adapted from packages/core/src/github.ts (V1): PULL_FIELDS, PULLS_QUERY and
// PULL_QUERY. No V1 import: this provider can move to packages/plugins/github.
const WORKFLOW = `status conclusion commit { oid } workflowRun { databaseId runNumber runAttempt workflow { id } }`;
const FIELDS = `fragment P on PullRequest {
  number title url state isDraft mergeable mergeStateStatus headRefName headRefOid reviewDecision author { login } baseRefOid
  commits(last: 1) { nodes { commit { oid
    checkSuites(first: 50) { nodes { ${WORKFLOW} } pageInfo { hasNextPage } }
    statusCheckRollup { state contexts(first: 50) { pageInfo { hasNextPage } nodes {
      __typename
      ... on CheckRun { name status conclusion checkSuite { ${WORKFLOW} } }
      ... on StatusContext { context state }
    } } }
  } } }
}`;
const OPEN = `${FIELDS}
query Pulls($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name target { ... on Commit { oid statusCheckRollup { state } } } }
    open: pullRequests(states: OPEN, first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor } nodes { ...P }
    }
  }
}`;
interface Options {
  endpoint?: string;
  repository: string;
  tickets: () => ReadonlySet<string> | Promise<ReadonlySet<string>>;
  perPrTimeoutMs?: number;
  openPullRequests?: () => readonly PullRequest[] | Promise<readonly PullRequest[]>;
  schedule?: Schedule;
  activeTickets?: () => ReadonlySet<string> | Promise<ReadonlySet<string>>;
  token?: (signal: AbortSignal) => Promise<string>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** Owner-token GitHub implementation; only observations cross the provider boundary. */
class GithubForge implements Forge {
  readonly #options: Options;
  defaultBranch?: EventPayloads["default-branch.seen"];
  readonly #pendingPrs = new Map<number, Promise<unknown>>();
  constructor(options: Options) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository)) throw new Error("GitHub repository must be owner/name");
    this.#options = options;
  }

  async #isolated<T>(number: number, signal: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#pendingPrs.has(number)) throw new GithubReadError("GitHub reading still pending");
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new GithubReadError("GitHub reading timed out")), {
        once: true,
      });
      if (controller.signal.aborted) reject(new GithubReadError("GitHub reading stopped"));
    });
    const cancel = (this.#options.schedule ?? schedule)(stop, this.#options.perPrTimeoutMs ?? 5000);
    const pending = Promise.resolve()
      .then(() => read(controller.signal))
      .finally(() => {
        this.#pendingPrs.delete(number);
      });
    this.#pendingPrs.set(number, pending);
    try {
      return await Promise.race([pending, aborted]);
    } finally {
      cancel();
      signal.removeEventListener("abort", stop);
    }
  }

  async read(
    previousOpen: readonly number[],
    signal: AbortSignal,
    context?: ForgeReadContext,
  ): Promise<GithubPullRequest[]> {
    try {
      return await this.#read(previousOpen, signal, context);
    } catch (error) {
      // Raw fetch, body and token errors never cross this boundary.
      throw error instanceof GithubReadError ? error : new GithubReadError("GitHub reading failed");
    }
  }

  async #read(
    previousOpen: readonly number[],
    signal: AbortSignal,
    context?: ForgeReadContext,
  ): Promise<GithubPullRequest[]> {
    const options = this.#options;
    let token: string;
    try {
      token = (await (options.token ?? ((signal) => githubToken({ signal })))(signal)).trim();
    } catch {
      throw new GithubReadError("GitHub credentials unavailable");
    }
    if (!token || /\s/.test(token)) throw new GithubReadError("GitHub credentials unavailable");
    signal.throwIfAborted();
    const [owner, name] = options.repository.split("/");
    const state = context?.checkpoint ?? emptyCheckpoint(options.repository);
    const at = context?.at ?? new Date().toISOString();
    const active = (await options.activeTickets?.()) ?? new Set<string>();
    const http = new GithubHttp(
      options,
      token,
      state,
      Date.parse(at),
      options.activeTickets && !active.size ? 300000 : 30000,
    );
    const query = (query: string, variables: object, readSignal = signal) =>
      http.query(query, { owner, name, ...variables }, readSignal);
    const failed = (number: number, error: unknown) => {
      const cursor = state.prs[number] ?? emptyPr();
      cursor.failures++;
      cursor.error = error instanceof GithubReadError ? error.message : "GitHub reading failed";
      cursor.failedSince ??= at;
      if (error instanceof GithubReadError && error.status === 410) cursor.abandoned = "gone";
      else if (Date.parse(at) - Date.parse(cursor.failedSince) >= 86400000) cursor.abandoned = "unavailable-24h";
      state.prs[number] = cursor;
    };
    const recovered = (number: number) => {
      const cursor = state.prs[number];
      if (!cursor || cursor.abandoned) return;
      cursor.failures = 0;
      delete cursor.failedSince;
      delete cursor.error;
    };
    const pulls = new Map<number, GithubPullRequest>();
    const cursors = new Set<string>();
    const tickets = await options.tickets();
    let after: string | null = null;
    let health: EventPayloads["default-branch.seen"] | undefined;
    // Whole open-list reads are necessary: check runs do not reliably change PR updatedAt.
    for (;;) {
      const { open, defaultBranchRef: branch } = await query(OPEN, { after });
      if (branch) {
        const head = branch.target?.oid;
        const state = branch.target?.statusCheckRollup?.state ?? "NONE";
        if (
          !/^[\w./-]{1,200}$/.test(branch.name) ||
          !/^[0-9a-f]{40}$/i.test(head ?? "") ||
          branch.name.includes(token) ||
          !["NONE", "SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"].includes(state)
        )
          throw new GithubReadError("GitHub returned an incomplete reading");
        health = {
          branch: branch.name,
          head: head.toLowerCase(),
          ci:
            state === "SUCCESS"
              ? "success"
              : ["FAILURE", "ERROR"].includes(state)
                ? "failure"
                : state === "NONE"
                  ? "none"
                  : "pending",
        };
      }
      if (!open || !Array.isArray(open.nodes) || typeof open.pageInfo?.hasNextPage !== "boolean")
        throw new GithubReadError("GitHub returned an incomplete open list");
      for (const raw of open.nodes) {
        const pr = normalize(raw, options.repository, tickets, token);
        if (pr.state !== "open") throw new GithubReadError("GitHub open list contains a closed pull request");
        pulls.set(pr.number, pr);
        if (!active.has(pr.ticket)) recovered(pr.number);
      }
      if (!open.pageInfo.hasNextPage) break;
      after = open.pageInfo.endCursor;
      if (!after || cursors.has(after) || cursors.size >= 100)
        throw new GithubReadError("GitHub pagination did not complete");
      cursors.add(after);
    }
    context?.onDetails?.();
    // Reconciliation is independent of comment following, including abandoned PRs.
    // The fold includes terminal/conflict facts from writers other than this reader.
    const held = (await options.openPullRequests?.()) ?? context?.openPullRequests;
    if (context) context.openPullRequests = held;
    const missing = [
      ...new Set(held ? held.filter((pr) => pr.state === "open").map((pr) => pr.number) : previousOpen),
    ].filter((number) => !pulls.has(number));
    for (const number of missing) {
      if (state.pausedUntil && Date.parse(state.pausedUntil) > Date.parse(at)) {
        if (context) context.reconciliationError = "GitHub reading failed";
        break;
      }
      try {
        const pr = await this.#isolated(number, signal, async (child) => {
          const response = await http.request(`${http.rest}/repos/${options.repository}/pulls/${number}`, child);
          const raw = await response.json();
          child.throwIfAborted();
          return terminalPull(
            raw,
            number,
            options.repository,
            tickets,
            token,
            held?.find((pr) => pr.number === number),
          );
        });
        if (pr) pulls.set(number, pr);
        recovered(number);
      } catch (error) {
        signal.throwIfAborted();
        failed(number, error);
        if (context)
          context.reconciliationError = error instanceof GithubReadError ? error.message : "GitHub reading failed";
      }
    }
    await Promise.all(
      [...pulls.values()]
        .filter((pr) => pr.state === "open" && active.has(pr.ticket))
        .map(async (pr) => {
          const prior = state.prs[pr.number] ?? emptyPr();
          if (prior.abandoned || (state.pausedUntil && Date.parse(state.pausedUntil) > Date.parse(at))) return;
          try {
            const reading = await this.#isolated(pr.number, signal, (child) => readReviews(http, pr, prior, at, child));
            state.prs[pr.number] = reading.state;
            pr.unresolvedThreads = reading.unresolved;
            if (reading.state.compareBehind !== undefined) pr.behind = reading.state.compareBehind;
            context?.events.push(...reading.events);
          } catch (error) {
            signal.throwIfAborted();
            failed(pr.number, error);
          }
        }),
    );
    signal.throwIfAborted();
    this.defaultBranch = health;
    return [...pulls.values()].sort((a, b) => a.number - b.number);
  }
}

/** REST terminal evidence must be complete before it can retire an open fold row. */
function terminalPull(
  raw: unknown,
  number: number,
  repository: string,
  tickets: ReadonlySet<string>,
  token: string,
  held?: PullRequest,
): (GithubPullRequest & { mergeCommit?: string; mergedAt?: string }) | undefined {
  const fail = () => {
    throw new GithubReadError("GitHub returned an incomplete reading");
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const pr = raw as Record<string, unknown>;
  if (pr.number !== number || !["open", "closed"].includes(String(pr.state))) return fail();
  // A PR may reopen between the complete list and this lookup. Never fabricate a close.
  if (pr.state === "open") return undefined;
  const head = pr.head as { sha?: unknown; ref?: unknown } | undefined;
  if (
    typeof pr.merged !== "boolean" ||
    typeof pr.title !== "string" ||
    typeof pr.html_url !== "string" ||
    typeof pr.draft !== "boolean" ||
    typeof head?.sha !== "string" ||
    !head.sha ||
    typeof head.ref !== "string"
  )
    return fail();
  if (
    pr.merged &&
    (typeof pr.merge_commit_sha !== "string" ||
      !/^[0-9a-f]{40}$/i.test(pr.merge_commit_sha) ||
      typeof pr.merged_at !== "string" ||
      !z.iso.datetime().safeParse(pr.merged_at).success)
  )
    return fail();
  const clean = (value: string) => value.replaceAll(token, "[redacted]");
  const ticket =
    held?.ticket ||
    [...head.ref.matchAll(/(?:^|[/_-])([a-z][a-z0-9]*-\d+)(?=[-_/]|$)/gi)]
      .map((match) => (match[1] ?? "").toUpperCase())
      .find((id) => tickets.has(id)) ||
    "";
  return {
    review: "none",
    checks: [],
    checksComplete: false,
    ci: held?.ci ?? "none",
    ...held,
    number,
    repository,
    ticket: clean(ticket),
    title: clean(pr.title),
    url: clean(pr.html_url),
    head: clean(head.sha),
    headRef: clean(head.ref),
    draft: pr.draft,
    // REST owns the terminal facts even when the fold retains older open metadata.
    state: pr.merged ? "merged" : "closed",
    conflicting: false,
    ...(pr.merged
      ? { mergeCommit: clean(String(pr.merge_commit_sha).toLowerCase()), mergedAt: clean(String(pr.merged_at)) }
      : {}),
  };
}

type TransitionKind = Exclude<
  Extract<EventKind, `pull-request.${string}`>,
  "pull-request.seen" | "pull-request.commented"
>;
type Transition = Extract<EventInput, { kind: TransitionKind }>;

function transitions(
  before: (PullRequest & Partial<GithubPullRequest>) | undefined,
  pr: GithubPullRequest,
): TransitionKind[] {
  const kinds: TransitionKind[] = [];
  if (pr.state === "open" && pr.conflicting && (!before?.conflicting || before.head !== pr.head))
    kinds.push("pull-request.conflicting");
  if (pr.state === "open" && pr.behind && (!before?.behind || before.head !== pr.head || before.base !== pr.base))
    kinds.push("pull-request.behind");
  if (pr.state === "open" && before?.state !== "open") kinds.push("pull-request.opened");
  if (before && before.head !== pr.head) kinds.push("pull-request.head-moved");
  if ((before?.head !== pr.head || before?.ci !== pr.ci) && pr.ci === "success")
    kinds.push("pull-request.checks-green");
  if ((before?.head !== pr.head || before?.ci !== pr.ci) && pr.ci === "failure") kinds.push("pull-request.checks-red");
  if (before && before.review !== pr.review) kinds.push("pull-request.review-changed");
  if (pr.state === "merged" && before?.state !== "merged") kinds.push("pull-request.merged");
  if (pr.state === "closed" && before?.state !== "closed") kinds.push("pull-request.closed");
  return kinds;
}
function transitionEvent(
  kind: TransitionKind,
  pr: GithubPullRequest,
  project: string,
  actor: string,
  at: string,
): Transition {
  const payload =
    kind === "pull-request.conflicting" || kind === "pull-request.behind"
      ? {
          ...pr,
          pr: pr.number,
          key: `${pr.repository}:${pr.number}:${kind}:${pr.head}${kind === "pull-request.behind" ? `:${pr.base ?? "unknown"}` : ""}`,
        }
      : pr;
  return { kind, project, actor, at, payload } as Transition;
}
function fingerprint(event: EventInput): string {
  return JSON.stringify([event.project, event.kind, event.at, event.actor, event.payload]);
}

interface ReaderOptions extends Options {
  project: string;
  actor: string;
  store: ForgeEvents;
  forge?: Forge;
  now?: () => Date;
  schedule?: Schedule;
  timeoutMs?: number;
  intervalMs?: number;
}

/** Non-overlapping background ingestion. The server reads the local log, never this promise. */
export class GithubReader {
  readonly #options: ReaderOptions;
  readonly #forge: Forge;
  #active: Promise<ForgeRefresh> | undefined;
  #providerPending = false;
  #controller: AbortController | undefined;
  #running = false;
  #loop = 0;
  #cursor = 0;
  readonly #previous = new Map<number, GithubPullRequest>();
  readonly #pending = new Map<string, Transition>();
  #state: GithubCheckpoint;
  #cancelPoll: (() => void) | undefined;

  constructor(options: ReaderOptions) {
    if (!options.project || !options.actor) throw new Error("GitHub reader needs project and actor");
    for (const ms of [options.timeoutMs ?? 15000, options.intervalMs ?? 30000, options.perPrTimeoutMs ?? 5000])
      if (!Number.isFinite(ms) || ms <= 0 || ms > 2147483647)
        throw new Error("GitHub reader timings must be positive timer delays");
    this.#options = options;
    this.#state = emptyCheckpoint(options.repository);
    this.#forge = options.forge ?? new GithubForge(options);
  }

  state() {
    return {
      backoffMs: this.#state.backoffMs,
      pausedUntil: this.#state.pausedUntil,
      pollMs: this.#state.pollMs,
      failures: Object.entries(this.#state.prs)
        .filter(([, p]) => p.failures && !p.abandoned)
        .map(([pr, p]) => ({
          pr: Number(pr),
          failures: p.failures,
          since: p.failedSince ?? "",
          error: p.error ?? "GitHub reading failed",
        })),
      abandoned: Object.entries(this.#state.prs)
        .filter(([, p]) => p.abandoned)
        .map(([n]) => Number(n)),
    };
  }

  refresh(): Promise<ForgeRefresh> {
    if (this.#active) return this.#active;
    if (this.#providerPending) return Promise.resolve({ ok: false, error: "GitHub reading still pending" });
    this.#active = this.#refresh().finally(() => {
      this.#active = undefined;
    });
    return this.#active;
  }

  async #refresh(): Promise<ForgeRefresh> {
    const options = this.#options;
    const controller = new AbortController();
    this.#controller = controller;
    let timedOut = false;
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
    const cancelDeadline = (options.schedule ?? schedule)(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? 15000);
    const append = async (event: EventInput) => {
      controller.signal.throwIfAborted();
      return await options.store.append(event);
    };
    let draft: GithubCheckpoint | undefined;
    try {
      const previous = this.#previous;
      for (const event of await options.store.readSince(this.#cursor, options.project)) {
        if (event.kind === "coordinator.checkpoint") {
          const parsed = githubCheckpoint.safeParse(event.payload.checkpoint);
          if (parsed.success && parsed.data.repository === options.repository) this.#state = parsed.data;
        }
        if (event.kind === "pull-request.seen") {
          const pr = event.payload as GithubPullRequest;
          if (pr.repository === options.repository) {
            // A snapshot is the durable intent for its deterministic transition facts.
            // Replay repairs any tail lost between independent append commits.
            for (const kind of transitions(previous.get(pr.number), pr))
              this.#pending.set(
                `${event.seq}:${kind}`,
                transitionEvent(kind, pr, event.project, event.actor, event.at),
              );
            previous.set(pr.number, pr);
          }
        } else if (event.kind.startsWith("pull-request.")) {
          if (event.kind !== "pull-request.commented") {
            const pr = event.payload as GithubPullRequest;
            if (pr.repository === options.repository) previous.set(pr.number, pr);
          }
          const key = fingerprint(event);
          for (const [id, pending] of this.#pending) {
            if (fingerprint(pending) !== key) continue;
            this.#pending.delete(id);
            break;
          }
        }
        this.#cursor = event.seq;
      }
      for (const [id, pending] of this.#pending) {
        await append(pending);
        this.#pending.delete(id);
      }
      controller.signal.throwIfAborted();
      const at = (options.now?.() ?? new Date()).toISOString();
      if (this.#state.pausedUntil && Date.parse(this.#state.pausedUntil) > Date.parse(at))
        return { ok: true, changed: 0 };
      draft = structuredClone(this.#state);
      delete draft.pausedUntil;
      const context: ForgeReadContext = {
        checkpoint: draft,
        at,
        events: [],
        onDetails: cancelDeadline,
        openPullRequests: [...previous.values()],
      };
      this.#providerPending = true;
      const reading = await Promise.race([
        this.#forge
          .read(
            [...previous.values()].filter((pr) => pr.state === "open").map((pr) => pr.number),
            controller.signal,
            context,
          )
          .finally(() => {
            this.#providerPending = false;
          }),
        aborted,
      ]);
      controller.signal.throwIfAborted();
      let changed = 0;
      for (const pr of reading) {
        const before = context.openPullRequests?.find((held) => held.number === pr.number) ?? previous.get(pr.number);
        if (pr.unresolvedThreads === undefined && before?.unresolvedThreads !== undefined)
          pr.unresolvedThreads = before.unresolvedThreads;
        if (JSON.stringify(before) === JSON.stringify(pr)) continue;
        if (pr.state !== "open") {
          // The terminal event is its own durable observation. A preceding seen
          // snapshot would expose a merge without its generation-fencing time.
          await append(
            transitionEvent(
              pr.state === "merged" ? "pull-request.merged" : "pull-request.closed",
              pr,
              options.project,
              options.actor,
              at,
            ),
          );
          changed++;
          continue;
        }
        await append({
          project: options.project,
          actor: options.actor,
          at,
          kind: "pull-request.seen",
          payload: pr,
        });
        for (const kind of transitions(before, pr))
          await append(transitionEvent(kind, pr, options.project, options.actor, at));
        changed++;
      }
      const health = this.#forge.defaultBranch;
      const recordedHealth = (await options.store.readSince(0, options.project)).findLast(
        (e) => e.kind === "default-branch.seen",
      );
      if (health && JSON.stringify(recordedHealth?.payload) !== JSON.stringify(health)) {
        await append({
          project: options.project,
          actor: options.actor,
          at,
          kind: "default-branch.seen",
          payload: health,
        });
        changed++;
      }
      const keys = new Set(
        (await options.store.readSince(0, options.project)).flatMap((e) =>
          (e.kind === "pull-request.commented" ||
            e.kind === "review-thread.opened" ||
            e.kind === "review-thread.resolved") &&
          e.payload.repository === options.repository
            ? [e.payload.key]
            : [],
        ),
      );
      for (const fact of context.events) {
        if (keys.has(fact.payload.key)) continue;
        await append({ ...fact, project: options.project, actor: options.actor, at });
        keys.add(fact.payload.key);
      }
      if (!draft.pausedUntil) draft.backoffMs = 0;
      if (draft.pollMs) {
        const until = new Date(Date.parse(at) + draft.pollMs).toISOString();
        if (!draft.pausedUntil || Date.parse(draft.pausedUntil) < Date.parse(until)) draft.pausedUntil = until;
      }
      if (JSON.stringify(this.#state) !== JSON.stringify(draft)) {
        await append({
          project: options.project,
          actor: options.actor,
          at,
          kind: "coordinator.checkpoint",
          payload: { checkpoint: draft },
        });
        this.#state = draft;
      }
      return context.reconciliationError ? { ok: false, error: context.reconciliationError } : { ok: true, changed };
    } catch (error) {
      if (draft && error instanceof GithubReadError && !controller.signal.aborted) {
        const state = {
          ...this.#state,
          backoffMs: draft.backoffMs,
          pollMs: draft.pollMs,
          ...(draft.pausedUntil ? { pausedUntil: draft.pausedUntil } : {}),
        };
        if (JSON.stringify(state) !== JSON.stringify(this.#state)) {
          await append({
            project: options.project,
            actor: options.actor,
            at: (options.now?.() ?? new Date()).toISOString(),
            kind: "coordinator.checkpoint",
            payload: { checkpoint: state },
          });
          this.#state = state;
        }
      }
      // Only categorized adapter errors survive; store and arbitrary provider errors stay private.
      return {
        ok: false,
        error: timedOut
          ? "GitHub reading timed out"
          : controller.signal.aborted
            ? "GitHub reading stopped"
            : error instanceof GithubReadError
              ? error.message
              : "GitHub reading failed",
      };
    } finally {
      cancelDeadline();
      if (this.#controller === controller) this.#controller = undefined;
    }
  }

  start(): () => void {
    if (!this.#running) {
      this.#running = true;
      const loop = ++this.#loop;
      const tick = async () => {
        await this.refresh();
        if (this.#running && loop === this.#loop)
          this.#cancelPoll = (this.#options.schedule ?? schedule)(
            () => {
              void tick();
            },
            Math.max(
              this.#options.intervalMs ??
                (this.#options.activeTickets && !(await this.#options.activeTickets()).size ? 300000 : 30000),
              this.#state.pollMs,
              this.#state.backoffMs,
            ),
          );
      };
      void tick();
    }
    return () => this.stop();
  }

  stop(): void {
    this.#running = false;
    this.#loop++;
    this.#cancelPoll?.();
    this.#cancelPoll = undefined;
    this.#controller?.abort();
  }
}
