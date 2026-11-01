import type { EventInput, FleetEvent } from "@armada/protocol";
import { formatTokens, usageTime } from "@armada/protocol/usage";
import { fold } from "./fold.ts";

/** Pure decision: the only proposed effects are ordinary holds and owner requests.
 * Historical identities survive clears/restarts, so an owner's exception lasts for that ceiling and period.
 */
export function evaluateBudget({
  project,
  events,
  now,
}: {
  project: string;
  events: readonly FleetEvent[];
  now: string;
}): EventInput[] {
  const own = events.filter((e) => e.project === project);
  const tables = fold(own).projects[project];
  const budget = tables?.rules?.value.policy?.budget;
  if (!budget || !tables) return [];
  const time = usageTime(now, budget.zone);
  const checks: { key: string; used: number; cap: number; unit: string; period: string; unknown?: number }[] = [];
  if (budget.coordinatorTokensPerDay !== undefined) {
    const day = tables.usage?.days.find((d) => d.day === time.day)?.coordinator;
    const used = (day?.input ?? 0) + (day?.output ?? 0) + (day?.cacheRead ?? 0) + (day?.cacheWrite ?? 0);
    checks.push({
      key: "coordinator",
      used,
      cap: budget.coordinatorTokensPerDay,
      unit: "tokens today",
      period: time.day,
      unknown: day?.unknown,
    });
  }
  const start = budget.nightStart ?? "22:00";
  const end = budget.nightEnd ?? "07:00";
  const inNight = start > end ? time.minute >= start || time.minute < end : time.minute >= start && time.minute < end;
  if (budget.workerLaunchesPerNight !== undefined && inNight) {
    // Civil-date arithmetic only; subtracting 24h from an instant is wrong at DST boundaries.
    const previousDay = (day: string) =>
      new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const period = start > end && time.minute < end ? previousDay(time.day) : time.day;
    const launches = (tables.usage?.sessions ?? []).filter((s) => {
      if (s.kind !== "worker" || !s.launchedAt) return false;
      const launched = usageTime(s.launchedAt, budget.zone);
      const night = start > end && launched.minute < end ? previousDay(launched.day) : launched.day;
      const inside =
        start > end
          ? launched.minute >= start || launched.minute < end
          : launched.minute >= start && launched.minute < end;
      return inside && night === period;
    }).length;
    checks.push({
      key: "launches",
      used: launches,
      cap: budget.workerLaunchesPerNight,
      unit: "worker launches tonight",
      period,
    });
  }
  const effects: EventInput[] = [];
  for (const check of checks) {
    if (check.used < check.cap && !check.unknown) continue;
    const window = check.key === "launches" ? `${start}:${end}:` : "";
    const id = `budget:${check.key}:${budget.zone}:${window}${check.period}:${check.cap}`;
    const reason = check.unknown
      ? `budget: coordinator usage unknown for ${check.unknown} completed turns; cannot verify the ${formatTokens(check.cap)} daily ceiling`
      : `budget: ${formatTokens(check.used)} ${check.unit} reached the ${formatTokens(check.cap)} limit`;
    const base = { project, at: now, actor: "daemon" };
    if (!own.some((e) => e.kind === "hold.opened" && e.payload.id === id))
      effects.push({ ...base, kind: "hold.opened", payload: { id, reason } });
    if (!own.some((e) => e.kind === "inbox.opened" && e.payload.id === id))
      effects.push({
        ...base,
        kind: "inbox.opened",
        payload: {
          id,
          ticket: project,
          kind: "owner-request",
          body: check.unknown
            ? `Coordinator usage is unknown for ${check.unknown} completed turns. Confirm an exception with a reason, or keep the fleet paused while the daily ceiling cannot be verified.`
            : `Budget reached: ${formatTokens(check.used)} ${check.unit}. Raise to ${formatTokens(Math.min(Number.MAX_SAFE_INTEGER, Math.max(check.cap * 2, 1)))}, or keep the fleet paused until morning? Only the owner may raise this budget or clear its hold with a reason.`,
        },
      });
  }
  return effects;
}
