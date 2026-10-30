import { DaemonProblem } from "@/components/DaemonProblem";
import { FleetList } from "@/components/fleet/FleetList";
import { Dot, Page, PageHeader } from "@/components/page";
import { fleetItems } from "@/fleet/overview";
import { fleetOf } from "@/fleet/state";
import { useDaemon } from "@/protocol/store";
import { ProjectRules } from "@/rules/ProjectRules";

export function Project({ id, onReload }: { id: string; onReload: () => void }) {
  const { projects, fleets, problem } = useDaemon();
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
        <DaemonProblem onReload={onReload} />
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
      <DaemonProblem onReload={onReload} />
      {snapshot ? (
        <ProjectRules state={snapshot.state} />
      ) : !problem ? (
        <p className="m-0 text-text-2">Reading this project’s log…</p>
      ) : null}
      {snapshot && <FleetList items={items} names={new Map([[id, project.name]])} now={now} zone={zone} />}
    </Page>
  );
}
