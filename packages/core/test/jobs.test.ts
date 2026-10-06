import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { serveFleet } from "../src/fleet-api.ts";
import { parseJobStatus } from "../src/jobs.ts";
import { memoryFleet } from "./memory-fleet.ts";
import { DEMO_PROJECT, DEMO_TOML, NOW, tempFleet } from "./support.ts";

const startedAt = "2026-03-04T09:00:00.000Z";

describe("long jobs", () => {
  test("parses the last status line and estimates completion from elapsed progress", () => {
    expect(parseJobStatus("running 37/120 cases", startedAt, NOW)).toEqual({
      state: "running",
      progress: "37/120 cases",
      eta: "2026-03-04T12:14:35.676Z",
    });
    for (const line of [
      "running preparing",
      "running 0/120 cases",
      "running 120/120 cases",
      "succeeded 120/120 cases",
      "failed runner stopped",
    ])
      expect(parseJobStatus(line, startedAt, NOW).eta).toBeNull();
    expect(parseJobStatus("runner noise\n\nrunning 2/4 cases\n", startedAt, NOW).eta).toBe("2026-03-04T11:00:00.000Z");
    for (const line of ["", "queued 2/4", "runningly", "lost missing"])
      expect(() => parseJobStatus(line, startedAt, NOW)).toThrow("job status");
  });

  test("validates configured commands and positive job thresholds", () => {
    expect(parseConfig(`${DEMO_TOML}\n[jobs.eval]\nstart = "./start.sh"\nstop = "./stop.sh"`).jobs.eval).toEqual({
      start: "./start.sh",
      status: null,
      stop: "./stop.sh",
      silenceMinutes: 15,
      maxHours: null,
    });
    for (const field of ["silence_minutes = 0", "max_hours = -1", 'status = ""', "typo = 1"])
      expect(() => parseConfig(`${DEMO_TOML}\n[jobs.eval]\nstart = "start"\nstop = "stop"\n${field}`)).toThrow();
  });

  test("worker jobs are limited to their own persisted ticket, including reads and forged observations", async () => {
    const store = memoryFleet();
    const request = (op: string, input: object, ticket = "DEMO-7") =>
      serveFleet(
        store,
        {
          op,
          project: DEMO_PROJECT,
          caller: { kind: "worker", ticket, sessionId: "worker-1" },
          input,
        },
        { now: () => NOW },
      );
    expect((await request("job/start", { ticket: "DEMO-8", name: "eval" })).status).toBe(403);
    const own = await request("job/start", { ticket: "DEMO-7", name: "eval", startedBy: "forged" });
    expect(own.status).toBe(200);
    const id = (own.body.result as { id: number }).id;
    expect((own.body.result as { startedBy: string }).startedBy).toBe("worker-1");
    const other = await request("job/start", { ticket: "DEMO-8", name: "eval" }, "DEMO-8");
    const otherId = (other.body.result as { id: number }).id;
    expect((await request("job/list", {})).body.result).toEqual([own.body.result]);
    expect((await request("job/list", { ticket: "DEMO-8" })).status).toBe(403);
    expect((await request("job/list", { id: otherId })).body.result).toEqual([]);
    expect((await request("job/observe", { ticket: "DEMO-7", id: otherId, state: "stopped" })).status).toBe(403);
    expect(
      (await request("job/observe", { ticket: "DEMO-7", id, state: "running", ref: "run-123", progress: "1/2" }))
        .status,
    ).toBe(200);
    expect((await request("job/observe", { ticket: "DEMO-7", id, state: "running", ref: "replacement" })).status).toBe(
      400,
    );
  });

  test("the client preserves durable jobs across sessions and project boundaries", async () => {
    const { fleet, store } = tempFleet();
    const job = await fleet.startJob({ ticket: "DEMO-7", name: "eval" });
    expect(job.state).toBe("starting");
    const observed = await fleet.observeJob({
      ticket: job.ticket,
      id: job.id,
      state: "running",
      ref: "runner-1",
      progress: "37/120 cases",
      eta: "2026-03-04T12:14:35.676Z",
    });
    expect(observed?.ref).toBe("runner-1");
    expect(await fleet.listJobs({ open: true })).toEqual(observed ? [observed] : []);
    expect(await store.getJob("another-project", job.id)).toBeNull();
    expect((await fleet.observeJob({ ticket: job.ticket, id: job.id, state: "stopped" }))?.finishedAt).toBe(
      NOW.toISOString(),
    );
    expect(await fleet.listJobs({ open: true })).toEqual([]);
    expect((await fleet.observeJob({ ticket: job.ticket, id: job.id, state: "running" }))?.state).toBe("stopped");
  });
});

test("an overdue job stays visible when its ticket is Done; status only reads stored job observations", async () => {
  const { readStatusSources, buildStatus } = await import("../src/status.ts");
  const { recordedFetch } = await import("./support.ts");
  const config = parseConfig(`${DEMO_TOML}\n[jobs.eval]\nstart = "start"\nstop = "stop"\nmax_hours = 0.5`);
  const sources = await readStatusSources(config, {
    linearApiKey: "k",
    githubToken: "t",
    fetch: recordedFetch().fetch,
    now: () => NOW,
  });
  const ticket = sources.program.issues.find((i) => i.id === "DEMO-11");
  if (!ticket) throw new Error("fixture ticket missing");
  ticket.statusType = "completed";
  const store = memoryFleet();
  const job = await store.startJob({
    project: "widgets",
    ticket: ticket.id,
    name: "eval",
    startedBy: "worker",
    at: new Date(startedAt),
  });
  await store.observeJob({
    project: "widgets",
    ticket: job.ticket,
    id: job.id,
    state: "running",
    ref: "run-1",
    progress: "37/120 cases",
    at: NOW,
  });
  const report = buildStatus({ config, ...sources, now: NOW, jobs: await store.listJobs("widgets", { open: true }) });
  expect(report.jobs?.[0]).toMatchObject({
    state: "running",
    overdue: true,
    ticketDone: true,
    ref: "run-1",
    progress: "37/120 cases",
  });
  expect((await store.getJob("widgets", job.id))?.state).toBe("running");
});
