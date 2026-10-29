// armadad's own WebSocket server (packages/daemon) over an in-memory event
// log seeded with a synthetic fleet, for development and this package's
// browser test: no Linear, no GitHub, no file. Bun runs it; the app never
// imports it (the app only speaks the protocol).

import type { EventInput, FleetEvent } from "@armada/daemon/events";
import { startServer } from "@armada/daemon/server";
import { EventStore } from "@armada/daemon/store";
import type { Project } from "@armada/protocol";

export interface DevDaemon {
  /** The daemon's page address: it serves `staticDir` there, the app it was given. */
  url: string;
  wsUrl: string;
  /** Append one event to the log; the daemon sends it, with the project's refolded state, to its subscribers. */
  append(event: EventInput): FleetEvent;
  stop(): Promise<void>;
}

export const SAMPLE_PROJECTS: Project[] = [
  { id: "harbor", name: "Harbor", repository: "example/harbor" },
  { id: "lantern", name: "Lantern", repository: "example/lantern" },
  { id: "tidewater", name: "Tidewater", repository: "example/tidewater" },
];

type Of<K extends EventInput["kind"]> = Extract<EventInput, { kind: K }>["payload"];

/** A small synthetic log at `at`: one fleet in every state. */
export function sampleEvents(at: string): EventInput[] {
  const e = <K extends EventInput["kind"]>(project: string, kind: K, payload: Of<K>, actor = "worker") =>
    ({ project, kind, at, actor, payload }) as EventInput;
  const ticket = (project: string, id: string, title: string) =>
    e(project, "ticket.seen", { id, title, status: "started" }, "tracker");
  const claim = (project: string, id: string, generation = 1) =>
    e(project, "session.claimed", {
      ticket: id,
      session: `s-${id.toLowerCase()}-${generation}`,
      generation,
      owner: "default",
      runtime: "local",
      handle: `s-${id.toLowerCase()}`,
    });
  const report = (project: string, id: string, phase: Of<"session.reported">["phase"], reason: string) =>
    e(project, "session.reported", { ticket: id, session: `s-${id.toLowerCase()}-1`, phase, reason });
  const pr = (project: string, id: string, number: number, ci: Of<"pull-request.seen">["ci"]) =>
    e(
      project,
      "pull-request.seen",
      { number, ticket: id, state: "open", ci, conflicting: false, head: `head-${number}` },
      "github",
    );
  return [
    ticket("harbor", "HAR-12", "Draw the harbour map from the tide tables"),
    claim("harbor", "HAR-12"),
    report("harbor", "HAR-12", "implementing", "Wiring the map to the tide feed"),
    ticket("harbor", "HAR-15", "Price berths by the hour"),
    claim("harbor", "HAR-15"),
    report("harbor", "HAR-15", "shipping", "Pull request open"),
    pr("harbor", "HAR-15", 41, "failure"),
    ticket("harbor", "HAR-18", "Let skippers book a berth from the quay"),
    claim("harbor", "HAR-18"),
    report("harbor", "HAR-18", "awaiting-approval", "Plan posted"),
    ticket("harbor", "HAR-20", "Show the pilot's schedule"),
    claim("harbor", "HAR-20"),
    report("harbor", "HAR-20", "ready-to-merge", "Handed back"),
    pr("harbor", "HAR-20", 44, "success"),
    ticket("harbor", "HAR-9", "Name the harbour's quays"),
    claim("harbor", "HAR-9"),
    report("harbor", "HAR-9", "ready-to-merge", "Handed back"),
    e(
      "harbor",
      "merge.confirmed",
      { id: "m-har-9", ticket: "HAR-9", session: "s-har-9-1", pr: 39, head: "head-39" },
      "coordinator",
    ),
    ticket("lantern", "LAN-3", "Dim the lanterns at dawn"),
    claim("lantern", "LAN-3"),
    report("lantern", "LAN-3", "implementing", "Reading the sunrise table"),
    e("lantern", "inbox.opened", {
      id: "q-lan-3",
      ticket: "LAN-3",
      kind: "question",
      body: "Should dawn follow the local sunrise or a fixed hour?\n\nOptions:\n- sunrise\n- fixed",
    }),
    ticket("lantern", "LAN-4", "Count the lanterns"),
    claim("lantern", "LAN-4"),
    e("lantern", "session.released", { ticket: "LAN-4", session: "s-lan-4-1", reason: "superseded" }),
    ticket("lantern", "LAN-7", "Pick the lanterns' colour"),
    claim("lantern", "LAN-7"),
    report("lantern", "LAN-7", "awaiting-validation", "Mockup attached"),
    e("lantern", "validation.opened", {
      id: "v-lan-7",
      ticket: "LAN-7",
      session: "s-lan-7-1",
      question: "Does the amber read as a lantern at night?",
      checks: ["The amber is warm"],
    }),
  ];
}

