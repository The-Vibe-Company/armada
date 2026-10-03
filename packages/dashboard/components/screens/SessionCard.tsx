"use client";

// One session in flight as a card of the overview's board (THE-968), on the
// page kit's Card: j/k and Enter move through it like a row, and it opens the
// session's page. Its ticket, the time since its last report (with the live
// herdr state, THE-946), its title, its state when it is not simply at work,
// its harness and "To validate" when the owner has something to validate on
// it (lib/coordinator-view.ts). Airy density adds the worker's last line.
import type { FleetRow } from "@armada/core/read";
import { agentState, harnessOf, paths } from "@/lib/fleet-view";
import { LONGEST_TIMES } from "@/lib/i18n";
import { Card } from "../page";
import { useShell } from "../shell/context";
import { stateLabel } from "../shell/labels";
import { HarnessBadge, PhasePill, RelativeTime, StatusDot, Steady, toneColor } from "../ui";
import { rowLine, rowProgress, useFresh } from "./AgentRow";

export function SessionCard({
  row: r,
  airy = false,
  toValidate = false,
}: {
  row: FleetRow;
  airy?: boolean;
  /** The owner has something to validate on it. */
  toValidate?: boolean;
}) {
  const { t } = useShell();
  const state = agentState(r);
  const label = stateLabel(t, state, r.phase);
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
      {state.status !== "running" && (
        <span className="ov-card-state" style={{ color: toneColor(state.status) }} aria-hidden>
          {label}
        </span>
      )}
      <span className="ov-card-foot">
        <HarnessBadge harness={harnessOf(r.runtime)} />
        {toValidate && <PhasePill tone="waiting">{t.overview.toValidateBadge}</PhasePill>}
      </span>
    </Card>
  );
}
