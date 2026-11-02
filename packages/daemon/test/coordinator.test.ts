import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION as version } from "@armada/protocol";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { followUpEvent, providerCheckpoint } from "../coordinator/follow-ups.ts";
import { Coordinators } from "../coordinator/index.ts";
import { WAKE_ENTRY } from "../coordinator/wake.ts";
import { PluginRegistry } from "../src/plugins/registry.ts";
import { dispatchChat } from "../src/server/chat.ts";
import { ChatLive } from "../src/server/chat-live.ts";
import { EventStore } from "../src/store.ts";
import { Workers } from "../src/workers/service.ts";
import { nodeExecutable } from "./support/node.ts";

for (const interruption of ["after-result", "tool"]) {
  test(`daemon restart restores three model turns and one tool call (${interruption})`, {
    timeout: 20000,
  }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "armada-pi-restart-"));
    const file = join(dir, "events.sqlite");
    type Message = {
      type: string;
      entries?: { kind: string; data: unknown }[];
      calls?: number;
      messages?: unknown[];
    };
    const messages: Message[] = [];
    type Completion = { code: number | null; signal: string | null; error?: Error };
    const children: { child: ReturnType<typeof spawn>; completed: Promise<Completion> }[] = [];
    t.after(async () => {
      await Promise.all(
        children.map(async ({ child, completed }) => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await completed;
        }),
      );
      rmSync(dir, { recursive: true, force: true });
    });
    const launch = async (mode: string, until: string) => {
      // Use Node's executable protocol directly: no inherited Bun execArgv or cross-runtime IPC framing.
      const child = spawn(
        nodeExecutable,
        [fileURLToPath(new URL("./coordinator-process.ts", import.meta.url)), file, mode, interruption],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      // Register once at launch; close also guarantees that the stdout gate has been drained.
      const completed = new Promise<Completion>((resolve) => {
        child.once("error", (error) => resolve({ code: null, signal: null, error }));
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      children.push({ child, completed });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const lines = createInterface({ input: child.stdout });
      const gate = new Promise<Message>((resolve, reject) => {
        lines.on("line", (line) => {
          try {
            const message: Message = JSON.parse(line);
            messages.push(message);
            if (message.type === until) resolve(message);
          } catch (error) {
            reject(error);
          }
        });
      });
      const message = await Promise.race([
        gate,
        completed.then(({ code, signal, error }) => {
          throw new Error(`child exited before ${until}: ${code}/${signal}: ${error?.message ?? stderr}`);
        }),
      ]);
      return { child, completed, message };
    };
    const initial = await launch("start", "paused");
    initial.child.kill("SIGKILL");
    const killed = await initial.completed;
    assert.equal(killed.signal, "SIGKILL");
    const store = new EventStore(file);
    const before = store.readSince(0, "p");
    store.close();
    assert.ok(before.some((event) => event.kind === "coordinator.checkpoint"));
    const resumed = await launch("resume", "done");
    assert.equal(resumed.message.calls, 1, "only the unfinished third model turn is requested on reopen");
    assert.equal(
      messages.filter((message) => message.type === "tool").length,
      1,
      "never repeat the external tool effect",
    );
    const entries = resumed.message.entries;
    assert.ok(entries);
    assert.equal(entries.filter((entry) => entry.kind === "pi.user").length, 2);
    assert.equal(entries.filter((entry) => entry.kind === "pi.assistant").length, 3);
    assert.equal(entries.filter((entry) => entry.kind === "pi.tool-result").length, 1);
    const context = JSON.stringify(messages.find((message) => message.type === "resumed-context")?.messages);
    assert.ok(context.includes("I will check the fleet"));
    assert.ok(context.includes("fleet-call"));
    if (interruption === "after-result") assert.ok(context.includes("sessions"));
    else assert.match(context, /interrupted/i, "unsafe in-flight tools become interrupted results");
    const ended = await resumed.completed;
    assert.equal(ended.error, undefined);
    assert.equal(ended.code, 0);
    const reopened = new EventStore(file);
    assert.deepEqual(
      reopened.readSince(0, "p").slice(0, before.length),
      before,
      "recovery preserves the original log prefix",
    );
    reopened.close();
  });
}

