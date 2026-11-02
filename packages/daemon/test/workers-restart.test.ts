import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type RuntimeProvider, type WorkerRef, WorkerRuntimeAlive, WorkerRuntimeGone } from "@armada/plugin-api";
import { queueDelivery } from "../src/deliveries.ts";
import { fold } from "../src/fold.ts";
import { PluginRegistry } from "../src/plugins/registry.ts";
import { dispatchSession } from "../src/server/session.ts";
import { EventStore } from "../src/store.ts";
import { Workers } from "../src/workers/service.ts";

const project = "orchard";
const at = "2030-01-01T00:00:00.000Z";
for (const scenario of [
  "both adopted",
  "queued input waits for worker re-adoption",
  "pending GitHub feedback waits for recovery",
  "pending GitHub feedback waits for initial brief",
  "GitHub feedback arriving during delivery is retained",
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
  "runtime proven gone",
  "runtime unknown without a liveness contract",
  "concurrent relaunch of a gone runtime",
  "gone relaunch lands elsewhere",
]) {
  const lost = scenario === "one worker lost" || scenario === "lost runtime refuses stop";
  // THE-2212: the runtime itself could not reattach: either it proved the tree gone, or it could not say.
  const gone =
    scenario === "runtime proven gone" ||
    scenario === "concurrent relaunch of a gone runtime" ||
    scenario === "gone relaunch lands elsewhere";
  let priorAlive = false;
  const unknownRuntime = scenario === "runtime unknown without a liveness contract";
  test(`restart preserves generations, capabilities and phases; ${scenario}`, { timeout: 15000 }, async (t) => {
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
      scenario.startsWith("close ") ||
      merged ||
      mismatched ||
      lostBrief ||
      changedBrief ||
      policyChange ||
      gone ||
      unknownRuntime
        ? 1
        : 2;
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
    let interrupt =
      scenario === "interrupted launch" ||
      scenario === "pending GitHub feedback waits for initial brief" ||
      scenario === "queued input waits for worker re-adoption";
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
          if (!firstBoot && scenario === "gone relaunch lands elsewhere")
            return { id: ticket, path: join(directory, "elsewhere"), node: "local" };
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
          if (!firstBoot && gone && !native.get(ref.handle)?.alive)
            throw new WorkerRuntimeGone(
              "local worker SEED-1 generation 1 is unreachable: the supervisor endpoint refused the connection, and no final record exists; its liveness contract (version 1) names a process group that no longer exists, so its whole process tree ended; nothing was signaled",
            );
          if (!firstBoot && unknownRuntime && priorAlive)
            throw new WorkerRuntimeAlive(
              "local worker SEED-1 generation 1 is unreachable: the supervisor endpoint refused the connection, and no final record exists; its pinned process group still exists, so the worker's CLI or a descendant still runs; nothing was signaled",
            );
          if (!firstBoot && unknownRuntime)
            throw new Error(
              "local worker SEED-1 generation 1 is unreachable: the supervisor endpoint refused the connection, and no final record exists; no liveness contract was recorded for it, so its process tree may still run; nothing was signaled",
            );
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
          if (
            !firstBoot &&
            scenario === "GitHub feedback arriving during delivery is retained" &&
            message.includes("pending feedback 1")
          ) {
            nativeEntered();
            await nativeGate;
          }
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
    if (scenario === "queued input waits for worker re-adoption") {
      const { ref } = [...native.values()][0]!;
      store.append(
        queueDelivery({
          project,
          at,
          actor: "coordinator",
          ticket: ref.ticket,
          session: ref.session,
          generation: ref.generation,
          source: "coordinator-message",
          text: "Queued before restart: ticket SEED-1 plants safely; parent instructions preserve the garden.",
          key: "pre-restart-input",
        }),
      );
    }
    if (lost) [...native.values()][0]!.alive = false;
    store.close();
    store = new EventStore(join(directory, "fleet.sqlite"));
    firstBoot = false;
    const feedback = (comment: number) =>
      store.append({
        project,
        at,
        actor: "github",
        kind: "pull-request.commented",
        payload: {
          key: `review:restart:${comment}`,
          repository: "example/orchard",
          ticket: "SEED-1",
          pr: 41,
          head: "a".repeat(40),
          author: "reviewer",
          worker: "worker",
          body: `Preserve pending feedback ${comment}`,
          url: `https://github.com/example/orchard/pull/41#discussion_r${comment}`,
          at,
          comment: String(comment),
        },
      });
    if (scenario.startsWith("pending GitHub feedback")) {
      feedback(1);
      feedback(2);
    }
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
    if (gone || unknownRuntime) {
      const old = [...native.values()][0]!;
      if (gone) old.alive = false;
      const recovery = await workers.recover();
      assert.equal(recovery.readopted.length, 0);
      assert.equal(recovery.lost.length, 1);
      const recorded = store.readSince(0).find((event) => event.kind === "worker.lost");
      assert(recorded?.kind === "worker.lost");
      assert.match(recorded.payload.reason, /nothing was signaled/, "the actual cause is recorded, not a generic line");
      const before = fold(store.readSince(0)).projects[project]!.sessions[0]!;
      if (unknownRuntime) {
        assert.match(recorded.payload.reason, /no liveness contract/);
        assert.match(recorded.payload.reason, /Next: if its process still runs.*worker\.stop with a reason/);
        await assert.rejects(
          workers.tool(
            project,
            "worker.relaunch",
            { ticket: "SEED-1", session: old.ref.session, reason: "Replace the unknown worker" },
            "relaunch-unknown",
            () => {},
          ),
          /cannot be replaced automatically.*no liveness contract.*worker\.stop with a reason/s,
        );
        assert.equal(stops, 0, "nothing is signaled for a worker that may still run");
        assert.equal(native.size, 1, "no replacement without proof the old tree ended");
        assert.equal(fold(store.readSince(0)).projects[project]!.sessions[0]!.phase, before.phase);
        const released = await workers.tool(
          project,
          "worker.stop",
          { ticket: "SEED-1", session: old.ref.session, reason: "Owner checked the machine: nothing runs" },
          "release-unknown",
          () => {},
        );
        assert.equal(released.stopped, false, "an explicit release never claims a stop");
        assert.equal(released.released, true);
        assert.match(String(released.next), /worker\.launch continues in the kept worktree/);
        assert.equal(stops, 0);
        // Another daemon boot forgets nothing: the launch still probes the released generation.
        await workers.close();
        store.close();
        store = new EventStore(join(directory, "fleet.sqlite"));
        workers = make();
        assert.deepEqual(
          await workers.recover(),
          { readopted: [], lost: [] },
          "a released generation is not recovered",
        );
        priorAlive = true;
        await assert.rejects(
          workers.tool(project, "worker.launch", { ticket: "SEED-1" }, "launch-beside-alive", () => {}),
          /still runs in its kept worktree.*nothing was launched/,
          "a launch never lands beside a process group the runtime can still see",
        );
        assert.equal(native.size, 1);
        assert.equal(stops, 0);
        priorAlive = false;
        const relaunched = await workers.tool(
          project,
          "worker.launch",
          { ticket: "SEED-1" },
          "launch-after-release",
          () => {},
        );
        assert.equal(relaunched.generation, 2, "the deliberate path continues in the kept worktree");
        assert.equal(native.size, 2);
        return;
      }
      assert.match(recorded.payload.reason, /process tree ended/);
      assert.match(recorded.payload.reason, /Next: worker\.relaunch with a reason replaces it in its kept worktree/);
      const relaunch = (key: string) =>
        workers.tool(
          project,
          "worker.relaunch",
          { ticket: "SEED-1", session: old.ref.session, reason: "Daemon restart killed the supervisor" },
          key,
          () => {},
        );
      if (scenario === "gone relaunch lands elsewhere") {
        await assert.rejects(relaunch("relaunch-elsewhere"), /not the lost worker's kept worktree/);
        assert.equal(native.size, 1, "no replacement outside the kept worktree");
        assert.equal(stops, 0);
        assert.equal(disposed, 1, "the stray workspace is disposed, never the kept one");
        assert.match(
          String(store.readSince(0).findLast((e) => e.kind === "session.released")?.payload.reason),
          /Workspace preparation failed|kept worktree/,
        );
        return;
      }
      const attempts =
        scenario === "concurrent relaunch of a gone runtime"
          ? await Promise.allSettled([relaunch("relaunch-gone-a"), relaunch("relaunch-gone-b")])
          : await Promise.allSettled([relaunch("relaunch-gone")]);
      const fulfilled = attempts.filter((a) => a.status === "fulfilled");
      assert.equal(fulfilled.length, 1, "exactly one replacement");
      for (const attempt of attempts)
        if (attempt.status === "rejected") assert.match(String(attempt.reason.message), /generation changed/);
      const replacement = (fulfilled[0] as PromiseFulfilledResult<Record<string, unknown>>).value;
      assert.equal(replacement.generation, 2);
      assert.equal(replacement.recovered, "runtime-gone");
      assert.equal(replacement.stopped, false, "the old generation was released, never claimed stopped");
      assert.equal(replacement.releasedSession, old.ref.session);
      assert.equal(stops, 0, "nothing was signaled");
      assert.equal(native.size, 2);
      assert(native.get(String(replacement.handle))?.alive);
      // The fold keeps one row per ticket: the released generation is now history behind generation 2.
      assert.equal(fold(store.readSince(0)).projects[project]!.sessions[0]!.generation, 2);
      assert.match(
        String(store.readSince(0).findLast((e) => e.kind === "session.released")?.payload.reason),
        /without a confirmed runtime stop/,
      );
      await assert.rejects(workers.request(old.token, { command: "heartbeat", ticket: "SEED-1" }), /authorization/);
      await assert.rejects(
        workers.tool(
          project,
          "worker.stop",
          { ticket: "SEED-1", session: old.ref.session, reason: "Stale stop" },
          "stale-stop-gone",
          () => {},
        ),
        /generation changed/,
      );
      return;
    }
    let ready!: () => void;
    observeGate = new Promise<void>((resolve) => {
      ready = resolve;
    });
    if (scenario === "interrupted launch") {
      const rules = fold(store.readSince(0)).projects[project]!.rules!;
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
              revision: rules.revision + 1,
              value: {
                ...rules.value,
                policy: { ...rules.value.policy, budget: { workerLaunchesPerNight: total, zone: "UTC" } },
              },
            },
          },
        },
      });
      assert.equal(fold(store.readSince(0)).projects[project]!.holds.length, 0);
      assert.equal(fold(store.readSince(0)).projects[project]!.usage?.days[0]?.workerLaunches, total - 1);
    }
    const recovering = workers.recover();
    if (scenario === "queued input waits for worker re-adoption") {
      const messages = () =>
        [...native.values()].flatMap((row) => row.messages).filter((m) => m.startsWith("Queued before restart"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(messages().length, 0, "queued input waits for native observation");
      ready();
      assert.equal((await recovering).readopted.length, 2);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(messages().length, 1, "a boot-time queue attempt must not defer input until a retry timer");
      await workers.close();
      store.close();
      store = new EventStore(join(directory, "fleet.sqlite"));
      workers = make();
      assert.equal((await workers.recover()).readopted.length, 2);
      assert.equal(
        fold(store.readSince(0)).projects[project]?.usage?.days[0]?.workerLaunches,
        2,
        "another daemon boot does not consume another launch slot for either recovered generation",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(messages().length, 1, "confirmed queued input is not repeated on another boot");
      const adopted = store
        .readSince(0)
        .findLast((event) => event.kind === "worker.readopted" && event.payload.ticket === "SEED-1");
      assert(adopted?.kind === "worker.readopted");
      assert.notEqual(adopted.payload.briefPending, true, "the confirmed context handoff survives another restart");
      return;
    }
    if (
      scenario.startsWith("pending GitHub feedback") ||
      scenario === "GitHub feedback arriving during delivery is retained"
    ) {
      const messages = () =>
        [...native.values()].flatMap((row) => row.messages).filter((m) => m.includes("pending feedback"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(messages().length, 0, "review input must wait until observation finishes");
      ready();
      assert.equal((await recovering).readopted.length, 2);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (scenario === "pending GitHub feedback waits for initial brief") {
        assert.equal(messages().length, 0, "unbriefed workers must not receive review instructions first");
        const context = "Ticket SEED-1: plant safely. Parent instructions: keep the garden intact.";
        await workers.tool(
          project,
          "worker.message",
          { ticket: "SEED-1", message: context },
          "recovery-handoff",
          () => {},
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal([...native.values()][0]!.messages[0], context);
      } else if (scenario === "GitHub feedback arriving during delivery is retained") {
        feedback(1);
        await entered;
        feedback(2);
        releaseNative();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(messages().length, 2, "both reviews reach the re-adopted worker without another fleet event");
      assert.match(messages()[0]!, /pending feedback 1/);
      assert.match(messages()[1]!, /pending feedback 2/);
      return;
    }
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
    const usage = fold(store.readSince(0)).projects[project]!.usage;
    assert.equal(
      usage?.days[0]?.workerLaunches,
      total,
      "adoption confirms interrupted launches but never charges another launch for a known generation",
    );
    if (scenario === "interrupted launch") {
      const tables = fold(store.readSince(0)).projects[project]!;
      assert.equal(tables.holds.length, 1, "recovery enforces the night cap even without a coordinator model");
      assert.equal(tables.inbox.filter((item) => item.kind === "owner-request").length, 1);
    }
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
