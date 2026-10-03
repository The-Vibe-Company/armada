"use client";

// One session in flight as a card of the overview's board (THE-968), on the
// page kit's Card: j/k and Enter move through it like a row, and it opens the
// session's page. Its ticket, the time since its last report (with the live
// herdr state, THE-946), its title, its state when it is not simply at work
// and no badge says it, its harness and its badges (THE-988): "To validate"
// when the owner has something to validate on it, "Blocked", "Silent", "Plan
// to approve", "Ready to merge" (lib/coordinator-view.ts). Airy density adds
// the worker's last line. `MergedCard` is a ticket of the Merged column.
import type { FleetRow, MergedTicket } from "@armada/core/read";
import type { CardBadge } from "@/lib/coordinator-view";
import { agentState, harnessOf, paths, type StatusReason } from "@/lib/fleet-view";
import { LONGEST_TIMES } from "@/lib/i18n";
import { Card } from "../page";
import { useShell } from "../shell/context";
import { stateLabel } from "../shell/labels";
import { HarnessBadge, PhasePill, RelativeTime, StatusDot, Steady, type Tone, toneColor } from "../ui";
import { rowLine, rowProgress, useFresh } from "./AgentRow";

const BADGE_TONE = {
  validate: "waiting",
  blocked: "error",
  silent: "silent",
  approval: "neutral",
  ready: "done",
} as const satisfies Record<CardBadge, Tone>;

/** The states a badge already says: the card's state line leaves them to it. */
const SAID: Partial<Record<StatusReason, CardBadge>> = {
  question: "blocked",
  blocked: "blocked",
  silent: "silent",
  approval: "approval",
  ready: "ready",
};

export function SessionCard({
  row: r,
  airy = false,
  badges = [],
}: {
  row: FleetRow;
  airy?: boolean;
  /** Its badges, most urgent first. */
  badges?: readonly CardBadge[];
}) {
  const { t } = useShell();
  const state = agentState(r);
  const label = stateLabel(t, state, r.phase);
  const said = SAID[state.reason];
  const fresh = useFresh(r.lastReport);
  const line = airy ? rowLine(r) : "";
  return (
    <Card href={paths.agent(r.id)} className={fresh ? "ov-card is-fresh" : "ov-card"}>
      <span className="ov-card-head">
        <StatusDot status={state.status} progress={rowProgress(r)} size={12} label={label} />
        <span className="ov-card-id">{r.id}</span>
        <span className="ov-card-ago" style={{ color: r.silent ? "var(--active)" : undefined }}>
          <span className="sr-only">{t.shell.lastReport} </span>
          {r.lastReport ? (
            <Steady widest={LONGEST_TIMES.map((n) => t.duration(n))}>
              <RelativeTime at={r.lastReport} format="duration" />
            </Steady>
          ) : (
            t.shell.neverReported
          )}
          {r.runtimeState && <> · {t.shell.runtimeState[r.runtimeState]}</>}
        </span>
      </span>
      <span className="ov-card-title">{r.title}</span>
      {line && (
        <span className="ov-card-line" style={{ color: r.question ? "var(--accent)" : undefined }}>
          {line}
        </span>
      )}
      {state.status !== "running" && !(said && badges.includes(said)) && (
        <span className="ov-card-state" style={{ color: toneColor(state.status) }} aria-hidden>
          {label}
        </span>
      )}
      <span className="ov-card-foot">
        <HarnessBadge harness={harnessOf(r.runtime)} />
        {badges.length > 0 && (
          <span className="ov-card-badges">
            {badges.map((b) => (
              <PhasePill key={b} tone={BADGE_TONE[b]}>
                {t.overview.badges[b]}
              </PhasePill>
            ))}
          </span>
        )}
      </span>
    </Card>
  );
}

/** A merged ticket of the Merged column, on one line: its id, its title, how long ago it merged; it opens its pull request. */
export function MergedCard({ ticket: m }: { ticket: MergedTicket }) {
  const { t } = useShell();
  return (
    <Card href={m.pr.url} prefetch={false} className="ov-card is-merged">
      <span className="ov-card-id">{m.id}</span>
      <span className="ov-card-title">
        {m.title}
        <span className="sr-only"> #{m.pr.number}</span>
      </span>
      <span className="ov-card-ago">
        <span className="sr-only">{t.overview.mergedAgo} </span>
        <Steady widest={LONGEST_TIMES.map((n) => t.duration(n))}>
          <RelativeTime at={m.mergedAt} format="duration" />
        </Steady>
      </span>
    </Card>
  );
}
