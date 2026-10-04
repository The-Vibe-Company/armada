"use client";

// A ticket's history (THE-869): what the overview already knows of it at
// once, then the full read from the server (`/api/fleet/activity`, Postgres
// only), read again when its row changes; the server answers 304 while it is
// the same. The agent's page and the overview's preview pane read it.
import { type ActivityEntry, agentActivity, type FleetRow, type InboxItem } from "@armada/core/read";
import { useEffect, useRef, useState } from "react";
import type { TaggedActivity } from "@/lib/fleet-data";

/** What the overview already knows of the ticket's history, shown until the full read answers. */
function knownActivity(row: FleetRow): ActivityEntry[] {
  const s = row.session;
  return agentActivity({
    comments: [],
    events: [
      ...(s
        ? [
            {
              kind: "claim" as const,
              phase: "planning",
              message: null,
              runtime: s.runtime,
              handle: s.handle,
              prUrl: null,
              at: s.claimedAt,
            },
          ]
        : []),
      ...(row.statusLine
        ? [
            {
              kind: "report" as const,
              phase: row.phase,
              message: row.statusLine.summary,
              runtime: null,
              handle: null,
              prUrl: null,
              at: row.statusLine.at,
            },
          ]
        : []),
    ],
    inbox: row.question
      ? [
          {
            id: row.question.id,
            project: row.project,
            ticket: row.id,
            kind: "question",
            recipient: "coordinator",
            author: row.question.author,
            body: row.question.body,
            createdAt: row.question.at,
            resolvedAt: null,
            resolution: null,
          },
        ]
      : [],
    launches: [],
    prs: [],
  });
}

/**
 * The ticket's history from the server, read again when the row changes;
 * the server answers 304 while it is the same.
 */
export function useActivity(row: FleetRow, requests: InboxItem[], initial: TaggedActivity | null = null) {
  const [read, setRead] = useState<{ key: string; entries: ActivityEntry[]; live: boolean } | null>(null);
  const tag = useRef<string | null>(null);
  const project = row.project;
  const ticket = row.id;
  const key = `${project}/${ticket}`;
  // The activity the page was rendered with, while it is this ticket's.
  const given = initial && `${initial.activity.project}/${initial.activity.ticket}` === key ? initial : null;
  const changed = [
    row.lastUpdate,
    row.lastReport,
    row.phase,
    row.question?.id,
    row.pr?.number,
    ...requests.filter((r) => r.ticket === ticket).map((r) => r.id),
  ].join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `changed` says when the history may have changed.
  useEffect(() => {
    let live = true;
    const url = `/api/fleet/activity?project=${encodeURIComponent(project)}&ticket=${encodeURIComponent(ticket)}`;
    const known = read?.key === key ? tag.current : (given?.tag ?? null);
    fetch(url, { cache: "no-store", headers: known ? { "If-None-Match": known } : {} })
      .then(async (res) => {
        if (res.status === 304 || !res.ok || !live) return;
        const body = (await res.json()) as { entries: ActivityEntry[]; live: boolean };
        tag.current = res.headers.get("etag");
        setRead({ key, entries: body.entries, live: body.live });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [project, ticket, changed]);
  if (read?.key === key) return read;
  if (given) return { key, entries: given.activity.entries, live: given.activity.live };
  return { entries: knownActivity(row), live: true, key: "" };
}