for (const response of ["silent", "valid", "bare", "unrelated", "ambiguous", "french", "negated"]) {
  test(`a refused no-runtime launch names the owner fix once across wakes and restart (model response: ${response})`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "armada-owner-report-"));
    const file = join(directory, "events.sqlite");
    let store = new EventStore(file);
    let live = new ChatLive();
    let manager = new Coordinators(store);
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const at = () => new Date(now).toISOString();
    store.append({
      project: "orchard",
      actor: "reader",
      at: at(),
      kind: "ticket.seen",
      payload: { id: "ORC-1", title: "Plant", status: "unstarted", labels: ["ready-for-agent"], blockers: [] },
    });
    store.append({
      project: "orchard",
      actor: "coordinator",
      at: at(),
      kind: "coordinator.checkpoint",
      payload: {
        checkpoint: {
          format: "armada.tools",
          version: 1,
          type: "rules",
          rules: {
            revision: 1,
            value: { defaultRoute: { cli: "conductor", model: "fixture" } },
          },
        },
      },
    });
    store.append(
      providerCheckpoint("orchard", at(), [
        { id: "conductor", enabled: false, loaded: false, capabilities: ["runtime.conductor"] },
      ]),
    );
    const openWorkers = () =>
      new Workers({
        store,
        registry: new PluginRegistry(),
        socketPath: "/fake/worker.sock",
        projects: [{ id: "orchard", repository: "example/orchard" }],
        now: at,
      });
    let workers = openWorkers();
    if (response === "ambiguous")
      store.append(
        followUpEvent(store.readSince(0, "orchard"), "orchard", at(), "ORC-2", {
          tool: "worker.launch",
          code: "capability_missing",
          reason: "no runtime provider enabled",
          facts: "ORC-2 not launched",
          next: "fleet.status",
          fix: "Enable codex in Settings › Providers",
          capability: "runtime.codex",
        }),
      );
    const faux = fauxProvider({ models: [{ id: "coordinator" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const config = {
      project: "orchard",
      models,
      model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
      native: { workers },
      now: () => now,
      setTimer: () => () => {},
      wakeClock: { now: () => now, setTimer: () => () => {} },
    };
    t.after(async () => {
      await live.close();
      await manager.close();
      await workers.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    let coordinator = await manager.open(config);
    const read = async () => {
      const result = await dispatchChat(
        { type: "chat.read", version, id: "read", project: "orchard" },
        { store, live, coordinator },
      );
      assert.equal(result.type, "chat.result");
      if (result.type !== "chat.result") throw new Error("missing chat");
      return result.items
        .filter((item) => item.kind === "line" || item.kind === "coordinator")
        .map((item) => item.body);
    };
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("fleet.status", {}), { stopReason: "toolUse", timestamp: now }),
      fauxAssistantMessage(fauxToolCall("worker.launch", { ticket: "ORC-1" }), {
        stopReason: "toolUse",
        timestamp: now,
      }),
      (transcript) => {
        assert.match(JSON.stringify(transcript.messages), /Settings › Providers/);
        const messages: Record<string, string> = {
          silent: "",
          valid: "Cannot launch a worker: no runtime provider enabled. Enable conductor in Settings › Providers.",
          bare: "Enable Conductor in Settings › Providers.",
          negated:
            "Cannot launch a worker: no runtime provider enabled. Do not enable Conductor in Settings › Providers.",
          unrelated:
            "ORC-9: Cannot launch a worker: no runtime provider enabled. Enable Conductor in Settings › Providers.",
          ambiguous: "Cannot launch a worker: no runtime provider enabled. Enable conductor in Settings › Providers.",
          french:
            "Je ne peux pas lancer de worker : aucun runtime actif. Active Conductor dans Réglages › Fournisseurs.",
        };
        return fauxAssistantMessage(messages[response] ?? "", { timestamp: now });
      },
    ]);
    await (await coordinator.conversation.submit({ type: "input", content: "Launch ORC-1" }, context)).wait(context);
    let items = store.fold("orchard").projects.orchard?.inbox ?? [];
    assert.equal(items.length, response === "ambiguous" ? 2 : 1);
    const item = items.find((item) => item.ticket === "ORC-1");
    assert.ok(item);
    const generated = store
      .readSince(0, "orchard")
      .filter((event) => event.kind === "coordinator.message" && event.payload.body.includes("Settings › Providers"));
    assert.equal(
      generated.length,
      response === "valid" || response === "french" ? 0 : 1,
      "incomplete or unrelated prose cannot receipt the block",
    );
    if (response === "ambiguous") {
      const other = items.find((item) => item.ticket === "ORC-2");
      assert.ok(other);
      assert.equal(other.followUp?.toldOwnerAt, undefined);
      store.append({
        project: "orchard",
        at: at(),
        actor: "coordinator",
        kind: "inbox.answered",
        payload: { id: other.id, answer: "Recovered elsewhere" },
      });
    }
    assert.equal(item.followUp?.toldOwnerAt, at());
    const ownerLines = (await read()).filter((line) => /Settings › Providers|Réglages › Fournisseurs/.test(line));
    assert.equal(ownerLines.length, response === "silent" || response === "valid" || response === "french" ? 1 : 2);
    assert.ok(ownerLines.some((line) => /launch|lancer/i.test(line)));
    const marker = store
      .readSince(0, "orchard")
      .find((event) => event.kind === "inbox.opened" && !!event.payload.followUp?.toldOwnerAt);
    assert.ok(marker);
    const checkpoint = store
      .readSince(0, "orchard")
      .findLast((event) => event.seq < marker.seq && event.kind === "coordinator.checkpoint");
    assert.ok(checkpoint && checkpoint.at === marker.at, "owner marker shares the final publication commit");

    // A second wake sees the same open block and stays silent, including after restart.
    await live.close();
    await manager.close();
    await workers.close();
    store.close();
    store = new EventStore(file);
    live = new ChatLive();
    workers = openWorkers();
    config.native.workers = workers;
    now += 20 * 60_000;
    manager = new Coordinators(store);
    coordinator = await manager.open(config);
    faux.setResponses([fauxAssistantMessage("", { timestamp: now })]);
    await (
      await coordinator.conversation.submit(
        {
          type: "input",
          content: "Fleet wake-up: check the fleet",
          entry: { kind: WAKE_ENTRY, data: { body: "Woke: unchanged block" } },
        },
        context,
      )
    ).wait(context);
    assert.equal(
      (await read()).filter((line) => /Settings › Providers|Réglages › Fournisseurs/.test(line)).length,
      ownerLines.length,
    );
    assert.equal(faux.state.callCount, 4, "the second wake actually ran the model after three launch-turn completions");
    const detail = item.followUp;
    assert.ok(detail);
    const { toldOwnerAt: _receipt, ...repeated } = detail;
    store.append(followUpEvent(store.readSince(0, "orchard"), "orchard", at(), item.ticket, repeated));
    items = store.fold("orchard").projects.orchard?.inbox ?? [];
    assert.equal(items[0]?.followUp?.toldOwnerAt, item.followUp?.toldOwnerAt);
    assert.equal(items[0]?.followUp?.attempts, 2);
    if (response === "silent") {
      store.append(
        followUpEvent(store.readSince(0, "orchard"), "orchard", at(), item.ticket, {
          ...repeated,
          reason: "enabled runtime provider is not loaded",
          fix: "Restart Armada to load conductor after enabling it in Settings › Providers",
        }),
      );
      assert.equal(
        store.fold("orchard").projects.orchard?.inbox[0]?.followUp?.toldOwnerAt,
        undefined,
        "a changed owner action needs a new line",
      );
      now += 11 * 60_000;
      faux.setResponses([fauxAssistantMessage("", { timestamp: now })]);
      await (
        await coordinator.conversation.submit(
          {
            type: "input",
            content: "Fleet wake-up: changed fix",
            entry: { kind: WAKE_ENTRY, data: { body: "Woke: changed fix" } },
          },
          context,
        )
      ).wait(context);
      assert.match((await read()).at(-1) ?? "", /Restart Armada/);
      assert.equal(store.fold("orchard").projects.orchard?.inbox[0]?.followUp?.toldOwnerAt, at());
    }
  });
}

