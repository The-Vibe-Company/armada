import type { FleetEvent, ProjectRules, Session } from "@armada/protocol";

export type Report = Extract<FleetEvent, { kind: "session.reported" }>;
export interface ProgressReason {
  code: "quiet-heartbeats" | "repeated-report" | "working-no-progress" | "red-checks";
  minutes: number;
  thresholdMinutes: number;
  count?: number;
}
export interface ProgressSignals {
  level: number;
  reasons: ProgressReason[];
  /** Sequence of the last material progress, not the last repeated report/heartbeat. */
  episode: number;
  nextAt: number;
}
const minute = 60_000;
const terminal = ["released", "merged", "blocked", "awaiting-approval", "awaiting-validation", "ready-to-merge"];

/** Pure, generation-scoped evidence. The observer log includes runtime and forge observations. */
export function progressSignals(
  session: Session,
  reports: readonly Report[],
  observations: readonly FleetEvent[],
  now: number,
  policy: ProjectRules["policy"] = {},
): ProgressSignals {
  const silence = policy?.silenceMinutes ?? 15;
  const quiet = policy?.quietMinutes ?? 45;
  const own = reports.filter((r) => r.payload.session === session.session && r.payload.ticket === session.ticket);
  const claim = observations.findLast(
    (e) =>
      e.kind === "session.claimed" &&
      e.payload.session === session.session &&
      e.payload.generation === session.generation,
  );
  const runtime = observations.findLast(
    (e) =>
      e.kind === "session.runtime-observed" &&
      e.payload.session === session.session &&
      e.payload.generation === session.generation,
  );
  const working =
    runtime?.kind === "session.runtime-observed" &&
    runtime.payload.state === "running" &&
    runtime.payload.activity === "working";
  const factor = working ? 2 : 1;
  const start = claim?.at ?? own[0]?.at ?? session.at;
  let episode = claim?.seq ?? 0;
  let progressAt = Date.parse(start);
  let phaseOrHeadAt = progressAt;
  let prior: Report | undefined;
  for (const report of own) {
    if (!prior || report.payload.phase !== prior.payload.phase) phaseOrHeadAt = Date.parse(report.at);
    if (
      !prior ||
      report.payload.phase !== prior.payload.phase ||
      report.payload.reason.trim() !== prior.payload.reason.trim()
    ) {
      episode = report.seq;
      progressAt = Date.parse(report.at);
    }
    prior = report;
  }
  let lastHead: string | undefined;
  let lastPr:
    | Extract<FleetEvent, { kind: "pull-request.seen" | "pull-request.head-moved" | "pull-request.checks-red" }>
    | undefined;
  let redAt: number | undefined;
  let redCount = 0;
  for (const e of observations) {
    if (
      !e.payload ||
      typeof e.payload !== "object" ||
      Array.isArray(e.payload) ||
      !("ticket" in e.payload) ||
      e.payload.ticket !== session.ticket ||
      !("head" in e.payload) ||
      !("ci" in e.payload) ||
      !("state" in e.payload) ||
      !e.kind.startsWith("pull-request.")
    )
      continue;
    const pr = e as NonNullable<typeof lastPr>;
    if (Date.parse(e.at) < Date.parse(start)) continue;
    if (pr.payload.head !== lastHead) {
      phaseOrHeadAt = Math.max(phaseOrHeadAt, Date.parse(e.at));
      if (e.seq > episode) {
        episode = e.seq;
        progressAt = Date.parse(e.at);
      }
      lastHead = pr.payload.head;
      redAt = undefined;
      redCount = 0;
    }
    if (pr.payload.ci === "failure" && pr.payload.state === "open") {
      redAt ??= Date.parse(pr.at);
      redCount++;
    } else {
      redAt = undefined;
      redCount = 0;
    }
    lastPr = pr;
  }
  const result: ProgressSignals = { level: 0, reasons: [], episode, nextAt: now + silence * minute };
  if (terminal.includes(session.phase) || session.runtime === "tracker") return result;
  const live =
    runtime?.kind === "session.runtime-observed" && ["stopped", "failed"].includes(runtime.payload.state)
      ? false
      : session.heartbeat !== null && now - Date.parse(session.heartbeat) <= silence * 2 * minute;
  if (!live) return result;
  const add = (code: ProgressReason["code"], since: number, threshold: number, count?: number) => {
    const due = since + threshold * minute;
    if (due > now) result.nextAt = Math.min(result.nextAt, due);
    if (now < due) return;
    result.reasons.push({
      code,
      minutes: Math.floor((now - since) / minute),
      thresholdMinutes: threshold,
      ...(count === undefined ? {} : { count }),
    });
    result.level = Math.max(result.level, 1 + Math.floor(Math.log2(Math.max(1, (now - since) / (threshold * minute)))));
  };
  const lastReport = own.at(-1);
  const lastReportAt = Math.max(Date.parse(lastReport?.at ?? start), progressAt);
  if (Date.parse(session.heartbeat ?? start) > lastReportAt) add("quiet-heartbeats", lastReportAt, quiet * factor);
  const last = own.at(-1);
  let count = 0;
  for (let i = own.length - 1; i >= 0; i--) {
    const r = own[i]!;
    if (
      r.seq < episode ||
      r.payload.phase !== last?.payload.phase ||
      r.payload.reason.trim() !== last?.payload.reason.trim()
    )
      break;
    count++;
  }
  if (count >= 3) {
    result.reasons.push({
      code: "repeated-report",
      count,
      minutes: Math.floor((now - progressAt) / minute),
      thresholdMinutes: silence * factor,
    });
    result.level = Math.max(result.level, 1 + Math.floor(Math.log2(count / 3)));
  }
  if (working) add("working-no-progress", Math.max(phaseOrHeadAt, Date.parse(runtime!.at)), silence * 2);
  if (session.phase === "shipping" && lastPr?.payload.ci === "failure" && redAt !== undefined && redCount >= 1)
    add("red-checks", Math.max(redAt, progressAt), silence * factor, redCount);
  return result;
}

export function progressSummary(signals: ProgressSignals): string {
  return signals.reasons
    .map((r) =>
      r.code === "repeated-report"
        ? `same report ${r.count} times in ${r.minutes} min, no head move`
        : `${r.code} for ${r.minutes} min (threshold ${r.thresholdMinutes} min)`,
    )
    .join("; ")
    .slice(0, 500);
}
