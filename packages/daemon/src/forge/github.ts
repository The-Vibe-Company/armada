import type { EventInput, EventKind, GithubPullRequest } from "@armada/daemon/events";
import { githubToken } from "./keychain.ts";
import { normalize, type RawPull } from "./normalize.ts";
import { type Forge, type ForgeEvents, type ForgeRefresh, type Schedule, schedule } from "./types.ts";

// Adapted from packages/core/src/github.ts (V1): PULL_FIELDS, PULLS_QUERY and
// PULL_QUERY. No V1 import: this provider can move to packages/plugins/github.
const WORKFLOW = `status conclusion commit { oid } workflowRun { databaseId runNumber runAttempt workflow { id } }`;
const FIELDS = `fragment P on PullRequest {
  number title url state isDraft mergeable mergeStateStatus headRefName headRefOid reviewDecision
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
    open: pullRequests(states: OPEN, first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor } nodes { ...P }
    }
  }
}`;
const ONE = `${FIELDS}
query Pull($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ...P } }
}`;
interface Options {
  repository: string;
  tickets: () => ReadonlySet<string>;
  token?: (signal: AbortSignal) => Promise<string>;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** Owner-token GitHub implementation; only observations cross the provider boundary. */
class GithubForge implements Forge {
  readonly #options: Options;
  constructor(options: Options) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options.repository)) throw new Error("GitHub repository must be owner/name");
    this.#options = options;
  }

  async read(previousOpen: readonly number[], signal: AbortSignal): Promise<GithubPullRequest[]> {
    try {
      return await this.#read(previousOpen, signal);
    } catch {
      // The provider boundary is safe to log, even when fetch or token access throws.
      throw new Error("GitHub reading failed");
    }
  }

  async #read(previousOpen: readonly number[], signal: AbortSignal): Promise<GithubPullRequest[]> {
    const options = this.#options;
    const token = (await (options.token ?? ((signal) => githubToken({ signal })))(signal)).trim();
    if (!token || /\s/.test(token)) throw new Error("GitHub credentials unavailable");
    signal.throwIfAborted();
    const [owner, name] = options.repository.split("/");
    const query = async (query: string, variables: object) => {
      signal.throwIfAborted();
      const response = await (options.fetch ?? fetch)("https://api.github.com/graphql", {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables: { owner, name, ...variables } }),
      });
      if (!response.ok) throw new Error("GitHub request failed");
      const json = (await response.json()) as {
        data?: {
          repository?: {
            open?: { nodes: RawPull[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
            pullRequest?: RawPull | null;
          } | null;
        };
        errors?: unknown[];
      };
      signal.throwIfAborted();
      if (!json || json.errors?.length || !json.data?.repository)
        throw new Error("GitHub returned an incomplete reading");
      return json.data.repository;
    };
    const pulls = new Map<number, GithubPullRequest>();
    const cursors = new Set<string>();
    const tickets = options.tickets();
    let after: string | null = null;
    // Whole open-list reads are necessary: check runs do not reliably change PR updatedAt.
    for (;;) {
      const { open } = await query(OPEN, { after });
      if (!open || !Array.isArray(open.nodes) || typeof open.pageInfo?.hasNextPage !== "boolean")
        throw new Error("GitHub returned an incomplete open list");
      for (const raw of open.nodes) {
        const pr = normalize(raw, options.repository, tickets, token);
        if (pr.state !== "open") throw new Error("GitHub open list contains a closed pull request");
        pulls.set(pr.number, pr);
      }
      if (!open.pageInfo.hasNextPage) break;
      after = open.pageInfo.endCursor;
      if (!after || cursors.has(after) || cursors.size >= 100) throw new Error("GitHub pagination did not complete");
      cursors.add(after);
    }
    // Looking up disappeared open PRs avoids a lossy 'last 30 closed' window.
    for (const number of previousOpen) {
      if (pulls.has(number)) continue;
      const { pullRequest } = await query(ONE, { number });
      if (!pullRequest || pullRequest.number !== number) throw new Error("GitHub lost a previously open pull request");
      pulls.set(number, normalize(pullRequest as RawPull, options.repository, tickets, token));
    }
    signal.throwIfAborted();
    return [...pulls.values()].sort((a, b) => a.number - b.number);
  }
}

type TransitionKind = Exclude<Extract<EventKind, `pull-request.${string}`>, "pull-request.seen">;
type Transition = Extract<EventInput, { kind: TransitionKind }>;

function transitions(before: GithubPullRequest | undefined, pr: GithubPullRequest): TransitionKind[] {
  const kinds: TransitionKind[] = [];
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
  #controller: AbortController | undefined;
  #running = false;
  #loop = 0;
  #cursor = 0;
  readonly #previous = new Map<number, GithubPullRequest>();
  readonly #pending = new Map<string, Transition>();
  #cancelPoll: (() => void) | undefined;

  constructor(options: ReaderOptions) {
    if (!options.project || !options.actor) throw new Error("GitHub reader needs project and actor");
    for (const ms of [options.timeoutMs ?? 15000, options.intervalMs ?? 30000])
      if (!Number.isFinite(ms) || ms <= 0 || ms > 2147483647)
        throw new Error("GitHub reader timings must be positive timer delays");
    this.#options = options;
    this.#forge = options.forge ?? new GithubForge(options);
  }

  refresh(): Promise<ForgeRefresh> {
    if (this.#active) return this.#active;
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
    try {
      const previous = this.#previous;
      for (const event of options.store.readSince(this.#cursor, options.project)) {
        if (event.kind === "pull-request.seen") {
          const pr = event.payload as GithubPullRequest;
          if (pr.repository === options.repository) {
            // A snapshot is the durable intent for its deterministic transition facts.
            // Replay repairs any tail lost between independent append commits.
            for (const kind of transitions(previous.get(pr.number), pr))
              this.#pending.set(`${event.seq}:${kind}`, {
                project: event.project,
                actor: event.actor,
                at: event.at,
                kind,
                payload: pr,
              });
            previous.set(pr.number, pr);
          }
        } else if (event.kind.startsWith("pull-request.")) {
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
        options.store.append(pending);
        this.#pending.delete(id);
      }
      const reading = await Promise.race([
        this.#forge.read(
          [...previous.values()].filter((pr) => pr.state === "open").map((pr) => pr.number),
          controller.signal,
        ),
        aborted,
      ]);
      controller.signal.throwIfAborted();
      const at = (options.now?.() ?? new Date()).toISOString();
      let changed = 0;
      for (const pr of reading) {
        const before = previous.get(pr.number);
        if (JSON.stringify(before) === JSON.stringify(pr)) continue;
        options.store.append({
          project: options.project,
          actor: options.actor,
          at,
          kind: "pull-request.seen",
          payload: pr,
        });
        for (const kind of transitions(before, pr))
          options.store.append({ project: options.project, actor: options.actor, at, kind, payload: pr });
        changed++;
      }
      return { ok: true, changed };
    } catch {
      // Never expose fetch/GraphQL/child-process messages, bodies or raw credentials.
      return {
        ok: false,
        error: timedOut
          ? "GitHub reading timed out"
          : controller.signal.aborted
            ? "GitHub reading stopped"
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
          this.#cancelPoll = (this.#options.schedule ?? schedule)(() => {
            void tick();
          }, this.#options.intervalMs ?? 30000);
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
