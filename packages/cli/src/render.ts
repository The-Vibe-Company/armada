// Human-readable rendering of a status report. Plain text, no colors, so the
// output reads the same in a terminal, a log or an agent transcript.
import {
  type CoordinatorRecord,
  type InFlightTicket,
  jobStalledMinutes,
  mainHealthLine,
  type QueueEntry,
  queueOpen,
  type StatusReport,
} from "@armada/core";

const MIN = 60_000;

export function relative(iso: string, now: number): string {
  const diff = now - Date.parse(iso);
  const m = Math.round(Math.abs(diff) / MIN);
  const suffix = diff >= 0 ? "ago" : "from now";
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ${suffix}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ${suffix}`;
  return `${Math.round(h / 24)} d ${suffix}`;
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const pad = (s: string, n: number) => s.padEnd(n);

const MERGEABLE: Record<string, string> = {
  MERGEABLE: "mergeable",
  CONFLICTING: "conflicts",
  UNKNOWN: "mergeability unknown",
};

/** "draft · CI pending · mergeable", skipping what the forge did not report. */
function prState(pr: Pick<NonNullable<InFlightTicket["pr"]>, "draft" | "ci" | "mergeable">): string {
  return [
    pr.draft ? "draft" : null,
    pr.ci === "none" ? "no CI" : pr.ci ? `CI ${pr.ci}` : null,
    pr.mergeable ? (MERGEABLE[pr.mergeable] ?? pr.mergeable.toLowerCase()) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

const phaseLabel = (t: InFlightTicket) => {
  const phase = `${t.phase}${t.shippingStage ? ` · ${t.shippingStage}` : ""}`;
  return t.phaseSource === "label" ? phase : `${phase} (${t.phaseSource})`;
};

/** The merge queue, one line per entry: the open ones numbered in drain order. */
export function queueLines(entries: readonly QueueEntry[]): string[] {
  let position = 0;
  return entries.map(
    (e) =>
      `${queueOpen(e) ? `${++position}.` : "  "} #${e.pr}  ${e.state}${e.ticket ? `  ${e.ticket}` : ""} · queued by ${e.queuedBy}${e.detail ? ` — ${e.detail}` : ""}`,
  );
}

export interface StatusHints {
  stranded?: CoordinatorRecord[];
  digest?: boolean;
}

