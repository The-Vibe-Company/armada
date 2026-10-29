import { useMemo } from "react";
import { DaemonProblem } from "@/components/DaemonProblem";
import { FleetList } from "@/components/fleet/FleetList";
import { Dot, Page, PageHeader } from "@/components/page";
import { dayIn, fleetItems, groupCounts, headline } from "@/fleet/overview";
import { fleetOf } from "@/fleet/state";
import { href } from "@/lib/route";
import { useDaemon } from "@/protocol/store";

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * A project's fleet by state, where a squadron of the hangar leads
 * (`#/projects/<id>`): the list today's home showed, for this project only,
 * until the project's room (THE-1996) takes this route and the list moves to
 * its rail. `now` and `zone` decide "merged today"; the viewer's own unless a test gives them.
 */
export function ProjectFleet({
  id,
  onReload,
  now: givenNow,
  zone: givenZone,
}: {
  id: string;
  onReload: () => void;
  now?: number;
  zone?: string;
}) {
  const { projects, fleets } = useDaemon();
  const now = givenNow ?? Date.now();
  const zone = givenZone ?? viewerZone();
  const project = projects?.find((p) => p.id === id);
  const snapshot = fleets[id];
  const today = dayIn(now, zone);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `now` only decides the day, which `today` stands for.
  const items = useMemo(
    () => (snapshot ? fleetItems([{ id, state: fleetOf(snapshot) }], { now, zone }) : []),
    [id, snapshot, today, zone],
  );
  const names = useMemo(() => new Map(project ? [[project.id, project.name]] : []), [project]);
  const counts = groupCounts(items);
  const flying = counts.blocked + counts.you + counts.running + counts.ready;
  return (
    <Page>
      <PageHeader
        facts={
          <>
            <a href={href.hangar} className="text-text-2 hover:text-text">
              Hangar
            </a>
            {project && (
              <>
                <Dot />
                <span className="font-mono">{project.repository}</span>
              </>
            )}
            {snapshot && (
              <>
                <Dot />
                <span>{flying === 1 ? "1 agent in flight" : `${flying} agents in flight`}</span>
              </>
            )}
          </>
        }
        title={project?.name ?? id}
        quiet={
          projects === null
            ? "Waiting for the daemon to list its projects."
            : !project
              ? "The daemon has no project of that name."
              : snapshot
                ? headline(counts)
                : "Reading its log."
        }
      />
      <DaemonProblem onReload={onReload} />
      {project && snapshot && <FleetList items={items} names={names} now={now} zone={zone} />}
    </Page>
  );
}
