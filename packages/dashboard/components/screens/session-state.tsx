"use client";

// A session's state as every screen draws it (THE-1020): its color, where
// its row opens and its six-step bar. Apart from OverviewScreen so a
// session's page and the overview's pane do not ship the whole overview on
// first load (THE-1177).
import type { OverviewItem, SessionGroup } from "@/lib/coordinator-view";
import { paths } from "@/lib/fleet-view";
import { useShell } from "../shell/context";

/** Each state's color: a dot, its group's header, its reason. */
export const GROUP_COLOR: Record<SessionGroup, string> = {
  blocked: "var(--red)",
  you: "var(--amber)",
  running: "var(--blue)",
  ready: "var(--green)",
  merged: "var(--text-3)",
};

export const itemColor = (item: Pick<OverviewItem, "group" | "reason">) =>
  item.reason.kind === "runtime" && item.reason.state === "gone" ? "var(--text-3)" : GROUP_COLOR[item.group];

/** Where a row opens: its session's page, else (merged earlier today) its pull request. */
export const itemHref = (i: OverviewItem) => (i.row || !i.pr ? paths.agent(i.id) : i.pr.url);

/** The six steps, the done ones grey, the one at work in its state's color. */
export function StepBar({ step, color, wide = false }: { step: number; color: string; wide?: boolean }) {
  const { t } = useShell();
  const steps = t.overview.steps;
  const label = steps[Math.min(step, steps.length - 1)] ?? "";
  return (
    <span className={wide ? "ov-steps is-wide" : "ov-steps"} role="img" aria-label={t.overview.stepLabel(label)}>
      {steps.map((s, k) => (
        <span key={s} style={{ background: k < step ? "var(--step-done)" : k === step ? color : "var(--step-next)" }} />
      ))}
    </span>
  );
}