export function renderStatus(r: StatusReport, hints: StatusHints = {}): string {
  const now = Date.parse(r.generatedAt);
  const out: string[] = [];
  const idWidth = Math.max(
    6,
    ...r.inFlight.map((t) => t.id.length),
    ...r.notStarted.map((l) => l.ticket.length),
    ...r.frontier.map((t) => t.id.length),
    ...(r.pullRequests ?? []).map((p) => `#${p.number}`.length),
  );
  const indent = " ".repeat(idWidth + 4);
  const phaseWidth = Math.max(0, ...r.inFlight.map((t) => phaseLabel(t).length));

  out.push(`${r.project.name} · ${r.programRoot.id} ${r.programRoot.title}`);
  const gh = r.sources.github.error ? `GitHub not read: ${r.sources.github.error}` : `GitHub ${r.project.repository}`;
  out.push(`Read ${r.generatedAt.slice(0, 16).replace("T", " ")} UTC · Linear ${r.programRoot.id} · ${gh}`);

  for (const h of r.holds ?? [])
    out.push(`Merges paused since ${h.openedAt.slice(11, 16)} UTC: ${h.reason} (hold #${h.id})`);
  if (r.main) out.push(mainHealthLine(r.main));
  if (r.queue?.length) {
    out.push("", `Merge queue (${r.queue.filter(queueOpen).length} queued)`);
    for (const line of queueLines(r.queue)) out.push(`  ${line}`);
  }

  out.push("", `In flight (${r.inFlight.length})`);
  if (!r.inFlight.length) out.push("  nobody is working");
  for (const t of r.inFlight) {
    const who =
      [t.runtime, t.coordinator && `coordinator: ${t.coordinator}`, t.runtimeState && `live ${t.runtimeState}`, t.agent]
        .filter(Boolean)
        .join(" · ") || "unassigned";
    out.push(
      `  ${pad(t.id, idWidth)}  ${pad(phaseLabel(t), phaseWidth)}  ${who} · ${t.lastReport ? `reported ${relative(t.lastReport, now)}` : `updated ${relative(t.lastUpdate, now)}`}`,
    );
    out.push(`${indent}${truncate(t.title, 90)}${t.spec ? ` [${t.spec}]` : ""}`);
    if (t.profile)
      out.push(
        `${indent}Profile: ${t.profile}${t.harness ? ` · ${t.harness}` : ""}${t.profileReason ? ` — ${t.profileReason}` : ""}`,
      );
    if (t.statusLine?.summary) out.push(`${indent}“${truncate(t.statusLine.summary, 100)}”`);
    if (t.statusLine?.plan) out.push(`${indent}plan: ${t.statusLine.url}`);
    if (t.pr) out.push(`${indent}${[`PR #${t.pr.number}`, prState(t.pr)].filter(Boolean).join(" · ")}`);
    if (t.flags.length)
      out.push(
        `${indent}! ${t.flags.map((flag) => (flag === "stopped" ? "stopped: its session is idle and it did not hand back" : flag === "silent" && t.runtimeState === "working" ? "silent, but its session is still working" : flag)).join(", ")}`,
      );
  }

  const pending = r.pendingLaunches ?? r.notStarted;
  if (pending.length) {
    out.push("", `Pending launches (${pending.length})`);
    for (const l of pending) {
      out.push(
        `  ${pad(l.ticket, idWidth)}  launched ${relative(l.launchedAt, now)} · ${l.tokenUsedAt ? `signed in ${relative(l.tokenUsedAt, now)}, no claim` : "launch token never used"}${l.coordinator ? ` · coordinator: ${l.coordinator}` : ""}${l.runtime ? ` · ${l.runtime}` : ""}${l.handle ? ` · ${l.handle}` : ""}`,
      );
      const title = r.notStarted.find((launch) => launch.ticket === l.ticket)?.title;
      if (title) out.push(`${indent}${truncate(title, 90)}`);
      out.push(`${indent}! check its session with the runtime guide's status section`);
      out.push(`${indent}Cancel: armada launch revoke ${l.ticket}`);
    }
  }

  if (r.jobs?.length) {
    out.push("", `Jobs running (${r.jobs.length})`);
    for (const j of r.jobs) {
      out.push(
        `  Job ${j.id} · ${j.ticket} · ${j.name} · ${j.state}${j.overdue ? " · overdue" : ""}${j.stalled ? ` · stalled ${jobStalledMinutes(j, new Date(now))} min` : ""}`,
      );
      out.push(`    Runner: ${j.ref ?? "no runner reference"} · ${j.progress ?? "no progress reported"}`);
      out.push(`    Observed ${relative(j.observedAt, now)}${j.eta ? ` · ETA ${j.eta}` : ""}`);
      if (j.ticketDone) out.push("    ! ticket is Done; job continues until the runner ends or you stop it");
    }
  }

  if (r.launchWhenUnblocked?.length) {
    out.push("", `Launch when unblocked (${r.launchWhenUnblocked.length})`);
    for (const request of r.launchWhenUnblocked) {
      out.push(
        `  ${request.ticket}  ${request.reason ?? "unblocked: launch it now"}${request.profile ? ` · profile ${request.profile}` : ""} · asked by ${request.author ?? "unknown"} (#${request.id})`,
      );
      out.push(`    ${request.command}`);
    }
  }
  const ready = r.frontier.filter((t) => t.readyForAgent);
  const untriaged = r.frontier.filter((t) => !t.readyForAgent);
  out.push("", `Ready to start (${ready.length})`);
  if (!ready.length) out.push("  no unblocked ticket is marked ready");
  for (const t of ready) {
    const meta = [
      t.spec,
      "launchingBy" in t ? `launching by ${t.launchingBy ?? "unowned"}` : null,
      t.unlocks.length ? `unlocks ${t.unlocks.length}` : null,
      t.onCriticalPath ? "critical path" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    out.push(`  ${pad(t.id, idWidth)}  ${truncate(t.title, 80)}${meta ? `  (${meta})` : ""}`);
  }
  if (untriaged.length) {
    out.push("", `Unblocked but not marked ready (${untriaged.length})`);
    for (const t of untriaged)
      out.push(
        `  ${pad(t.id, idWidth)}  ${truncate(t.title, 80)}${"launchingBy" in t ? ` (launching by ${t.launchingBy ?? "unowned"})` : ""}`,
      );
  }

  out.push("", `Pull requests waiting (${r.pullRequests?.length ?? "?"})`);
  if (!r.pullRequests) out.push("  GitHub was not read");
  else if (!r.pullRequests.length) out.push("  none open");
  for (const p of r.pullRequests ?? []) {
    const ticket = p.ticket
      ? `${p.ticket.id}${p.ticket.phase ? ` ${p.ticket.phase}${p.ticket.shippingStage ? ` · ${p.ticket.shippingStage}` : ""}` : ""}`
      : "no ticket";
    out.push(`  ${pad(`#${p.number}`, idWidth)}  ${[ticket, prState(p)].filter(Boolean).join(" · ")}`);
    out.push(`${indent}${truncate(p.title, 90)}`);
    if (p.failingChecks.length) out.push(`${indent}! failing: ${p.failingChecks.join(", ")}`);
  }
  for (const role of hints.stranded ?? [])
    out.push(
      "",
      `${role.tickets.join(", ")} belong to coordinator ${role.name}, last seen ${relative(role.seenAt, now)}: armada coordinator take ${role.tickets.join(" ")} --from ${role.name}`,
    );
  if (hints.digest)
    out.push("", "The owner's status: armada digest (paste it) · armada digest --send posts it to their channel");
  if (r.warnings.length) {
    out.push("", `Warnings (${r.warnings.length})`);
    for (const w of r.warnings) out.push(`  ! ${w}`);
  }
  return `${out.join("\n")}\n`;
}
