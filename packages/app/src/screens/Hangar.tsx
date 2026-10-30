import { useMemo } from "react";
import { DaemonProblem } from "@/components/DaemonProblem";
import { PageBar } from "@/components/page";
import { countsOf, type Fact, hangarFacts, inFlight } from "@/fleet/hangar";
import { dayIn } from "@/fleet/overview";
import { skyProject } from "@/fleet/sky";
import { fleetOf } from "@/fleet/state";
import { projectHref } from "@/lib/route";
import { cn } from "@/lib/utils";
import { useDaemon } from "@/protocol/store";
import { Sky } from "@/sky/Sky";

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const INK: Record<string, string> = { blocked: "text-red", you: "text-amber", ready: "text-green" };

/**
 * The hangar, the app's home (THE-2025, the direction kept with the owner,
 * `.aeom/direction/index.html`): the fleet's facts on one line across the
 * top, and the whole view is the sky, every project a squadron flying in
 * depth (its coordinator's V, its agents in their harness colours, an arc in
 * its most urgent state's colour, its name and counts), each one a link into
 * its room. When nothing flies, the sky is empty, with one quiet line.
 * `now` and `zone` decide "merged today"; the viewer's own unless a test gives them.
 */
export function Hangar({
  onReload,
  now: givenNow,
  zone: givenZone,
}: {
  onReload: () => void;
  now?: number;
  zone?: string;
}) {
  const { projects, fleets } = useDaemon();
  // Read on each render: each frame re-renders the sky, and nothing on screen ticks between them.
  const now = givenNow ?? Date.now();
  const zone = givenZone ?? viewerZone();
  // Shown once every project's folded state arrived, so the hangar never says 0 before it knows.
  const read = projects?.every((p) => fleets[p.id]) ?? false;
  const today = dayIn(now, zone);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `now` only decides the day, which `today` stands for.
  const squadrons = useMemo(
    () =>
      (projects ?? []).flatMap((p) => {
        const snapshot = fleets[p.id];
        return snapshot ? [skyProject(p, fleetOf(snapshot), { now, zone })] : [];
      }),
    [projects, fleets, today, zone],
  );
  const counts = countsOf(squadrons.flatMap((s) => s.agents));
  const flying = inFlight(counts) > 0;
  const facts = hangarFacts(counts);
  const quiet =
    projects === null
      ? "Waiting for the daemon to list its projects."
      : !read
        ? null
        : projects.length === 0
          ? "No project yet. Each project's squadron flies here once the daemon reads it."
          : flying
            ? null
            : "Nothing in flight. A squadron takes off here when its coordinator launches an agent.";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageBar
        title="Hangar"
        facts={
          projects === null ? (
            <span>Waiting for the daemon</span>
          ) : !read ? (
            <span>Reading the projects' logs</span>
          ) : (
            <>
              {facts.fleet.map((f) => (
                <FactSpan key={f.key} fact={f} />
              ))}
              {facts.owner.length > 0 && <span aria-hidden className="h-4 w-px flex-none bg-line" />}
              {facts.owner.map((f) => (
                <FactSpan key={f.key} fact={f} />
              ))}
            </>
          )
        }
        end={projects && <span>{projects.length === 1 ? "1 project" : `${projects.length} projects`}</span>}
      />
      <div className="relative flex min-h-0 flex-1">
        {/* Drawn once the fleet is read, so its first paint holds every squadron still in place. */}
        {read ? <Sky projects={flying ? squadrons : []} size="stage" link={projectHref} /> : <div className="flex-1" />}
        {quiet && (
          <p className="pointer-events-none absolute inset-x-6 top-1/2 m-0 -translate-y-1/2 text-center text-sub text-text-3">
            {quiet}
          </p>
        )}
        <DaemonProblem onReload={onReload} className="absolute inset-x-4 top-4" />
      </div>
    </div>
  );
}

/** One fact of the line: its number in Geist Mono, coloured for what needs the owner, then its words. */
function FactSpan({ fact }: { fact: Fact }) {
  return (
    <span className="flex items-baseline gap-1.5" data-fact={fact.key}>
      <b className={cn("font-medium font-mono tnum", fact.group && fact.n ? INK[fact.group] : "text-text")}>{fact.n}</b>
      {fact.text}
    </span>
  );
}