test("a silent wake reports an overdue untold follow-up once, while fresh blocks and empty wakes stay silent", async (t) => {
  const store = new EventStore(":memory:");
  const manager = new Coordinators(store);
  const faux = fauxProvider({ models: [{ id: "coordinator" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  const at = () => new Date(now).toISOString();
  t.after(async () => {
    await manager.close();
    store.close();
  });
  const coordinator = await manager.open({
    project: "orchard",
    models,
    model: { provider: faux.getModel().provider, modelId: faux.getModel().id },
    now: () => now,
    setTimer: () => () => {},
    wakeClock: { now: () => now, setTimer: () => () => {} },
  });
  const wake = async () => {
    faux.setResponses([fauxAssistantMessage("", { timestamp: now })]);
    await (
      await coordinator.conversation.submit(
        {
          type: "input",
          content: "Fleet wake-up: check the fleet",
          entry: { kind: WAKE_ENTRY, data: { body: "Woke: check the fleet" } },
        },
        context,
      )
    ).wait(context);
  };
  const lines = () =>
    store
      .readSince(0, "orchard")
      .filter((event) => event.kind === "coordinator.message" && event.payload.body.includes("Settings › Providers"));
  await wake();
  assert.equal(lines().length, 0);
  store.append(
    followUpEvent(store.readSince(0, "orchard"), "orchard", at(), "ORC-1", {
      tool: "worker.launch",
      code: "capability_missing",
      reason: "no runtime provider enabled",
      facts: "ORC-1 not launched",
      next: "fleet.status",
      fix: "Enable Conductor in Settings › Providers",
      capability: "launch",
    }),
  );
  now += 9 * 60_000;
  await wake();
  assert.equal(lines().length, 0, "an existing fresh block does not interrupt a quiet wake");
  now += 2 * 60_000;
  await wake();
  assert.equal(lines().length, 1);
  assert.equal(store.fold("orchard").projects.orchard?.inbox[0]?.followUp?.toldOwnerAt, at());
  now += 20 * 60_000;
  await wake();
  assert.equal(lines().length, 1);
  store.append(
    followUpEvent(store.readSince(0, "orchard"), "orchard", at(), "ORC-2", {
      tool: "merge.check",
      code: "merge_refused",
      reason: "hand-back evidence missing",
      facts: "ORC-2 is green",
      next: "fleet.status",
    }),
  );
  now += 11 * 60_000;
  faux.setResponses([fauxAssistantMessage("I will inspect fleet.status", { timestamp: now })]);
  await (
    await coordinator.conversation.submit(
      {
        type: "input",
        content: "Fleet wake-up: unresolved merge",
        entry: { kind: WAKE_ENTRY, data: { body: "Woke: merge block" } },
      },
      context,
    )
  ).wait(context);
  assert.ok(
    store
      .readSince(0, "orchard")
      .some(
        (event) => event.kind === "coordinator.message" && event.payload.body.includes("Cannot complete merge.check"),
      ),
    "a promise to inspect is not a completed action or an owner line",
  );
});
