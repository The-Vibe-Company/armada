import { RocketIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { BoardRefresh, FleetRowActions, FleetRowMessage } from "@/components/fleet-board";
import { LinkPendingIcon } from "@/components/link-pending";
import { Empty, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { readBoard } from "@/lib/data/fleet";
import { requireViewer } from "@/lib/data/viewer";
import { type BoardStateKind, type FleetRow, sortBoard } from "@/lib/fleet";
import { HARNESS_LABELS } from "@/lib/labels";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Fleet" };
export const dynamic = "force-dynamic";

/**
 * The fleet board (#743): the sandboxes the viewer may open, what each agent is doing, and what needs the operator
 * first. The Sandboxes list stays the inventory of every sandbox of the organization, filtered and paged; this page
 * reads each row's events, so it keeps to the recent ones the viewer can act on.
 */
export default async function FleetPage() {
  const viewer = await requireViewer();
  const now = new Date();
  const board = await readBoard(await createClient(), viewer, now);
  const rows = sortBoard(board.rows);
  const waiting = rows.filter((row) => row.state.kind !== "working" && row.state.kind !== "stopped").length;

  return (
    <>
      <PageHeader
        title="Fleet"
        description="Every agent you can open, what it is doing, and what needs you first: failures, finished turns, then sandboxes about to expire."
      >
        <BoardRefresh />
      </PageHeader>

      {!board.configured && rows.length > 0 && (
        <p className="text-sm text-muted-foreground" role="status">
          The Armada server is not configured for this dashboard: states come from the sandbox status alone, and prompts
          cannot be sent from here.
        </p>
      )}

      {rows.length === 0 ? (
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
          The board shows the sandboxes you can open that are live, failed, or stopped in the last day. Every sandbox of
          the organization is on the{" "}
          <Link href="/sandboxes" className="underline">
            Sandboxes
          </Link>{" "}
          page.
        </Empty>
      ) : (
        <section aria-label="Agents" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {waiting === 0
              ? "Nothing waits for you."
              : `${waiting} ${waiting === 1 ? "agent needs" : "agents need"} you.`}{" "}
            {board.capped && (
              <>
                Only the most recent are shown; the rest are on the{" "}
                <Link href="/sandboxes" className="underline">
                  Sandboxes
                </Link>{" "}
                page.
              </>
            )}
          </p>
          <ul className="space-y-3">
            {rows.map((row) => (
              <BoardRow key={row.id} row={row} configured={board.configured} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function BoardRow({ row, configured }: { row: FleetRow; configured: boolean }) {
  const facts = [
    row.golden,
    HARNESS_LABELS[row.harness] ?? row.harness,
    row.model,
    row.repository,
    row.mine ? null : "another member's",
  ].filter((fact): fact is string => Boolean(fact));
  return (
    <li
      data-board-row={row.id}
      data-state={row.state.kind}
      className={cn(
        "space-y-3 rounded-lg border bg-card p-4 text-card-foreground shadow-xs",
        row.state.kind === "failed" && "border-destructive/40",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 space-y-1">
          <Link
            href={`/sandboxes/${row.id}`}
            className="inline-flex max-w-full items-center gap-1.5 font-mono text-sm font-medium underline-offset-4 hover:underline"
          >
            <span className="truncate" title={row.name}>
              {row.name}
            </span>
            <LinkPendingIcon />
          </Link>
          <p className="text-xs break-words text-muted-foreground">{facts.join(" · ")}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <StateBadge kind={row.state.kind} label={row.state.label} />
          {row.expiry && (
            <span
              data-expiry={row.expiry.urgent ? "urgent" : "normal"}
              className={cn(
                "rounded-md px-1.5 py-0.5 text-xs tabular-nums",
                row.expiry.urgent ? "bg-warning/15 font-medium text-warning" : "text-muted-foreground",
              )}
            >
              {row.expiry.text}
            </span>
          )}
        </div>
      </div>

      {row.state.failure && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm" data-failure>
          <p className="font-medium text-destructive">{row.state.failure.title}</p>
          {row.state.failure.hint && <p className="mt-1 text-muted-foreground">{row.state.failure.hint}</p>}
        </div>
      )}

      <FleetRowMessage message={row.message} eventsRead={row.eventsRead} />

      <FleetRowActions
        sandboxId={row.id}
        name={row.name}
        status={row.status}
        configured={configured}
        busy={row.state.kind === "working"}
      />
    </li>
  );
}

const STATE_TONES: Record<BoardStateKind, string> = {
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  finished: "border-success/40 bg-success/10 text-success",
  interrupted: "border-warning/40 bg-warning/10 text-warning",
  idle: "border-warning/40 bg-warning/10 text-warning",
  working: "text-foreground",
  stopped: "text-muted-foreground",
};

function StateBadge({ kind, label }: { kind: BoardStateKind; label: string }) {
  return (
    <span
      data-board-state={kind}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        STATE_TONES[kind],
      )}
    >
      {kind === "working" && (
        <span
          aria-hidden="true"
          className="size-1.5 animate-pulse rounded-full bg-success motion-reduce:animate-none"
        />
      )}
      {label}
    </span>
  );
}
