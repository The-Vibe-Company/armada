// The panel's Pull requests (THE-2085, THE-2086), after T3 Code's pull request
// rows (`PullRequestListRow.tsx`, `PullRequestChecksPopover.tsx`,
// `ThreadDetailsPrRow.tsx`): the open pull requests of the tickets in flight,
// Ready first. A row is its number, its title, its ticket (its agent's page),
// its head, its checks as one strip (a dot each, opening its run), what its
// review asks and its state on a dot; the row opens the pull request on
// GitHub, through the desktop shell's bridge. Merge, on a Ready row, asks the
// coordinator in the chat ("Merge #374"): its guards (`merge.check`,
// `merge.run`) stay the only path, and the thread streams what it does.
import type { ChatItem, ChatTurn } from "@armada/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TONE } from "@/components/fleet/FleetList";
import { Button } from "@/components/ui/button";
import type { FoldedCheck } from "@/fleet/state";
import { openExternal } from "@/lib/external";
import { settingsHref } from "@/lib/route";
import { cn } from "@/lib/utils";
import {
  checkHref,
  type MergeHold,
  mergeAsks,
  mergeMessage,
  type OpenPullRequest,
  type PullRequestWord,
  pullRequestHref,
  shortSha,
  stepHold,
  WORDS,
} from "./pr-rules";

const WORD_DOT: Record<PullRequestWord, string> = {
  ready: TONE.ready.bg,
  red: TONE.blocked.bg,
  running: TONE.running.bg,
  conflicts: TONE.blocked.bg,
  draft: TONE.merged.bg,
  passed: TONE.merged.bg,
  none: TONE.merged.bg,
};

const CHECK: Record<FoldedCheck["state"], { words: string; dot: string }> = {
  success: { words: "passed", dot: "bg-green" },
  failure: { words: "failed", dot: "bg-red" },
  pending: { words: "running", dot: "border-[1.5px] border-blue" },
  none: { words: "no result", dot: "bg-merged" },
};

/** Opens a page of GitHub in the system browser rather than in the app. */
const external = (url: string) => (e: { preventDefault(): void; stopPropagation(): void }) => {
  e.preventDefault();
  e.stopPropagation();
  openExternal(url);
};

export interface Merging {
  /** The pull requests whose Merge waits for the coordinator. */
  held: ReadonlySet<number>;
  /** Why a Merge could not be sent. */
  problem: { pr: number; text: string } | null;
  merge(pr: number): void;
}

/**
 * Merge's hold, kept by the room so it survives a change of tab: "Merging…"
 * from the message until the pull request leaves the open ones, or the
 * coordinator answered it and its turn is over.
 */
export function useMerging({
  prs,
  send,
  turn,
  items,
}: {
  prs: readonly OpenPullRequest[];
  send: (body: string) => Promise<void>;
  /** The coordinator's turn; null on a daemon without a live turn. */
  turn: ChatTurn | null;
  items: readonly ChatItem[];
}): Merging {
  const [holds, setHolds] = useState<readonly MergeHold[]>([]);
  const [problem, setProblem] = useState<Merging["problem"]>(null);
  const open = useMemo(() => new Set(prs.map((p) => p.number)), [prs]);
  const state = turn?.state ?? null;
  // A released hold is dropped: a later turn of the coordinator does not hold the row again.
  useEffect(() => {
    const sight = { open, items, turn: state === null ? null : { state } };
    setHolds((held) => {
      const next = held.flatMap((h) => stepHold(h, sight) ?? []);
      return next.length === held.length ? held : next;
    });
  }, [open, items, state]);
  const merge = useCallback(
    (pr: number) => {
      const hold: MergeHold = { pr, earlier: mergeAsks(items, pr) };
      setProblem(null);
      setHolds((held) => [...held.filter((h) => h.pr !== pr), hold]);
      send(mergeMessage(pr)).catch((error: unknown) => {
        setHolds((held) => held.filter((h) => h !== hold));
        setProblem({ pr, text: error instanceof Error ? error.message : "Could not ask the coordinator" });
      });
    },
    [send, items],
  );
  const held = useMemo(() => new Set(holds.map((h) => h.pr)), [holds]);
  return { held, problem, merge };
}

