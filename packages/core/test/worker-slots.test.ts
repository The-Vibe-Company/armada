import { expect, test } from "bun:test";
import { workerSlots } from "../src/live.ts";
import { memoryFleet } from "./memory-fleet.ts";
import { NOW } from "./support.ts";

test("slots count project sessions and unclaimed launches once, excluding coordinators, releases and expired unused tokens", async () => {
  const store = memoryFleet();
  for (const [ticket, handle] of [
    ["DEMO-1", "coordinator/session"],
    ["DEMO-7", "worker/7"],
    ["DEMO-8", "worker/8"],
    ["DEMO-9", "worker/9"],
  ] as const)
    await store.saveRuntimeHandle({
      project: "widgets",
      ticket,
      handle,
      runtime: "Conductor",
      branch: null,
      at: NOW,
    });
  await store.releaseRuntimeHandle("widgets", "DEMO-9", NOW);
  await store.recordEvent({
    project: "widgets",
    ticket: "DEMO-8",
    kind: "report",
    phase: "ready-to-merge",
    message: null,
    at: NOW,
  });
  await store.recordCoordinatorSeen({
    project: "widgets",
    name: "front",
    handle: "coordinator/session",
    cliVersion: null,
    inboxRead: true,
    at: NOW,
  });
  const launch = { launchedAt: NOW.toISOString(), tokenUsedAt: null, runtime: null, handle: null };
  const slots = workerSlots({
    handles: (
      await Promise.all(["DEMO-1", "DEMO-7", "DEMO-8", "DEMO-9"].map((t) => store.getRuntimeHandle("widgets", t)))
    ).filter((h) => h !== null),
    launches: [
      { ...launch, ticket: "DEMO-7" },
      { ...launch, ticket: "DEMO-10" },
      { ...launch, ticket: "DEMO-11", tokenExpiresAt: NOW.toISOString() },
      { ...launch, ticket: "DEMO-12", tokenExpiresAt: NOW.toISOString(), tokenUsedAt: NOW.toISOString() },
    ],
    coordinators: await store.listCoordinators("widgets"),
    now: NOW,
  });
  expect(slots).toEqual({ taken: 4, tickets: ["DEMO-10", "DEMO-12", "DEMO-7", "DEMO-8"] });
});
