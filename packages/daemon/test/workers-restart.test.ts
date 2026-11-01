import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeProvider, WorkerRef } from "@armada/plugin-api";
import { fold } from "../src/fold.ts";
import { PluginRegistry } from "../src/plugins/registry.ts";
import { dispatchSession } from "../src/server/session.ts";
import { EventStore } from "../src/store.ts";
import { Workers } from "../src/workers/service.ts";

const project = "orchard";
const at = "2030-01-01T00:00:00.000Z";
for (const scenario of [
  "both adopted",
  "one worker lost",
  "interrupted launch",
  "lost runtime refuses stop",
  "close during launch",
  "close during preparation",
  "close before native entry",
  "merge confirmed before cleanup",
  "merge confirmed after native stop",
  "merge confirmed after cleanup before receipt",
  "runtime returned a different handle",
  "lost brief preflight refuses before stop",
  "brief changes during relaunch stop",
  "plan policy changes before stop",
  "plan policy changes during stop",
]) {
  const lost = scenario === "one worker lost" || scenario === "lost runtime refuses stop";
  test(`restart preserves generations, capabilities and phases; ${scenario}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "armada-restart-"));
    const native = new Map<string, { ref: WorkerRef; alive: boolean; messages: string[]; token: string }>();
    let stops = 0;
    const preNative = scenario === "close during preparation" || scenario === "close before native entry";
    const merged = scenario.startsWith("merge confirmed");
    const mismatched = scenario === "runtime returned a different handle";
    const lostBrief = scenario === "lost brief preflight refuses before stop";
    const changedBrief = scenario === "brief changes during relaunch stop";
    let uncertain = lostBrief;
    const policyChange = scenario.startsWith("plan policy changes");
    const total =
      scenario.startsWith("close ") || merged || mismatched || lostBrief || changedBrief || policyChange ? 1 : 2;
    let disposed = 0;
    let firstBoot = true;
    if (changedBrief) await writeFile(join(directory, "AGENTS.md"), "Prepared instructions before stopping");
    let nativeEntered!: () => void;
    let releaseNative!: () => void;
    const entered = new Promise<void>((resolve) => {
      nativeEntered = resolve;
    });
    const nativeGate = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    let interrupt = scenario === "interrupted launch";
    let observeGate: Promise<void> | undefined;
    let store = new EventStore(join(directory, "fleet.sqlite"));
    const requireApproval = () => {
      const ticket = fold(store.readSince(0)).projects[project]!.tickets.find((row) => row.id === "SEED-1")!;
      store.append({
        project,
        at,
        actor: "tracker",
        kind: "ticket.seen",
        payload: { ...ticket, labels: [...(ticket.labels ?? []), "needs-plan-approval"] },
      });
    };
    const make = () => {
      const registry = new PluginRegistry();
      const activation = registry.activation({
        id: "fixture",
        version: "1.0.0",
        pluginApi: "*",
        description: "Synthetic restart runtime",
        enabledByDefault: true,
        contributions: {
          runtime: { claude: { config: true, secrets: [] } },
          node: { local: { config: true, secrets: [] } },
        },
      });
      const runtime: RuntimeProvider = {
        withNode: () => runtime,
        prepare: async ({ ticket }) => {
          if (firstBoot && scenario === "close during preparation") {
            nativeEntered();
            await nativeGate;
          }
          return { id: ticket, path: directory, node: "local" };
        },
        launch: async ({ worker, env, handle }) => {
          const ref = { ...worker, handle: mismatched ? randomUUID() : (handle ?? randomUUID()) };
          native.set(ref.handle, { ref, alive: true, messages: [], token: env.ARMADA_WORKER_TOKEN! });
          if (scenario === "close during launch") {
            nativeEntered();
            await nativeGate;
          }
          if (interrupt) {
            interrupt = false;
            throw new Error("Native launch reply interrupted");
          }
          return ref;
        },
        adopt: async (ref) => {
          assert.deepEqual(native.get(ref.handle)?.ref, ref);
          return { deliveries: native.get(ref.handle)!.messages.length };
        },
        observe: async (ref) => {
          await observeGate;
          return {
            state:
              !firstBoot && uncertain && native.get(ref.handle)?.alive
                ? "unknown"
                : native.get(ref.handle)?.alive
                  ? "running"
                  : "stopped",
          };
        },
        deliver: async (ref, message) => {
          assert(native.get(ref.handle)?.alive);
          native.get(ref.handle)!.messages.push(message);
        },
        stop: async (ref) => {
          if (scenario === "lost runtime refuses stop" && ref.ticket === "SEED-1")
            throw new Error("Native identity unavailable");
          native.get(ref.handle)!.alive = false;
          stops++;
          if (!firstBoot && scenario === "plan policy changes during stop") requireApproval();
          if (!firstBoot && changedBrief) await writeFile(join(directory, "armada.toml"), "[brief");
        },
      };
      activation.register.runtime("claude", runtime);
      activation.register.node("local", {
        ...runtime,
        dispose: async () => {
          disposed++;
        },
      });
      activation.commit();
      return new Workers({
        store,
        registry,
        projects: [{ id: project, repository: "example/orchard", checkout: directory }],
        socketPath: join(directory, "worker.sock"),
        now: () => at,
      });
    };
    let workers = make();
    t.after(async () => {
      await workers.shutdown(project, "fixture cleanup", () => {});
      await workers.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    });
    for (const ticket of ["SEED-1", "SEED-2"].slice(0, total)) {
      store.append({
        project,
        at,
        actor: "tracker",
        kind: "ticket.seen",
        payload: {
          id: ticket,
          title: "Plant",
          labels: ["ready-for-agent", ...(policyChange ? ["plan-approved"] : [])],
          status: "unstarted",
          description: "Plant safely",
          branchName: `worker/${ticket.toLowerCase()}`,
          blockers: [],
        },
      });
    }
    store.append({
      project,
      at,
      actor: "coordinator",
      kind: "coordinator.checkpoint",
      payload: {
        checkpoint: {
          format: "armada.tools",
          version: 1,
          type: "rules",
          rules: {
            revision: 1,
            value: {
              defaultRoute: { cli: "claude", model: "fixture" },
              placement: { workers: "local", coordinator: "local" },
            },
          },
        },
      },
    });
    for (const ticket of ["SEED-1", "SEED-2"].slice(0, total)) {
      if (scenario.startsWith("close ")) {
        let closing: Promise<void> | undefined;
        const launching = workers.tool(project, "worker.launch", { ticket }, `launch:${ticket}`, () => {
          if (
            scenario === "close before native entry" &&
            !closing &&
            store.readSince(0).some((event) => {
              const c = event.kind === "coordinator.checkpoint" ? event.payload.checkpoint : null;
              return c && typeof c === "object" && !Array.isArray(c) && c.step === "starting";
            })
          ) {
            closing = workers.close();
            nativeEntered();
          }
        });
        await entered;
        const phase = fold(store.readSince(0)).projects[project]!.sessions[0]!.phase;
        closing ??= workers.close();
        releaseNative();
        await assert.rejects(launching);
        await closing;
        assert.equal(fold(store.readSince(0)).projects[project]!.sessions[0]!.phase, phase);
        continue;
      }
      if (mismatched) {
        await assert.rejects(
          workers.tool(project, "worker.launch", { ticket }, `launch:${ticket}`, () => {}),
          /different worker generation/,
        );
        assert.equal([...native.values()][0]!.messages.length, 0);
        continue;
      }
      if (interrupt) {
        await assert.rejects(
          workers.tool(project, "worker.launch", { ticket }, `launch:${ticket}`, () => {}),
          /launch reply interrupted/,
        );
        continue;
      }
      await workers.tool(project, "worker.launch", { ticket }, `launch:${ticket}`, () => {});
      const row = [...native.values()].find((row) => row.ref.ticket === ticket)!;
      await workers.request(row.token, { command: "claim", ticket });
      await workers.request(row.token, { command: "report", ticket, phase: "implementing", message: "Working" });
    }
    let cleaned: WorkerRef | undefined;
    if (merged) {
      const row = [...native.values()][0]!;
      store.append({
        project,
        at,
        actor: "merge",
        kind: "merge.confirmed",
        payload: {
          id: "merge:1",
          ticket: row.ref.ticket,
          session: row.ref.session,
          pr: 1,
          head: "a".repeat(40),
        },
      });
      if (scenario === "merge confirmed after native stop") row.alive = false;
      if (scenario === "merge confirmed after cleanup before receipt") {
        cleaned = row.ref;
        await workers.stop(row.ref, "Merge cleanup before host crash", () => {});
        native.delete(row.ref.handle);
      }
    }
    const before = fold(store.readSince(0)).projects[project]!.sessions;
    await workers.close();
    assert.equal(stops, cleaned ? 1 : 0, "closing the daemon must leave native processes running");
    assert.deepEqual(fold(store.readSince(0)).projects[project]!.sessions, before);
    assert(
      ![...native.values()].some((row) => JSON.stringify(store.readSince(0)).includes(row.token)),
      "raw capability never enters the log",
    );
    if (lost) [...native.values()][0]!.alive = false;
    store.close();
    store = new EventStore(join(directory, "fleet.sqlite"));
    firstBoot = false;
    workers = make();
    if (merged) {
      assert.deepEqual(await workers.recover(), { readopted: [], lost: [] });
      const row = [...native.values()][0];
      const ref = row?.ref ?? cleaned!;
      const result = await workers.tool(
        project,
        "worker.stop",
        {
          ticket: ref.ticket,
          session: ref.session,
          reason: "Finish confirmed merge cleanup",
        },
        "merge-cleanup-after-restart",
        () => {},
      );
      assert.equal(result.stopped, true);
      assert.equal(row?.alive ?? false, false);
      assert.equal(disposed, 1);
      assert.equal(fold(store.readSince(0)).projects[project]!.sessions[0]!.phase, "merged");
      return;
    }
    if (mismatched) {
      const result = await workers.recover();
      assert.equal(result.readopted.length, 0);
      assert.equal(result.lost.length, 1);
      assert.notEqual(result.lost[0]!.handle, [...native.values()][0]!.ref.handle);
      assert.equal(stops, 0, "a different handle must never be silently admitted or stopped");
      return;
    }
    if (policyChange) {
      assert.equal((await workers.recover()).readopted.length, 1);
      assert.match([...native.values()][0]!.messages[0]!, /Plans are pre-approved/);
      let checks = 0;
      await assert.rejects(
        workers.tool(
          project,
          "worker.relaunch",
          { ticket: "SEED-1", reason: "Continue with current plan policy" },
          "changed-plan-policy",
          () => {
            checks++;
            if (scenario === "plan policy changes before stop" && checks === 2) requireApproval();
          },
        ),
        /brief preflight/,
      );
      assert.equal(stops, scenario === "plan policy changes before stop" ? 0 : 1);
      assert.equal(native.size, 1, "no replacement may receive cached pre-approval after the policy changes");
      return;
    }
    if (lostBrief) {
      assert.equal((await workers.recover()).lost.length, 1);
      const phase = fold(store.readSince(0)).projects[project]!.sessions[0]!.phase;
      await writeFile(join(directory, "armada.toml"), "[brief");
      await assert.rejects(
        workers.tool(
          project,
          "worker.relaunch",
          { ticket: "SEED-1", reason: "Recover the uncertain worker" },
          "lost-brief-preflight",
          () => {},
        ),
        /Cannot read repository brief context/,
      );
      assert.equal(stops, 0, "a refused replacement brief must not stop the recoverable old worker");
      assert.equal([...native.values()][0]!.alive, true);
      assert.equal(fold(store.readSince(0)).projects[project]!.sessions[0]!.phase, phase);
      uncertain = false;
      return;
    }
    if (changedBrief) {
      assert.equal((await workers.recover()).readopted.length, 1);
      const replacement = await workers.tool(
        project,
        "worker.relaunch",
        { ticket: "SEED-1", reason: "Continue in the same worktree" },
        "captured-brief",
        () => {},
      );
      assert.equal(replacement.generation, 2);
      assert.equal(stops, 1);
      const launched = native.get(String(replacement.handle))!;
      assert(launched.alive);
      assert.match(launched.messages[0]!, /Prepared instructions before stopping/);
      return;
    }
    if (preNative) {
      assert.equal(native.size, 0);
      assert.equal(disposed, 1);
      const result = await workers.recover();
      assert.equal(result.readopted.length, 0);
      assert.equal(result.lost.length, 1);
      assert.match(result.lost[0]!.reason, /no worker was started/);
      const replacement = await workers.tool(
        project,
        "worker.relaunch",
        {
          ticket: "SEED-1",
          reason: "Resume the generation interrupted before native launch",
        },
        "retry-pre-native",
        () => {},
      );
      assert.equal(replacement.generation, 2);
      assert.equal(native.size, 1);
      assert.equal((await workers.shutdown(project, "fixture finished", () => {})).ok, true);
      return;
    }
    let ready!: () => void;
    observeGate = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const recovering = workers.recover();
    const survivor = [...native.values()].find((row) => row.alive)!;
    let recorded = false;
    const duringBoot = workers
      .request(survivor.token, { command: "heartbeat", ticket: survivor.ref.ticket })
      .then(() => {
        recorded = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(recorded, false, "a capability request waits for boot recovery instead of being refused");
    ready();
    const recovery = await recovering;
    await duringBoot;
    assert.equal(recovery.readopted.length, total - (lost ? 1 : 0));
    assert.equal(recovery.lost.length, lost ? 1 : 0);
    const identity = (sessions: typeof before) =>
      sessions.map(({ ticket, session, generation, handle, phase }) => ({
        ticket,
        session,
        generation,
        handle,
        phase,
      }));
    assert.deepEqual(
      identity(fold(store.readSince(0)).projects[project]!.sessions),
      identity(before),
      "recovery does not change ticket phases or generations",
    );
    for (const row of native.values()) {
      const { ref } = row;
      if (!row.alive) {
        assert(
          store.readSince(0).some((event) => event.kind === "worker.lost" && event.payload.session === ref.session),
        );
        continue;
      }
      await workers.tool(
        project,
        "worker.message",
        { ticket: ref.ticket, session: ref.session, message: "Continue" },
        `message:${ref.ticket}`,
        () => {},
      );
      await workers.answer(
        { key: `answer:${ref.ticket}`, session: ref, answer: "Approved", beforeWrite: () => {} },
        project,
      );
      assert.deepEqual(row.messages.slice(-2), ["Continue", "Approved"]);
      await workers.request(row.token, { command: "heartbeat", ticket: ref.ticket });
    }
    if (scenario === "lost runtime refuses stop") {
      const old = [...native.values()][0]!;
      const released = await dispatchSession(
        {
          type: "session.release",
          version: { major: 1, minor: 15 },
          id: "release-lost",
          project,
          ticket: old.ref.ticket,
          session: old.ref.session,
          generation: old.ref.generation,
          reason: "Owner releases the lost ticket",
        },
        { workers, store },
      );
      assert.equal(released.type, "session.release.result");
      if (released.type === "session.release.result") assert.equal(released.stopped, false);
      assert.equal(
        fold(store.readSince(0)).projects[project]!.sessions.find((row) => row.ticket === old.ref.ticket)?.phase,
        "released",
      );
    } else if (lost) {
      const old = [...native.values()][0]!;
      const replacement = await workers.tool(
        project,
        "worker.relaunch",
        { ticket: old.ref.ticket, session: old.ref.session, reason: "Worker exited between daemon runs" },
        "relaunch-lost",
        () => {},
      );
      assert.equal(replacement.generation, old.ref.generation + 1);
      assert.notEqual(replacement.session, old.ref.session);
      await assert.rejects(
        workers.request(old.token, { command: "heartbeat", ticket: old.ref.ticket }),
        /authorization/,
      );
      await assert.rejects(
        workers.tool(
          project,
          "worker.stop",
          { ticket: old.ref.ticket, session: old.ref.session, reason: "Stale stop" },
          "stale-stop",
          () => {},
        ),
        /generation changed/,
      );
      assert.equal(native.get(String(replacement.handle))?.alive, true);
    }
    const stopped = await workers.shutdown(project, "Owner quit the fleet", () => {});
    assert.equal(stopped.ok, true);
    assert.equal(
      fold(store.readSince(0)).projects[project]!.sessions.every((row) => row.phase === "released"),
      true,
    );
  });
}
