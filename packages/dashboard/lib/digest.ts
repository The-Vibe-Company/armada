// Shared Postgres-only records for scheduled summaries and the CLI.
import { buildInsights, type DigestInput, isLabelPhase, mainHealth, sinceSummary } from "@armada/core/read";
import { catchupRecords } from "./activity-store";
import { isoAt, type Queryable } from "./db";
import { coordinatorPresence, insightRecords, openInboxItems, openRuntimeHandles } from "./fleet-store";
import { storedSnapshot } from "./snapshots";

export async function digestRecords(
  db: Queryable,
  project: string,
  since: string | null,
  now: Date,
): Promise<{ input: DigestInput; language: "en" | "fr" }> {
  const snapshot = await storedSnapshot(db, project);
  const policy = snapshot?.config.policy.silentAfterMinutes ?? 15;
  const language = snapshot?.config.tracker.language?.toLowerCase().startsWith("fr") ? "fr" : "en";
  let start = since;
  if (!start) {
    const rs = await db.query(
      `SELECT COALESCE(
      (SELECT max(p.created_at) FROM owner_pushes p JOIN owner_channels c ON c.id = p.channel
       JOIN projects pr ON pr.organization_id = c.organization
       WHERE pr.slug = $1 AND (c.project IS NULL OR c.project = $1)
       AND (p.key LIKE 'digest:%' OR (p.key LIKE 'digest-manual:%' AND p.payload->>'project' = $1)) AND p.error IS DISTINCT FROM 'skipped'),
      (SELECT min(c.created_at) FROM owner_channels c JOIN projects pr ON pr.organization_id = c.organization
       WHERE pr.slug = $1 AND (c.project IS NULL OR c.project = $1))) AS at`,
      [project],
    );
    start = rs.rows[0]?.at ? isoAt(rs.rows[0].at) : new Date(now.getTime() - 4 * 60 * 60_000).toISOString();
  }
  const [catchup, history, sessions, presence, inbox, phaseRows] = await Promise.all([
    catchupRecords(db, project, { since: new Date(start), until: now }, policy, now),
    insightRecords(db, project, new Date(now.getTime() - 180 * 24 * 60 * 60_000), policy),
    openRuntimeHandles(db, project),
    coordinatorPresence(db, project),
    openInboxItems(db, { project, recipient: "coordinator" }),
    db.query(
      `SELECT s.ticket, last.phase, COALESCE(first.created_at, s.claimed_at) AS phase_since
      FROM runtime_handles s
      LEFT JOIN LATERAL (SELECT phase, id FROM events e WHERE e.project = s.project AND e.ticket = s.ticket
        AND e.created_at >= s.claimed_at AND e.phase IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1) last ON true
      LEFT JOIN LATERAL (SELECT min(e.created_at) AS created_at FROM events e
        WHERE e.project = s.project AND e.ticket = s.ticket AND e.created_at >= s.claimed_at AND e.phase = last.phase
        AND e.id > COALESCE((SELECT max(x.id) FROM events x WHERE x.project = s.project AND x.ticket = s.ticket
          AND x.id <= last.id AND x.phase IS NOT NULL AND x.phase <> last.phase), 0)) first ON true
      WHERE s.project = $1 AND s.released_at IS NULL`,
      [project],
    ),
  ]);
  const summary = sinceSummary({ since: start, now, records: [catchup] });
  for (const stuck of summary.stuck) {
    if (stuck.reason !== "blocked") continue;
    const block = catchup.blocked.findLast((b) => b.ticket === stuck.ticket);
    if (!block) continue;
    const timeline = history.events.filter((e) => e.ticket === stuck.ticket);
    const latestBlock = timeline.findLastIndex((e) => e.phase === "blocked" && e.at <= block.at);
    const previousPhase = timeline.slice(0, latestBlock).findLastIndex((e) => e.phase && e.phase !== "blocked");
    const entered =
      timeline.slice(previousPhase + 1, latestBlock + 1).find((e) => e.phase === "blocked")?.at ?? block.at;
    const end = timeline
      .slice(latestBlock + 1)
      .find((e) => (e.phase && e.phase !== "blocked") || e.kind === "release" || e.kind === "merge");
    stuck.minutes = Math.max(
      0,
      Math.round(((end ? Date.parse(end.at) : now.getTime()) - Date.parse(entered)) / 60_000),
    );
  }
  const titles = Object.fromEntries(
    (snapshot?.sources.program.issues ?? []).map((i) => [`${project}/${i.id}`, i.title]),
  );
  const phases = new Map(
    phaseRows.rows.map((r) => [String(r.ticket), { phase: r.phase, since: isoAt(r.phase_since) }]),
  );
  const inFlight: DigestInput["inFlight"] = [];
  for (const session of sessions) {
    const state = phases.get(session.ticket);
    const phase = String(state?.phase ?? "");
    if (!state || !isLabelPhase(phase)) continue;
    inFlight.push({
      project,
      ticket: session.ticket,
      title: titles[`${project}/${session.ticket}`] ?? "",
      phase,
      phaseSince: state.since,
    });
    const runtimeBroken = session.runtimeState?.state === "failed" || session.runtimeState?.state === "gone";
    if (phase === "blocked" || runtimeBroken) {
      const minutes = Math.max(
        0,
        Math.round(
          (now.getTime() -
            Date.parse(
              runtimeBroken ? (session.runtimeState?.since ?? session.runtimeState?.at ?? state.since) : state.since,
            )) /
            60_000,
        ),
      );
      const stuck = summary.stuck.find((s) => s.ticket === session.ticket);
      if (stuck) Object.assign(stuck, { reason: "blocked", minutes, ongoing: true });
      else summary.stuck.push({ project, ticket: session.ticket, reason: "blocked", minutes, ongoing: true });
    }
  }
  const insights = buildInsights({ records: [{ ...history, project, silentAfterMinutes: policy }], range: "90d", now });
  const phaseMedians = Object.fromEntries(
    insights.phases.filter((p) => p.medianMs !== null).map((p) => [p.phase, p.medianMs]),
  );
  const ownerItems: NonNullable<DigestInput["ownerItems"]> = history.waits
    .filter((w) => w.kind === "plan" && w.resolvedAt === null && w.ticket)
    .map((w) => ({
      project,
      ticket: w.ticket ?? "",
      title: titles[`${project}/${w.ticket}`] ?? "",
      href: `/agents/${encodeURIComponent(w.ticket ?? "")}`,
      kind: "plan",
    }));
  const coordinatorLate = inbox.some(
    (item) => now.getTime() - Date.parse(item.createdAt) > (snapshot?.config.policy.coordinatorMinutes ?? 15) * 60_000,
  );
  if (coordinatorLate && (!presence || now.getTime() - Date.parse(presence.seenAt) > policy * 60_000))
    ownerItems.push({
      project,
      ticket: null,
      title: snapshot?.config.project.name ?? project,
      href: `/projects/${encodeURIComponent(project)}`,
      kind: "coordinator",
    });
  const health = snapshot?.sources.forge?.main
    ? mainHealth(snapshot.sources.forge.main, snapshot.config.gates.requiredChecks, snapshot.sources.forge.mainComplete)
    : null;
  const extras = health?.redSince
    ? {
        mainRed: [
          {
            project,
            since: health.redSince.at,
            url: `https://github.com/${snapshot?.config.github.repository}/commit/${health.redSince.sha}`,
          },
        ],
      }
    : undefined;
  return {
    language,
    input: {
      since: start,
      until: now.toISOString(),
      now,
      summary,
      titles,
      inFlight,
      phaseMedians,
      mergedSamples: insights.cycle.count,
      ownerItems,
      extras,
    },
  };
}
