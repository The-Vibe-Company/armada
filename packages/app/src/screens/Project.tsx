import { APP_TOO_OLD, DAEMON_TOO_OLD } from "@armada/protocol";
import { FleetList } from "@/components/fleet/FleetList";
import { Dot, Page, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { fleetItems } from "@/fleet/overview";
import { fleetOf } from "@/fleet/state";
import { LOG_BEHIND, NOT_FOLDED } from "@/protocol/client";
import { useDaemon } from "@/protocol/store";
import { ProjectRules } from "@/rules/ProjectRules";

export function Project({ id, onReload }: { id: string; onReload: () => void }) {
  const { projects, fleets, problem, status } = useDaemon();
  const reload =
    problem === LOG_BEHIND || problem === NOT_FOLDED || problem === APP_TOO_OLD || problem === DAEMON_TOO_OLD;
  const alert = problem && (
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
  );
  const project = projects?.find((p) => p.id === id);
  const snapshot = fleets[id];
  if (!project)
    return (
      <Page>
        <PageHeader
          title="Project"
          quiet={
            problem
              ? "The daemon could not read this project."
              : projects === null
                ? "Reading the projects…"
                : "This project is not available."
          }
        />
        {alert}
      </Page>
    );
  const now = Date.now();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const items = snapshot ? fleetItems([{ id, state: fleetOf(snapshot) }], { now, zone }) : [];
  return (
    <Page>
      <PageHeader
        title={project.name}
        facts={
          <>
            <span>Project</span>
            <Dot />
            <span className="font-mono">{project.repository}</span>
          </>
        }
        quiet="The fleet and its current rules."
      />
      {alert}
      {snapshot ? (
        <ProjectRules state={snapshot.state} />
      ) : !problem ? (
        <p className="m-0 text-text-2">Reading this project’s log…</p>
      ) : null}
      {snapshot && <FleetList items={items} names={new Map([[id, project.name]])} now={now} zone={zone} />}
    </Page>
  );
}
