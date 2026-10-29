import { APP_TOO_OLD, DAEMON_TOO_OLD } from "@armada/protocol";
import { useMemo } from "react";
import { CoordinatorKey } from "@/components/CoordinatorKey";
import { FleetList } from "@/components/fleet/FleetList";
import { Dot, Page, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { dayIn, fleetItems, groupCounts, headline, subline } from "@/fleet/overview";
import { fleetOf } from "@/fleet/state";
import { LOG_BEHIND, NOT_FOLDED } from "@/protocol/client";
import { useDaemon } from "@/protocol/store";

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * The home page, in the v7 anatomy: the daemon and the fleet's numbers on the
 * facts line, the title, what is blocked and what waits for the owner on the
 * quiet line, then the fleet by state (`FleetList`), from each project's
 * folded state as the daemon sends it. `now` and `zone` decide "merged today";
 * the viewer's own unless a test gives them.
 */
export function Home({
  address,
  onReload,
  now: givenNow,
  zone: givenZone,
}: {
  address: string;
  onReload: () => void;
  now?: number;
  zone?: string;
}) {
  const { projects, fleets, problem, status } = useDaemon();
  // Read on each render: each frame re-renders the list, and nothing on screen ticks between them.
  const now = givenNow ?? Date.now();
  const zone = givenZone ?? viewerZone();
  // Shown once every project's folded state arrived, so the page never says 0 before it knows.
  const read = projects?.every((p) => fleets[p.id]) ?? false;
  // The list changes with the fleet and with the viewer's day, not with each millisecond.
  const today = dayIn(now, zone);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `now` only decides the day, which `today` stands for.
  const items = useMemo(
    () =>
      fleetItems(
        (projects ?? []).flatMap((p) => {
          const snapshot = fleets[p.id];
          return snapshot ? [{ id: p.id, state: fleetOf(snapshot) }] : [];
        }),
        { now, zone },
      ),
    [projects, fleets, today, zone],
  );
  const names = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p.name])), [projects]);
  const counts = groupCounts(items);
  // Reloading helps after an update, or when the daemon's log went back; not with an address it cannot open.
  const reload =
    problem === LOG_BEHIND || problem === NOT_FOLDED || problem === APP_TOO_OLD || problem === DAEMON_TOO_OLD;
  return (
    <Page>
      <PageHeader
        facts={
          <>
            <span>Daemon</span>
            <Dot />
            <span className="font-mono">{address}</span>
            {projects &&
              read &&
              subline(counts, projects.length).map((fact) => (
                <span key={fact} className="contents">
                  <Dot />
                  <span>{fact}</span>
                </span>
              ))}
          </>
        }
        title="Fleet"
        quiet={
          projects === null
            ? "Waiting for the daemon to list its projects."
            : read
              ? headline(counts)
              : `${plural(projects.length, "project")} · reading their logs`
        }
      />
      {problem && (
        <div
          role="alert"
          className={`flex items-center gap-3 rounded-card bg-card px-4 py-3 shadow-ring ${status === "refused" ? "text-red" : "text-amber"}`}
        >
          <span className="flex-1">{problem}</span>
          {reload && (
            <Button variant="soft" onClick={onReload}>
              Reload
            </Button>
          )}
        </div>
      )}
      <CoordinatorKey />
      {projects && projects.length > 0 && read && <FleetList items={items} names={names} now={now} zone={zone} />}
    </Page>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
