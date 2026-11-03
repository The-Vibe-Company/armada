import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { eventually } from "../../plugins/node-local/test/support.ts";
import { EventStore } from "../src/store.ts";
import { SILENT_TURN_NOTE } from "../src/workers/service.ts";
import { fakeWorkers } from "./support/fake-worker.ts";

const project = "orchard";
const start = Date.parse("2030-01-01T00:00:00.000Z");

async function fixture(t: TestContext) {
  const store = new EventStore(":memory:");
  let clock = start;
  const { workers, fake, launch } = fakeWorkers(store, [{ id: project, repository: "example/orchard" }], {
    now: () => new Date(clock).toISOString(),
  });
  store.append({
    project,
    at: new Date(clock).toISOString(),
    actor: "Mira",
    kind: "ticket.created",
    payload: {
      id: "SEED-1",
      title: "Plant the orchard",
      description: "Keep the saplings watered.",
      labels: ["ready-for-agent"],
      state: "unstarted",
      parent: null,
      blockers: [],
    },
  });
  const worker = await launch(project, "SEED-1", "worker/seed-1");
  t.after(async () => {
    await workers.shutdown(project, "Fixture cleanup", () => {});
    await workers.close();
    store.close();
  });
  const report = (phase: string, message: string) =>
    workers.request(worker.token, { command: "report", ticket: "SEED-1", phase, message });
  /** One turn: the runtime works, then its result leaves it idle. */
  const turn = async () => {
    fake.activity.set(worker.session, "working");
    await workers.observeAll();
    clock += 1_000;
    fake.activity.set(worker.session, "idle");
    await workers.observeAll();
  };
  const after = async (ms: number) => {
    clock += ms;
    await workers.observeAll();
  };
  const notes = () => store.readSince(0, project).filter((e) => e.kind === "delivery.queued" && e.actor === "daemon");
  return { worker, fake, report, turn, after, notes, ask: worker.ask };
}

test("a turn that ends without a report gets one continue note a minute later, once per report", async (t) => {
  const run = await fixture(t);
  await run.report("implementing", "progress: verify started in the background");
  await run.turn();
  await run.after(59_000);
  assert.equal(run.notes().length, 0, "a minute is the grace before the note");
  await run.after(2_000);
  assert.equal(run.notes().length, 1);
  await eventually(async () => run.fake.delivered.some((d) => d.message === SILENT_TURN_NOTE));
  assert.equal(run.fake.delivered.find((d) => d.message === SILENT_TURN_NOTE)?.session, run.worker.session);
  // The note's own turn ends silent too: no second note without a new report.
  await run.turn();
  await run.after(61_000);
  assert.equal(run.notes().length, 1);
  // A new report opens a new episode.
  await run.report("shipping", "progress: verify green, opening the pull request");
  await run.turn();
  await run.after(61_000);
  assert.equal(run.notes().length, 2);
});

type Run = Awaited<ReturnType<typeof fixture>>;
const waits: [string, "before" | "after", (run: Run) => Promise<unknown>][] = [
  ["a report after the turn ended", "after", (run) => run.report("implementing", "progress: next step")],
  ["a plan awaiting approval", "before", (run) => run.report("awaiting-approval", "waiting: plan")],
  ["a block", "before", (run) => run.report("blocked", "blocked: missing key")],
  [
    "an open question while independent work is done",
    "before",
    async (run) => {
      await run.ask("Which soil? recommend loam");
      await run.report("implementing", "progress: independent part done; waiting for the answer");
    },
  ],
];
for (const [name, when, wait] of waits)
  test(`no continue note for ${name}`, async (t) => {
    const run = await fixture(t);
    // Prerequisite: this worker's silent turn is noted.
    await run.report("implementing", "progress: started");
    await run.turn();
    await run.after(61_000);
    assert.equal(run.notes().length, 1);
    if (when === "before") await wait(run);
    await run.turn();
    if (when === "after") await wait(run);
    await run.after(61_000);
    assert.equal(run.notes().length, 1, "a legitimate wait gets no note");
  });
