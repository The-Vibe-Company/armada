import {
  CheckCircle2Icon,
  ClockAlertIcon,
  GitPullRequestIcon,
  OctagonPauseIcon,
  RocketIcon,
  RotateCcwIcon,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { BoardRefresh, FleetRowActions, FleetRowMessage } from "@/components/fleet-board";
import { LinkPendingIcon } from "@/components/link-pending";
import { Empty, PageHeader } from "@/components/page-header";
import { OutcomeDetail, PreservationNotice } from "@/components/task-outcome";
import { Button } from "@/components/ui/button";
import { readBoard } from "@/lib/data/fleet";
import { requireViewer } from "@/lib/data/viewer";
import {
  ATTENTION_ORDER,
  ATTENTION_TITLES,
  type Attention,
  attentionLabel,
  type BoardView,
  elapsedText,
  type FleetRow,
  parseBoardView,
  preview,
} from "@/lib/fleet";
import { HARNESS_LABELS } from "@/lib/labels";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Fleet" };
export const dynamic = "force-dynamic";

/**
 * The fleet board (#743, #801): by default only what needs a decision (work ready to merge, blocked agents,
 * interrupted turns to resend, agents that stopped without an outcome, real failures and unfinished work about to
 * expire), then a quiet strip of the agents still working. "All" adds the acknowledged rows and the idle agents. The
 * Sandboxes list stays the inventory of every sandbox of the organization.
 */
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function FleetPage({ searchParams }: Props) {
  const view = parseBoardView((await searchParams).view);
  const viewer = await requireViewer();
  const now = new Date();
  const board = await readBoard(await createClient(), viewer, now);
  const working = board.working.length;

  return (
    <>
      <PageHeader
        title="Fleet"
        description="What needs a decision from you: work ready to merge, blocked agents, interrupted turns and real failures. Agents still at work are summarised below."
      >
        <BoardRefresh />
      </PageHeader>

      {board.all.length > 0 && <BoardSegments view={view} needed={board.needs.length} total={board.all.length} />}

      {!board.configured && board.all.length > 0 && (
        <p className="text-sm text-muted-foreground" role="status">
          The Armada server is not configured for this dashboard: states come from the sandbox status alone, and prompts
          cannot be sent from here.
        </p>
      )}

      {board.all.length === 0 ? (
        <Empty
          title="No agents on the board"
          action={
            <Button asChild>
              <Link href="/goldens">
                <LinkPendingIcon>
                  <RocketIcon />
                </LinkPendingIcon>
                Launch a sandbox
              </Link>
            </Button>
          }
        >
          The board shows live agents and the ended ones that still hold something for you. Every sandbox of the
          organization is on the{" "}
          <Link href="/sandboxes" className="underline">
            Sandboxes
          </Link>{" "}
          page.
        </Empty>
      ) : view === "all" ? (
        <section aria-label="Agents" className="space-y-3">
          <Capped capped={board.capped} />
          <ul className="space-y-3">
            {board.all.map((row) => (
              <BoardRow key={row.id} row={row} configured={board.configured} />
            ))}
          </ul>
        </section>
      ) : (
        <>
          {board.needs.length === 0 ? (
            <div
              data-nothing-needed
              className="flex items-center gap-3 rounded-xl border bg-card p-4 text-sm shadow-xs"
              role="status"
            >
              <CheckCircle2Icon aria-hidden="true" className="size-5 shrink-0 text-success" />
              <p>
                <span className="font-medium">Nothing needs you.</span>{" "}
                <span className="text-muted-foreground">
                  {working} {working === 1 ? "agent" : "agents"} working.
                </span>
              </p>
            </div>
          ) : (
            ATTENTION_ORDER.map((attention) => {
              const rows = board.needs.filter((row) => row.attention === attention);
              return rows.length ? (
                <NeedsSection key={attention} attention={attention} rows={rows} configured={board.configured} />
              ) : null;
            })
          )}
          {working > 0 && <WorkingStrip rows={board.working} now={now} />}
          <Capped capped={board.capped} />
        </>
      )}
    </>
  );
}

function Capped({ capped }: { capped: boolean }) {
  if (!capped) return null;
  return (
    <p className="text-sm text-muted-foreground">
      Only the most recent sandboxes are read; the rest are on the{" "}
      <Link href="/sandboxes" className="underline">
        Sandboxes
      </Link>{" "}
      page.
    </p>
  );
}

function NeedsSection({
  attention,
  rows,
  configured,
}: {
  attention: Attention;
  rows: FleetRow[];
  configured: boolean;
}) {
  const id = `needs-${attention}`;
  return (
    <section aria-labelledby={id} data-needs={attention} className="space-y-3">
      <h2 id={id} className="flex items-baseline gap-2 text-base font-semibold">
        {ATTENTION_TITLES[attention]}
        <span className="text-sm font-normal tabular-nums text-muted-foreground">{rows.length}</span>
      </h2>
      <ul className="space-y-3">
        {rows.map((row) => (
          <BoardRow key={row.id} row={row} configured={configured} />
        ))}
      </ul>
    </section>
  );
}

/** One quiet line per live agent at work: what it is on, what it is doing, for how long. */
function WorkingStrip({ rows, now }: { rows: FleetRow[]; now: Date }) {
  return (
    <section aria-labelledby="working" data-working className="space-y-2">
      <h2 id="working" className="flex items-baseline gap-2 text-sm font-semibold text-muted-foreground">
        Working
        <span className="font-normal tabular-nums">({rows.length})</span>
      </h2>
      <ul className="divide-y rounded-xl border bg-card text-sm shadow-xs">
        {rows.map((row) => {
          const doing = row.activity ?? (row.message ? preview(row.message, 120).text : row.state.label);
          return (
            <li
              key={row.id}
              data-working-row={row.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5"
            >
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-info motion-reduce:animate-none"
              />
              <Link
                href={`/sandboxes/${row.id}`}
                className="min-w-0 font-medium underline-offset-4 hover:underline"
                aria-label={`Open the conversation of ${row.name}`}
              >
                {row.workItem?.label ?? <span className="font-mono">{row.name}</span>}
              </Link>
              <span className="min-w-0 flex-1 truncate text-muted-foreground" title={doing}>
                {doing}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground" data-elapsed>
                {elapsedText(row.since, now)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function BoardRow({ row, configured }: { row: FleetRow; configured: boolean }) {
  const facts = [
    row.golden,
    HARNESS_LABELS[row.harness] ?? row.harness,
    row.model,
    row.repository,
    row.mine ? null : "another member's",
    row.replaced > 0 ? `replaces ${row.replaced} earlier ${row.replaced === 1 ? "run" : "runs"}` : null,
  ].filter((fact): fact is string => Boolean(fact));
  const tone = row.dismissed ? null : row.attention;
  return (
    <li
      data-board-row={row.id}
      data-state={row.state.kind}
      data-attention={row.attention ?? "none"}
      data-dismissed={row.dismissed ? "" : undefined}
      className={cn(
        "space-y-3 rounded-xl border bg-card p-4 text-card-foreground shadow-xs",
        tone === "failed" && "border-destructive/40",
        tone === "blocked" && "border-warning/40",
        tone === "ready" && "border-success/40",
        row.dismissed && "opacity-75",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            {row.workItem &&
              (row.workItem.href ? (
                <a
                  href={row.workItem.href}
                  target="_blank"
                  rel="noreferrer"
                  data-work-item
                  className="text-sm font-semibold underline-offset-4 hover:underline"
                >
                  {row.workItem.label}
                </a>
              ) : (
                <span data-work-item className="text-sm font-semibold">
                  {row.workItem.label}
                </span>
              ))}
            <Link
              href={`/sandboxes/${row.id}`}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 font-mono underline-offset-4 hover:underline",
                row.workItem ? "text-xs text-muted-foreground" : "text-sm font-medium",
              )}
            >
              <span className="truncate" title={row.name}>
                {row.name}
              </span>
              <LinkPendingIcon />
            </Link>
          </div>
          <p className="text-xs break-words text-muted-foreground">{facts.join(" · ")}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {row.dismissed && <span className="text-xs text-muted-foreground">Dismissed</span>}
          <StateBadge row={row} />
          {row.expiry && (
            <span
              data-expiry={row.expiry.urgent ? "urgent" : "normal"}
              className={cn(
                "rounded-md px-1.5 py-0.5 text-xs tabular-nums",
                row.expiry.urgent ? "bg-warning/15 font-medium text-warning" : "text-muted-foreground",
              )}
            >
              {row.expiry.urgent && (
                <>
                  <ClockAlertIcon aria-hidden="true" className="mr-1 inline size-3 align-[-1px]" />
                  <span className="sr-only">Expires soon: </span>
                </>
              )}
              {row.expiry.text}
            </span>
          )}
        </div>
      </div>

      {row.state.outcome && <OutcomeDetail outcome={row.state.outcome} />}

      {row.preservation && <PreservationNotice preservation={row.preservation} />}

      {row.state.failure && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm" data-failure>
          <p className="font-medium text-destructive">{row.state.failure.title}</p>
          {row.state.failure.hint && <p className="mt-1 text-muted-foreground">{row.state.failure.hint}</p>}
          {row.state.failure.fix && (
            <Link
              href={row.state.failure.fix.href}
              className="mt-1 inline-block font-medium underline underline-offset-4"
            >
              {row.state.failure.fix.label}
            </Link>
          )}
        </div>
      )}

      {row.state.kind === "interrupted" && (
        <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground" data-interruption>
          {row.state.interruption ?? "The turn was interrupted."}{" "}
          {row.resend ? "Resending the same prompt picks the work up." : null}
        </p>
      )}

      <FleetRowMessage message={row.message} eventsRead={row.eventsRead} />

      <FleetRowActions
        sandboxId={row.id}
        name={row.name}
        status={row.status}
        configured={configured}
        busy={row.state.kind === "working"}
        attention={row.attention}
        resend={row.resend}
        ackKey={row.ackKey}
        dismissed={row.dismissed}
      />
    </li>
  );
}

/** What needs the operator, or every agent; a link each, so the choice lives in the URL. */
function BoardSegments({ view, needed, total }: { view: BoardView; needed: number; total: number }) {
  const segments: { view: BoardView; href: string; label: string; count: number }[] = [
    { view: "needs-you", href: "/fleet", label: "Needs you", count: needed },
    { view: "all", href: "/fleet?view=all", label: "All", count: total },
  ];
  return (
    <nav aria-label="Board view" className="inline-flex w-fit rounded-lg border bg-muted/40 p-0.5 text-sm">
      {segments.map((segment) => (
        <Link
          key={segment.view}
          href={segment.href}
          aria-current={segment.view === view ? "page" : undefined}
          className={cn(
            "inline-flex min-h-8 items-center gap-1.5 rounded-md px-3 font-medium text-muted-foreground transition-colors hover:text-foreground",
            segment.view === view && "bg-background text-foreground shadow-xs",
          )}
        >
          {segment.label}
          <span className="text-xs tabular-nums text-muted-foreground">{segment.count}</span>
        </Link>
      ))}
    </nav>
  );
}

const ATTENTION_TONES: Record<Attention, string> = {
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  blocked: "border-warning/40 bg-warning/10 text-warning",
  ready: "border-success/40 bg-success/15 text-success",
  interrupted: "text-foreground",
  unconcluded: "text-foreground",
  expiring: "border-warning/40 bg-warning/10 text-warning",
};

/** What the row needs, or, when it needs nothing, the state it is in. */
function StateBadge({ row }: { row: FleetRow }) {
  const working = row.state.kind === "working";
  const label = row.attention ? attentionLabel(row.attention, row.status) : row.state.label;
  return (
    <span
      data-board-state={row.state.kind}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        row.attention ? ATTENTION_TONES[row.attention] : working ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {working && (
        <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-info motion-reduce:animate-none" />
      )}
      {row.attention === "ready" && <GitPullRequestIcon aria-hidden="true" className="size-3" />}
      {row.attention === "blocked" && <OctagonPauseIcon aria-hidden="true" className="size-3" />}
      {row.attention === "interrupted" && <RotateCcwIcon aria-hidden="true" className="size-3" />}
      {label}
    </span>
  );
}