export async function startDevDaemon({
  port = 0,
  projects = SAMPLE_PROJECTS,
  events = sampleEvents(new Date().toISOString()),
  staticDir,
  allowedOrigins,
}: {
  port?: number;
  projects?: Project[];
  events?: EventInput[];
  staticDir?: string;
  allowedOrigins?: string[];
} = {}): Promise<DevDaemon> {
  const store = new EventStore(":memory:");
  for (const event of events) store.append(event);
  const server = await startServer({ store, projects, port, staticDir, allowedOrigins });
  return {
    url: server.url,
    wsUrl: server.wsUrl,
    append: (event) => store.append(event),
    async stop() {
      await server.close();
      store.close();
    },
  };
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 4824);
  // The Vite dev server (port 4823) is another origin: the daemon admits it by name.
  const daemon = await startDevDaemon({
    port,
    allowedOrigins: ["http://localhost:4823", "http://127.0.0.1:4823"],
  });
  console.log(`Dev daemon on ${daemon.wsUrl}: ${SAMPLE_PROJECTS.length} projects. Ctrl-C stops it.`);
  // Every few seconds Tidewater's TID-7 takes its next step, so a row glides from group to group.
  const steps: ((generation: number) => EventInput)[] = [
    (g) => ({
      project: "tidewater",
      kind: "session.claimed",
      at: new Date().toISOString(),
      actor: "worker",
      payload: {
        ticket: "TID-7",
        session: `s-tid-7-${g}`,
        generation: g,
        owner: "default",
        runtime: "local",
        handle: "s-tid-7",
      },
    }),
    ...(
      [
        ["implementing", "Charting the shallows"],
        ["blocked", "Waiting for the depth survey"],
        ["implementing", "Survey in, charting again"],
        ["awaiting-approval", "A second plan for the reefs"],
        ["ready-to-merge", "Handed back"],
      ] as const
    ).map(
      ([phase, reason]) =>
        (g: number): EventInput => ({
          project: "tidewater",
          kind: "session.reported",
          at: new Date().toISOString(),
          actor: "worker",
          payload: { ticket: "TID-7", session: `s-tid-7-${g}`, phase, reason },
        }),
    ),
    (g) => ({
      project: "tidewater",
      kind: "session.released",
      at: new Date().toISOString(),
      actor: "worker",
      payload: { ticket: "TID-7", session: `s-tid-7-${g}`, reason: "demo cycle" },
    }),
  ];
  daemon.append({
    project: "tidewater",
    kind: "ticket.seen",
    at: new Date().toISOString(),
    actor: "tracker",
    payload: { id: "TID-7", title: "Chart the shallows by the reef", status: "started" },
  });
  let step = 0;
  let generation = 1;
  setInterval(() => {
    const make = steps[step] as (generation: number) => EventInput;
    daemon.append(make(generation));
    step = (step + 1) % steps.length;
    if (step === 0) generation += 1;
  }, 3000);
}
