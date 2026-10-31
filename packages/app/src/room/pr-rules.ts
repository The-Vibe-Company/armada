// The panel's Pull requests' rules (THE-2086), after T3 Code's pull request
// rows (`PullRequestListRow.tsx`, `PullRequestChecksPopover.tsx`): the open
// pull requests of the tickets in flight, Ready first then by ticket, each
// with the word its state says; where each check opens; and how long Merge
// holds "Merging…": from its message until the fold sees the pull request
// leave, or the coordinator's turn that took the message ends (its answer, in
// the thread, says why the pull request is still open).
import type { ChatItem, ChatTurn, Provider } from "@armada/protocol";
import type { FleetItem } from "@/fleet/overview";
import type { FleetState, FoldedCheck, FoldedPullRequest } from "@/fleet/state";

export type PullRequestWord = "ready" | "red" | "running" | "conflicts" | "draft" | "passed" | "none";

export const WORDS: Record<PullRequestWord, string> = {
  ready: "Ready",
  red: "Red CI",
  running: "Checks running",
  conflicts: "Conflicts",
  draft: "Draft",
  passed: "Checks passed",
  none: "No checks",
};

export interface OpenPullRequest extends FoldedPullRequest {
  /** The pull request's own title, else its ticket's. */
  title: string;
  word: PullRequestWord;
}

/**
 * What a pull request's state says, most pressing first: a draft or a
 * conflict before its checks; Ready only when its ticket is ready to merge
 * and nothing in it says otherwise.
 */
export function pullRequestWord(pr: FoldedPullRequest, ticketReady: boolean): PullRequestWord {
  if (pr.draft) return "draft";
  if (pr.conflicting) return "conflicts";
  if (pr.ci === "failure") return "red";
  if (pr.ci === "pending") return "running";
  if (ticketReady) return "ready";
  return pr.ci === "success" ? "passed" : "none";
}

const byTicket = new Intl.Collator("en", { numeric: true });

/** The open pull requests of the tickets in flight: Ready first, then by ticket, then by number. */
export function openPullRequests(state: FleetState, items: readonly FleetItem[]): OpenPullRequest[] {
  const flying = new Map(items.filter((i) => i.group !== "merged").map((i) => [i.ticket, i]));
  return state.pullRequests
    .flatMap((p) => {
      const item = flying.get(p.ticket);
      if (p.state !== "open" || !item) return [];
      return [{ ...p, title: p.title || item.title, word: pullRequestWord(p, item.group === "ready") }];
    })
    .sort(
      (a, b) =>
        Number(b.word === "ready") - Number(a.word === "ready") ||
        byTicket.compare(a.ticket, b.ticket) ||
        a.number - b.number,
    );
}

/** Where the pull request is on GitHub. */
export const pullRequestHref = (pr: Pick<FoldedPullRequest, "number" | "url">, repository: string) =>
  pr.url?.startsWith("https://") ? pr.url : `https://github.com/${repository}/pull/${pr.number}`;

/** Where a check opens: its Actions run (its attempt past the first), else the pull request's checks. */
export function checkHref(check: FoldedCheck, pr: Pick<FoldedPullRequest, "number" | "url">, repository: string) {
  if (check.runId === undefined) return `${pullRequestHref(pr, repository)}/checks`;
  const attempt = check.runAttempt && check.runAttempt > 1 ? `/attempts/${check.runAttempt}` : "";
  return `https://github.com/${repository}/actions/runs/${check.runId}${attempt}`;
}

/** The head as the row shows it. */
export const shortSha = (head: string | undefined) => (head ? head.slice(0, 7) : "");

/** The coordinator's lines in the conversation: a new one answers a message, on a daemon without a live turn. */
export const coordinatorLines = (items: readonly ChatItem[]) => items.filter((i) => i.kind !== "owner").length;

/** A Merge asked of the coordinator, held as "Merging…" until it is answered. */
export interface MergeHold {
  pr: number;
  /** The coordinator's turn ran since the message was sent. */
  seen: boolean;
  /** The coordinator's lines when it was sent. */
  lines: number;
}

/** What the room sees after a Merge was sent. */
export interface MergeSight {
  open: ReadonlySet<number>;
  /** The coordinator's turn; null on a daemon without a live turn. */
  turn: Pick<ChatTurn, "state"> | null;
  lines: number;
}

/**
 * The hold after what the room sees: gone once the pull request is no longer
 * open (merged), or once the turn that took the message ended (the coordinator
 * answered: refused, or merged before the fold reads it); on a daemon without
 * a live turn, once the coordinator says anything.
 */
export function stepHold(hold: MergeHold, sight: MergeSight): MergeHold | null {
  if (!sight.open.has(hold.pr)) return null;
  if (sight.turn === null) return sight.lines > hold.lines ? null : hold;
  if (sight.turn.state !== "idle") return hold.seen ? hold : { ...hold, seen: true };
  return hold.seen ? null : hold;
}

/** The message Merge sends: the coordinator's prompt knows to check, then merge. */
export const mergeMessage = (pr: number) => `Merge #${pr}`;

/**
 * Whether the project's pull requests can be read (THE-2074's connections):
 * not once the daemon listed its providers and no forge among them is
 * connected; unknown while it has not listed them, or on a daemon that does not.
 */
export function forgeReads(providers: readonly Pick<Provider, "seam" | "state" | "enabled">[] | null): boolean {
  if (!providers) return true;
  return providers.some((p) => p.seam === "forge" && p.enabled && p.state === "connected");
}