export function PullRequests({
  prs,
  repository,
  reads = true,
  merging,
  canMerge = true,
  ticketHref,
  onOpen,
}: {
  prs: readonly OpenPullRequest[];
  repository: string;
  /** Whether a forge reads the pull requests: when none is connected, the tab says where to connect one. */
  reads?: boolean;
  merging?: Merging;
  /** Whether the coordinator can take a message now. */
  canMerge?: boolean;
  /** Where a ticket's id leads: its agent's page. */
  ticketHref: (ticket: string) => string;
  /** A ticket's id followed: the sheet closes over its agent's page. */
  onOpen?: () => void;
}) {
  const connect = !reads && (
    <p className="m-0 border-line border-b px-4 py-3 text-body text-text-2" data-forge="disconnected">
      <a href={settingsHref("providers")} className="text-text underline decoration-current/40 underline-offset-2">
        Connect GitHub in Settings
      </a>{" "}
      to read pull requests
    </p>
  );
  if (!prs.length) return connect || <p className="m-0 px-4 py-3 text-body text-text-3">No open pull request</p>;
  return (
    <>
      {connect}
      <ul aria-label="Open pull requests" className="m-0 list-none p-0 pb-2">
        {prs.map((p) => (
          <Row
            key={p.number}
            pr={p}
            repository={repository}
            ticketHref={ticketHref}
            onOpen={onOpen}
            merging={merging}
            canMerge={canMerge}
          />
        ))}
      </ul>
    </>
  );
}

function Row({
  pr: p,
  repository,
  ticketHref,
  onOpen,
  merging,
  canMerge,
}: {
  pr: OpenPullRequest;
  repository: string;
  ticketHref: (ticket: string) => string;
  onOpen?: () => void;
  merging?: Merging;
  canMerge: boolean;
}) {
  const href = pullRequestHref(p, repository);
  const held = merging?.held.has(p.number) ?? false;
  const problem = merging?.problem?.pr === p.number ? merging.problem.text : null;
  const threads = p.reviewThreads?.unresolved ?? 0;
  const review =
    threads > 0
      ? `${threads} thread${threads > 1 ? "s" : ""}`
      : p.review === "changes_requested"
        ? "Changes requested"
        : null;
  const sha = shortSha(p.head);
  return (
    <li
      data-pr-row={p.number}
      data-word={p.word}
      className="relative flex flex-col gap-0.5 border-line border-b px-4 py-2 hover:bg-panel-3"
    >
      <span className="flex min-w-0 items-center gap-2">
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          onClick={external(href)}
          title={`Open #${p.number} on GitHub`}
          className="flex min-w-0 flex-1 items-baseline gap-2 outline-none after:absolute after:inset-0 focus-visible:after:shadow-[inset_0_0_0_2px_var(--color-blue)]"
        >
          <span className="flex-none font-mono text-meta text-text">#{p.number}</span>
          <span className="min-w-0 truncate text-sub text-text">{p.title}</span>
        </a>
        {p.word === "ready" && merging && (
          <Button
            variant="primary"
            className="relative z-10 h-6.5 flex-none px-2.5"
            disabled={held || !canMerge}
            onClick={() => merging.merge(p.number)}
            data-merge={p.number}
          >
            {held ? "Merging…" : "Merge"}
          </Button>
        )}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-body text-text-2">
        <a
          href={ticketHref(p.ticket)}
          onClick={onOpen}
          className="relative z-10 flex-none font-mono text-meta text-text-2 hover:text-text"
        >
          {p.ticket}
        </a>
        {sha && (
          <span className="flex-none font-mono text-meta text-text-3" title={p.head}>
            {sha}
          </span>
        )}
        {p.checks && p.checks.length > 0 && (
          <ul
            aria-label="Checks"
            className="relative z-10 m-0 flex list-none flex-wrap items-center p-0"
            data-checks-strip
          >
            {p.checks.map((c, k) => {
              const check = CHECK[c.state];
              const label = `${c.name}: ${check.words}`;
              const url = checkHref(c, p, repository);
              return (
                // Two checks may share a name across workflow runs.
                // biome-ignore lint/suspicious/noArrayIndexKey: the fold's order is stable for one head.
                <li key={`${c.name}-${k}`} className="flex">
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={external(url)}
                    title={label}
                    data-check={c.state}
                    className="inline-flex size-3.5 items-center justify-center rounded-full outline-none focus-visible:shadow-[0_0_0_2px_var(--color-blue)]"
                  >
                    <span aria-hidden className={cn("size-1.75 rounded-full", check.dot)} />
                    <span className="sr-only">{label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        <span className="inline-flex min-w-0 items-center gap-1.5" data-state={p.word}>
          <span aria-hidden className={cn("size-1.75 rounded-full", WORD_DOT[p.word])} />
          {WORDS[p.word]}
          {p.word === "red" && <FailingName checks={p.checks} />}
        </span>
        {review && <span className="flex-none text-amber">{review}</span>}
      </div>
      {problem && (
        <p role="alert" className="m-0 text-body text-amber">
          {problem}
        </p>
      )}
    </li>
  );
}

/** The first failing check's name, beside Red CI. */
function FailingName({ checks }: { checks: OpenPullRequest["checks"] }) {
  const failing = checks?.filter((c) => c.state === "failure") ?? [];
  const first = failing[0];
  if (!first) return null;
  return (
    <span className="min-w-0 truncate text-red">
      · {first.name}
      {failing.length > 1 ? ` +${failing.length - 1}` : ""}
    </span>
  );
}
