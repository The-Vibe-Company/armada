import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { EventInput, Session } from "@armada/protocol";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, Submission } from "@earendil-works/pi-durable";
import { type WakeClock, Waker } from "../coordinator/wake.ts";
import { fold } from "../src/fold.ts";
import { judgeProgress } from "../src/liveness/judge.ts";
import { EventStore } from "../src/store.ts";

const minute = 60_000;
class Clock implements WakeClock {
  time = Date.parse("2030-01-01T10:00:00Z");
  now = () => this.time;
  timers = new Set<{ at: number; run: () => void }>();
  setTimer = (run: () => void, delay: number) => {
    const timer = { at: this.time + delay, run };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  };
  async advance(ms: number) {
    const end = this.time + ms;
    let steps = 0;
    for (;;) {
      if (++steps > 1000) throw new Error("Watchdog timer spun without advancing cadence");
      const timer = [...this.timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!timer) break;
      this.timers.delete(timer);
      this.time = timer.at;
      timer.run();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.time = end;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
const ref = { ticket: "ORC-1", session: "worker-1", generation: 1 };
const project = "orchard";

async function fixture(
  t: { after(fn: () => Promise<void>): void },
  verdict = "looping",
  withPr = false,
  transcript?: () => Promise<string>,
) {
  const store = new EventStore(":memory:");
  const clock = new Clock();
  const token = `armada_worker_${randomBytes(24).toString("hex")}`;
  const inputs: string[] = [];
  const wakes: string[] = [];
  let tails = 0;
  let fail = false;
  let deferred: (() => Promise<void>) | undefined;
  const faux = fauxProvider({ models: [{ id: "small" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const response = async (context: unknown) => {
    inputs.push(JSON.stringify(context));
    if (deferred) await deferred();
    return fauxAssistantMessage(
      fail ? "bad json" : JSON.stringify({ verdict, evidence: `Same failure repeatedly; ${token}` }),
    );
  };
  faux.setResponses(Array.from({ length: 40 }, () => response));
  const append = (kind: EventInput["kind"], payload: unknown) =>
    store.append({ project, kind, payload, actor: "worker", at: new Date(clock.now()).toISOString() } as EventInput);
  append("coordinator.checkpoint", {
    checkpoint: {
      format: "armada.tools",
      version: 1,
      type: "rules",
      rules: { revision: 1, value: { policy: { silenceMinutes: 15, quietMinutes: 45, coordinatorMinutes: 0 } } },
    },
  });
  append("coordinator.checkpoint", {
    checkpoint: {
      format: "armada.worker",
      version: 1,
      type: "launch",
      ...ref,
      runtime: "claude",
      handle: "handle-1",
      step: "launched",
    },
  });
  if (!transcript) append("session.claimed", { ...ref, runtime: "claude", owner: "coordinator", handle: "handle-1" });
  if (withPr)
    append("pull-request.seen", {
      number: 1,
      ticket: ref.ticket,
      head: "a".repeat(40),
      ci: "failure",
      state: "open",
      conflicting: false,
    });
  const report = (line = `Retrying failing test ${token}`, phase = "implementing") =>
    append("session.reported", { ...ref, phase, reason: line });
  if (!transcript) report();
  append("session.runtime-observed", { ...ref, state: "running", activity: "working" });
  const conversation: Pick<Conversation, "submit"> = {
    submit: async (draft) => {
      if (draft.type === "input") wakes.push(String(draft.content));
      return {} as Submission;
    },
  };
  const options = {
    store,
    project,
    clock,
    conversation,
    progress: {
      judge: judgeProgress(models, { provider: faux.provider.id, modelId: "small" }),
      transcript: async (_session: Session) => {
        tails++;
        return transcript ? transcript() : `${"noise".repeat(1500)}\nTest failed ${token}`;
      },
    },
  };
  let waker = new Waker(options);
  t.after(async () => {
    await waker.close();
    store.close();
  });
  const beat = () => append("session.heartbeat", ref);
  const run = async () => {
    await clock.advance(10 * minute);
    beat();
    report();
    await clock.advance(10 * minute);
    beat();
    report();
    await clock.advance(10_100);
  };
  return {
    store,
    clock,
    token,
    inputs,
    wakes,
    report,
    append,
    beat,
    run,
    tails: () => tails,
    fail: () => {
      fail = true;
    },
    defer: (fn: () => Promise<void>) => {
      deferred = fn;
    },
    restart: async () => {
      await waker.close();
      waker = new Waker(options);
    },
  };
}

test("a live loop appends one judged notice and one wake, masks model input, and survives restart", async (t) => {
  const f = await fixture(t);
  await f.run();
  assert.equal(f.inputs.length, 1);
  assert.equal(f.tails(), 2, "first observation checks permissions; suspicious progress gets one judgment");
  assert.doesNotMatch(JSON.stringify(f.inputs), new RegExp(f.token));
  assert.match(f.inputs[0]!, /\[redacted\]/);
  assert.ok(f.inputs[0]!.length < 18_000);
  const notices = () => f.store.readSince(0).filter((e) => e.kind === "session.liveness");
  assert.equal(notices().length, 1);
  assert.equal(f.wakes.length, 1);
  assert.match(f.wakes[0]!, /ORC-1 looping: same report 3 times/);
  assert.doesNotMatch(JSON.stringify(notices()), new RegExp(f.token));
  assert.equal(fold(f.store.readSince(0)).projects[project]?.inbox.filter((i) => i.kind === "liveness").length, 1);
  await f.restart();
  f.beat();
  await f.clock.advance(15 * minute);
  f.beat();
  assert.equal(notices().length, 1, "same episode/level never emits another notice");
  assert.equal(f.wakes.length, 1);
  f.report("Fixed the root cause and added pagination");
  assert.equal(fold(f.store.readSince(0)).projects[project]?.inbox.filter((i) => i.kind === "liveness").length, 0);
});

for (const verdict of ["progressing", "stuck", "drifting", "invalid"] as const) {
  test(`watchdog ${verdict} verdict is handled without inventing a loop`, async (t) => {
    const f = await fixture(t, verdict);
    await f.run();
    assert.equal(f.inputs.length, 1);
    assert.equal(
      f.store.readSince(0).filter((e) => e.kind === "session.liveness").length,
      verdict === "drifting" ? 1 : 0,
    );
    assert.equal(f.wakes.length, verdict === "drifting" ? 1 : 0);
  });
}

test("judge failures write no verdict and keep cadence across restart", async (t) => {
  const f = await fixture(t);
  f.fail();
  await f.run();
  assert.equal(f.inputs.length, 1);
  assert.equal(f.store.readSince(0).filter((e) => e.kind === "session.liveness").length, 0);
  await f.restart();
  await f.clock.advance(14 * minute);
  f.beat();
  assert.equal(f.inputs.length, 1);
  await f.clock.advance(minute);
  assert.equal(f.inputs.length, 2);
  assert.equal(f.wakes.length, 0);
});

test("progress during a pending judgment fences the old result", async (t) => {
  const f = await fixture(t);
  let finish!: () => void;
  f.defer(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await f.run();
  assert.equal(f.inputs.length, 1);
  f.report("The failing test now passes");
  finish();
  await f.clock.advance(10_000);
  assert.equal(f.store.readSince(0).filter((e) => e.kind === "session.liveness").length, 0);
  assert.equal(f.wakes.length, 0);
});

for (const change of ["same-report", "phase", "head", "new-pr", "replacement"] as const) {
  test(`a ${change} updates the judged notice according to real progress`, async (t) => {
    const f = await fixture(t, "looping", change === "new-pr");
    await f.run();
    assert.equal(fold(f.store.readSince(0)).projects[project]?.inbox.filter((i) => i.kind === "liveness").length, 1);
    if (change === "same-report") f.report();
    else if (change === "phase") f.report("Starting shipping", "shipping");
    else if (change === "head") {
      f.append("pull-request.seen", {
        number: 1,
        ticket: ref.ticket,
        head: "a".repeat(40),
        state: "open",
        ci: "pending",
        conflicting: false,
      });
      f.append("pull-request.head-moved", {
        number: 1,
        ticket: ref.ticket,
        head: "b".repeat(40),
        state: "open",
        ci: "pending",
        conflicting: false,
      });
    } else if (change === "new-pr")
      f.append("pull-request.opened", {
        number: 2,
        ticket: ref.ticket,
        head: "b".repeat(40),
        state: "open",
        ci: "pending",
        conflicting: false,
      });
    else
      f.append("session.claimed", {
        ...ref,
        session: "replacement",
        generation: 2,
        runtime: "claude",
        owner: "coordinator",
        handle: "handle-2",
      });
    assert.equal(
      fold(f.store.readSince(0)).projects[project]?.inbox.filter((i) => i.kind === "liveness").length,
      change === "same-report" ? 1 : 0,
    );
  });
}

test("the injected deadline bounds a hung judge without a verdict or wake", async (t) => {
  const f = await fixture(t);
  f.defer(() => new Promise<void>(() => {}));
  await f.run();
  assert.equal(f.inputs.length, 1);
  await f.clock.advance(30_000);
  assert.equal(f.store.readSince(0).filter((e) => e.kind === "session.liveness").length, 0);
  assert.equal(f.wakes.length, 0);
});

test("the watchdog follows the coordinator's current model after hot selection", async (t) => {
  const { Coordinators } = await import("../coordinator/index.ts");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const store = new EventStore(":memory:");
  const clock = new Clock();
  const selected: string[] = [];
  const faux = fauxProvider({ models: [{ id: "small" }, { id: "other" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 5 }, () => (_context, _options, _state, model) => {
      selected.push(model.id);
      return fauxAssistantMessage(
        JSON.stringify({ verdict: "progressing", evidence: "Investigating a fresh hypothesis" }),
      );
    }),
  );
  const append = (kind: EventInput["kind"], payload: unknown) =>
    store.append({ project, kind, payload, at: new Date(clock.now()).toISOString(), actor: "worker" } as EventInput);
  append("session.claimed", { ...ref, runtime: "claude", owner: "coordinator", handle: "handle-1" });
  const report = () => append("session.reported", { ...ref, phase: "implementing", reason: "Retrying the same test" });
  report();
  report();
  report();
  append("session.heartbeat", ref);
  const coordinators = new Coordinators(store);
  const current = await coordinators.open({
    project,
    models,
    model: { provider: faux.provider.id, modelId: "small" },
    wakeClock: clock,
  });
  t.after(async () => {
    await coordinators.close();
    store.close();
  });
  await clock.advance(100);
  assert.deepEqual(selected, ["small"]);
  await current.conversation.configure({ model: { provider: faux.provider.id, modelId: "other" } }, BACKGROUND_CONTEXT);
  await clock.advance(14 * minute);
  append("session.heartbeat", ref);
  await clock.advance(minute);
  assert.deepEqual(selected, ["small", "other"]);
});

test("opaque plugin payloads preserve live and replayed watchdog subscriptions", async (t) => {
  const f = await fixture(t);
  for (const payload of [null, 42, "a plugin note", true]) f.append("orchard.note" as EventInput["kind"], payload);
  await f.restart();
  await f.run();
  assert.equal(f.inputs.length, 1);
  assert.equal(f.store.readSince(0).filter((e) => e.kind === "session.liveness").length, 1);
  f.append("inbox.opened", { id: "after-opaque", ticket: ref.ticket, kind: "question", body: "Still observing?" });
  await f.clock.advance(10_000);
  assert.equal(f.wakes.length, 2, "ordinary fleet wakes still reach the live subscriber");
});

test("a failed watchdog checkpoint backs off without spinning or calling the model", async (t) => {
  const f = await fixture(t);
  const append = f.store.append.bind(f.store);
  let attempts = 0;
  t.mock.method(f.store, "append", (event: EventInput) => {
    if (event.kind === "coordinator.checkpoint" && JSON.stringify(event.payload).includes("armada.watchdog")) {
      attempts++;
      throw new Error("Synthetic disk refusal");
    }
    return append(event);
  });
  await f.run();
  assert.equal(attempts, 1);
  assert.equal(f.inputs.length, 0);
  await f.clock.advance(14 * minute);
  f.beat();
  assert.equal(attempts, 1);
  await f.clock.advance(minute);
  assert.equal(attempts, 2);
  assert.equal(f.wakes.length, 0);
});

for (const text of [
  "Claude requested permissions for Bash",
  JSON.stringify({ armada: 1, kind: "failure", permission: true }),
  "You haven't granted permission to Write",
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: "I requested permissions for Bash but was refused" }] },
  }),
  JSON.stringify({ type: "result", permission_denials: [{ tool_name: "Bash", tool_input: { command: "claim" } }] }),
]) {
  test(`first observation diagnoses permissions and opens one actionable follow-up: ${text}`, async (t) => {
    const f = await fixture(t, "progressing", false, async () => text);
    await f.clock.advance(1);
    const items = () => fold(f.store.readSince(0)).projects[project]!.inbox.filter((i) => i.kind === "follow-up");
    assert.equal(items().length, 1);
    assert.equal(items()[0]!.followUp?.code, "permission_prompt");
    assert.match(items()[0]!.followUp!.reason, /permission/i);
    assert.match(items()[0]!.followUp!.fix!, /permission mode in Settings > Providers/i);
    assert.equal(f.inputs.length, 0, "explicit permission evidence needs no model or silence threshold");
    await f.clock.advance(10_000);
    assert.equal(f.wakes.length, 1, "the new block wakes the coordinator without a reminder delay");
    assert.match(f.wakes[0]!, /permission mode in Settings > Providers/);
    f.append("session.runtime-observed", { ...ref, state: "running", activity: "idle" });
    await f.clock.advance(1);
    await f.restart();
    await f.clock.advance(1);
    assert.equal(items().length, 1);
    assert.equal(items()[0]!.followUp?.attempts, 1);
    assert.equal(f.wakes.length, 1);
    f.append("session.runtime-observed", { ...ref, state: "failed", activity: "idle" });
    await f.clock.advance(20 * minute);
    assert.equal(
      fold(f.store.readSince(0)).projects[project]?.inbox.filter((i) =>
        ["silent", "stopped", "not-started", "liveness"].includes(i.kind),
      ).length,
      0,
    );
  });
}

test("a permission transcript arriving after replacement cannot blame the new generation", async (t) => {
  let finish!: (text: string) => void;
  const f = await fixture(
    t,
    "progressing",
    false,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.clock.advance(1);
  f.append("session.claimed", {
    ...ref,
    session: "replacement",
    generation: 2,
    runtime: "claude",
    owner: "coordinator",
    handle: "two",
  });
  finish("You haven't granted permission");
  await f.clock.advance(1);
  assert.equal(fold(f.store.readSince(0)).projects[project]!.inbox.filter((i) => i.kind === "follow-up").length, 0);
});

for (const text of [
  JSON.stringify({ type: "user", message: { content: "Document requested permissions and permission prompts" } }),
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", input: { text: "requested permissions" } }] },
  }),
  "bash: ./build.sh: Permission denied",
]) {
  test(`permission follow-up ignores prompt/tool input and filesystem errors: ${text}`, async (t) => {
    const f = await fixture(t, "progressing", false, async () => text);
    await f.clock.advance(1);
    assert.equal(fold(f.store.readSince(0)).projects[project]?.inbox.filter((i) => i.kind === "follow-up").length, 0);
    assert.equal(f.inputs.length, 0);
  });
}

test("completed-turn evidence diagnoses permissions even when the runtime state stays idle", async (t) => {
  let tail = "";
  const f = await fixture(t, "progressing", false, async () => tail);
  await f.clock.advance(1);
  assert.equal(fold(f.store.readSince(0)).projects[project]?.inbox.length, 0);
  tail = JSON.stringify({ type: "result", result: "This session hasn't granted permissions to Bash" });
  f.append("session.usage", {
    ...ref,
    usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0, model: "small", provider: "anthropic" },
  });
  await f.clock.advance(1);
  assert.equal(
    fold(f.store.readSince(0)).projects[project]?.inbox.filter((i) => i.followUp?.code === "permission_prompt").length,
    1,
  );
});
