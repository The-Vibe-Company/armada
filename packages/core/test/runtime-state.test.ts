import { describe, expect, test } from "bun:test";
import { ArmadaApiError } from "../src/armada-api.ts";
import type { LiveEvent } from "../src/fleet.ts";
import { serveFleet } from "../src/fleet-api.ts";
import { readInbox } from "../src/live.ts";
import { buildStatus, loadStatus } from "../src/status.ts";
import { DEMO_PROJECT, demoConfig, issue, NOW, recordedFetch, tempFleet } from "./support.ts";

const claim = {
  ticket: "DEMO-11",
  runtime: "Herdr",
  handle: '{"workspace":"local","pane":"pane-one","agent":"agent-one"}',
  branch: "feature/demo-11",
  phase: "implementing",
  resuming: false,
  profile: null,
};
const advance = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

describe("runtime readings", () => {
  test("organization operations target an exact claim, use server time, and allow archiving an already released claim", async () => {
    const { fleet, store, clock } = tempFleet();
    await fleet.claim(claim);
    const input = {
      ticket: claim.ticket,
      handle: claim.handle,
      claimedAt: NOW.toISOString(),
      state: "blocked" as const,
    };
    clock.advance(60_000);
    expect(await fleet.observeRuntime(input)).toBe(true);
    expect((await fleet.runtimeHandles())[0]?.runtimeState).toEqual({
      state: "blocked",
      at: advance(1).toISOString(),
      since: advance(1).toISOString(),
    });
    expect(await fleet.observeRuntime({ ...input, claimedAt: advance(-1).toISOString() })).toBe(false);
    const worker = tempFleet({ store, caller: { kind: "worker", ticket: claim.ticket } }).fleet;
    for (const call of [
      () => worker.runtimeHandles(),
      () => worker.runtimeHandle(claim.ticket),
      () => worker.observeRuntime(input),
      () => worker.stopRuntime(input),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ArmadaApiError);
    }
    const deps = { now: () => NOW };
    expect(
      (
        await serveFleet(
          store,
          {
            op: "runtime/observe",
            project: DEMO_PROJECT,
            caller: { kind: "organization" },
            input: { ...input, state: "invented" },
          },
          deps,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await serveFleet(
          store,
          {
            op: "runtime/observe",
            project: DEMO_PROJECT,
            caller: { kind: "organization" },
            input: { ...input, claimedAt: null },
          },
          deps,
        )
      ).status,
    ).toBe(400);
    await fleet.release({ ticket: claim.ticket, reason: "done" });
    expect(await fleet.observeRuntime(input)).toBe(false);
    expect(await fleet.stopRuntime(input)).toBe(true);
    expect((await fleet.runtimeHandle(claim.ticket))?.releasedAt).toBe(advance(1).toISOString());
    clock.advance(60_000);
    await fleet.claim(claim);
    expect((await fleet.runtimeHandles())[0]?.runtimeState).toBeNull();
    expect(await fleet.stopRuntime(input)).toBe(false);
    expect((await fleet.runtimeHandles()).length).toBe(1);
  });

  test("a new runtime sequence resurfaces the next approval even when both readings say blocked", async () => {
    const { fleet, store, clock } = tempFleet();
    await fleet.claim(claim);
    const input = {
      ticket: claim.ticket,
      handle: claim.handle,
      claimedAt: NOW.toISOString(),
      state: "blocked" as const,
      sequence: 4,
    };
    const inbox = () => readInbox(store, { project: "widgets", now: clock.now(), silentAfterMinutes: 15 });
    await fleet.observeRuntime(input);
    expect((await inbox()).map((entry) => entry.kind)).toEqual(["runtime-blocked"]);
    clock.advance(60_000);
    await fleet.answer({ text: "Proceed", note: false, ticket: claim.ticket, item: null });
    clock.advance(60_000);
    await fleet.observeRuntime(input);
    expect(await inbox()).toEqual([]);
    clock.advance(60_000);
    await fleet.observeRuntime({ ...input, sequence: 6 });
    expect((await inbox()).map((entry) => entry.kind)).toEqual(["runtime-blocked"]);
    expect((await fleet.runtimeHandles())[0]?.runtimeState).toEqual({
      state: "blocked",
      sequence: 6,
      at: advance(3).toISOString(),
      since: advance(3).toISOString(),
    });
    for (const sequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "6", null]) {
      expect(
        (
          await serveFleet(
            store,
            {
              op: "runtime/observe",
              project: DEMO_PROJECT,
              caller: { kind: "organization" },
              input: { ...input, sequence },
            },
            { now: () => clock.now() },
          )
        ).status,
      ).toBe(400);
    }
  });

  test("an open persisted claim puts a stale unstarted tracker leaf in flight and newer end events still remove it", () => {
    const handle = {
      ...claim,
      claimedAt: NOW.toISOString(),
      releasedAt: null as string | null,
      runtimeState: { state: "blocked" as const, at: NOW.toISOString() },
    };
    const program = {
      rootId: "DEMO-1",
      fetchedAt: advance(-1).toISOString(),
      issues: [issue("DEMO-1"), issue(claim.ticket, { parentId: "DEMO-1" })],
      comments: [],
      warnings: [],
    };
    const read = (held: typeof handle | null, event?: LiveEvent) =>
      buildStatus({
        config: demoConfig(),
        program,
        forge: null,
        now: NOW,
        live: {
          after: program.fetchedAt,
          events: event ? { [claim.ticket]: event } : {},
          handles: held ? { [claim.ticket]: held } : {},
        },
      }).inFlight;
    expect(read(null)).toEqual([]);
    expect(read(handle)).toMatchObject([{ id: claim.ticket, handle: claim.handle, runtimeState: "blocked" }]);
    expect(read({ ...handle, releasedAt: NOW.toISOString() })).toEqual([]);
    for (const kind of ["release", "merge"]) {
      const event = { kind, phase: null, message: null, at: advance(1).toISOString() };
      expect(read(handle, event)).toEqual([]);
      expect(read({ ...handle, claimedAt: advance(2).toISOString() }, event).map((t) => t.id)).toEqual([claim.ticket]);
    }
  });

  test("status uses persisted handles and expires their state without replacing the last report", async () => {
    const { fetch } = recordedFetch();
    const live = tempFleet();
    await live.fleet.claim(claim);
    const input = {
      ticket: claim.ticket,
      handle: claim.handle,
      claimedAt: NOW.toISOString(),
      state: "blocked" as const,
    };
    await live.fleet.observeRuntime(input);
    const options = {
      linearApiKey: "synthetic",
      githubToken: null,
      fetch,
      runtimeHandles: () => live.fleet.runtimeHandles(),
    };
    const status = await loadStatus(demoConfig(), { ...options, now: () => advance(15) });
    expect(status.inFlight.find((t) => t.id === claim.ticket)).toMatchObject({
      handle: claim.handle,
      runtimeState: "blocked",
      lastReport: "2026-03-04T09:10:00.000Z",
    });
    const stale = await loadStatus(demoConfig(), { ...options, fetch: recordedFetch().fetch, now: () => advance(16) });
    expect(stale.inFlight.find((t) => t.id === claim.ticket)?.runtimeState).toBeNull();
    await live.fleet.observeRuntime({ ...input, state: "unknown" });
    const unknown = await loadStatus(demoConfig(), { ...options, fetch: recordedFetch().fetch, now: () => NOW });
    expect(unknown.inFlight.find((t) => t.id === claim.ticket)?.runtimeState).toBeNull();
  });

  test("blocked runtime enters the inbox before a report, clears when stale or answered, and avoids question and plan duplicates", async () => {
    const { fleet, store, clock } = tempFleet();
    await fleet.claim(claim);
    const input = {
      ticket: claim.ticket,
      handle: claim.handle,
      claimedAt: NOW.toISOString(),
      state: "blocked" as const,
    };
    await fleet.observeRuntime(input);
    const read = (minutes: number) =>
      readInbox(store, { project: "widgets", now: advance(minutes), silentAfterMinutes: 15 });
    expect((await read(0)).map((e) => [e.id, e.kind, e.ticket])).toEqual([[null, "runtime-blocked", claim.ticket]]);
    expect((await read(16)).some((e) => e.kind === "runtime-blocked")).toBe(false);
    const question = await fleet.ask({ ticket: claim.ticket, body: "Allow this command?" });
    expect((await read(0)).map((e) => e.kind)).toEqual(["question"]);
    clock.advance(60_000);
    await fleet.answer({ text: "Proceed", note: false, item: question, ticket: claim.ticket });
    expect(await read(1)).toEqual([]);
    clock.advance(60_000);
    await fleet.observeRuntime(input);
    expect(await read(2)).toEqual([]);
    await fleet.observeRuntime({ ...input, state: "working" });
    clock.advance(60_000);
    await fleet.observeRuntime(input);
    expect((await read(3)).map((e) => e.kind)).toEqual(["runtime-blocked"]);
    await store.putPlan({
      project: "widgets",
      ticket: claim.ticket,
      author: claim.handle,
      body: "Please approve the plan",
      at: advance(3),
    });
    expect((await read(3)).map((e) => e.kind)).toEqual(["plan"]);
  });
});
