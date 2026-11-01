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

/** A Merge asked of the coordinator, held as "Merging…" until it is answered. */
export interface MergeHold {
  pr: number;
  /** The conversation's "Merge #N" messages when it was sent: the one it sends is the next. */
  earlier: ReadonlySet<string>;
}

/** A line of the conversation, as far as Merge reads it. */
type ChatLine = Pick<ChatItem, "kind" | "id"> & { body?: string };

/** What the room sees after a Merge was sent. */
export interface MergeSight {
  open: ReadonlySet<number>;
  /** The conversation as the room shows it: a message sent is in it from its Send, before the coordinator places it. */
  items: readonly ChatLine[];
  /** The coordinator's turn; null on a daemon without a live turn. */
  turn: Pick<ChatTurn, "state"> | null;
}

/** The ids of the conversation's messages asking to merge `pr`. */
export const mergeAsks = (items: MergeSight["items"], pr: number) =>
  new Set(items.flatMap((i) => (i.kind === "owner" && i.body === mergeMessage(pr) ? [i.id] : [])));

/**
 * The hold after what the room sees: gone once the pull request is no longer
 * open (merged); else once the coordinator answered the message it sent (a
 * line or a call after it) and its turn is over (refused, or merged before the
 * fold reads it). Held while the message is not in the conversation yet. Tied
 * to the message, not to a turn's frames: a frame missed or a turn ending
 * before it does not release it, nor keep it.
 */
export function stepHold(hold: MergeHold, sight: MergeSight): MergeHold | null {
  if (!sight.open.has(hold.pr)) return null;
  const ask = sight.items.findLastIndex(
    (i) => i.kind === "owner" && i.body === mergeMessage(hold.pr) && !hold.earlier.has(i.id),
  );
  if (ask < 0) return hold;
  const answered = sight.items.slice(ask + 1).some((i) => i.kind !== "owner");
  return answered && (sight.turn === null || sight.turn.state === "idle") ? null : hold;
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
