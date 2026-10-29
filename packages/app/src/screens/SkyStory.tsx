// The sky's story page (THE-2024), at `?story=sky`: the band of each of the
// daemon's projects and the stage of them all, live, then a synthetic fleet
// to move by hand (a state change, a merge, a launch) up to the 60 agents of
// the frame budget. Loaded only behind its flag, never in the first load.
import { useMemo, useState } from "react";
import { Block, Dot, Page, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import type { Group } from "@/fleet/overview";
import { HARNESSES, type SkyAgent, type SkyProject, skyProject } from "@/fleet/sky";
import { fleetOf } from "@/fleet/state";
import { useDaemon } from "@/protocol/store";
import { Sky } from "@/sky/Sky";

const viewerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** The order a state change takes a session through, in the synthetic fleet. */
const NEXT: Record<Exclude<Group, "merged">, Exclude<Group, "merged">> = {
  running: "blocked",
  blocked: "you",
  you: "ready",
  ready: "running",
};

function synthetic(count: number, merged: number): SkyProject {
  const states: Exclude<Group, "merged">[] = ["running", "running", "running", "blocked", "you", "ready"];
  const agents: SkyAgent[] = [];
  for (let k = 0; k < count; k++)
    agents.push({
      key: `synthetic/SYN-${k + 1}`,
      ticket: `SYN-${k + 1}`,
      group: states[k % states.length] ?? "running",
      harness: HARNESSES[k % HARNESSES.length] ?? null,
    });
  for (let k = 0; k < merged; k++)
    agents.push({ key: `synthetic/SYN-M${k + 1}`, ticket: `SYN-M${k + 1}`, group: "merged", harness: "claude" });
  return { id: "synthetic", name: "Synthetic", coordinator: true, agents };
}

export function SkyStory() {
  const { projects, fleets } = useDaemon();
  const live = useMemo(() => {
    const now = Date.now();
    const zone = viewerZone();
    return (projects ?? []).flatMap((p) => {
      const snapshot = fleets[p.id];
      return snapshot ? [skyProject(p, fleetOf(snapshot), { now, zone })] : [];
    });
  }, [projects, fleets]);
  const [fleet, setFleet] = useState(() => synthetic(9, 6));
  const [turn, setTurn] = useState(0);
  const flying = fleet.agents.filter((a) => a.group !== "merged");

  const change = () => {
    const target = flying[turn % Math.max(1, flying.length)];
    if (!target || target.group === "merged") return;
    const group = NEXT[target.group];
    setFleet({ ...fleet, agents: fleet.agents.map((a) => (a.key === target.key ? { ...a, group } : a)) });
    setTurn(turn + 1);
  };
  const merge = () => {
    const target = flying.find((a) => a.group === "ready") ?? flying[0];
    if (!target) return;
    setFleet({
      ...fleet,
      agents: [...fleet.agents.filter((a) => a.key !== target.key), { ...target, group: "merged" }],
    });
  };
  const launch = (n: number) => {
    const agents = [...fleet.agents];
    for (let k = 0; k < n; k++) {
      const id = agents.length + 1;
      agents.unshift({
        key: `synthetic/NEW-${id}`,
        ticket: `NEW-${id}`,
        group: "running",
        harness: HARNESSES[id % HARNESSES.length] ?? null,
      });
    }
    setFleet({ ...fleet, agents });
  };

  return (
    <Page>
      <PageHeader
        facts={
          <>
            <span>Story</span>
            <Dot />
            <span>{live.length} live projects</span>
            <Dot />
            <span>{flying.length} synthetic agents in flight</span>
          </>
        }
        title="Sky"
        quiet="The fleet's sky at both sizes: the band of a project's room and the hangar's stage."
      />
      {live.map((p) => (
        <Block key={p.id} heading={`Band · ${p.name}`}>
          <Sky projects={[p]} size="band" className="rounded-card shadow-ring" />
        </Block>
      ))}
      {live.length > 0 && (
        <Block heading="Stage · every project">
          <div className="flex h-140">
            <Sky projects={live} size="stage" className="rounded-card shadow-ring" />
          </div>
        </Block>
      )}
      <Block heading="Synthetic fleet">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="soft" onClick={change}>
              Change a state
            </Button>
            <Button variant="soft" onClick={merge}>
              Merge one
            </Button>
            <Button variant="soft" onClick={() => launch(1)}>
              Launch one
            </Button>
            <Button variant="soft" onClick={() => launch(Math.max(0, 60 - flying.length))}>
              Fill to 60
            </Button>
          </div>
          <Sky projects={[fleet]} size="band" className="rounded-card shadow-ring" />
          <div className="flex h-140">
            <Sky projects={[fleet, ...live]} size="stage" className="rounded-card shadow-ring" />
          </div>
        </div>
      </Block>
    </Page>
  );
}
