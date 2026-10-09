import { expect, test } from "bun:test";
import { createLinearWriter } from "@armada/core";
import { memoryFleet } from "../../core/test/memory-fleet.ts";
import { ARMADA_URL, DEMO_TOML, FakeLinear, fakeArmada, fakeClock } from "../../core/test/support.ts";
import { type Io, run } from "../src/cli.ts";

function terminal(config = DEMO_TOML) {
  const store = memoryFleet();
  const clock = fakeClock();
  const key = "armada_key_CANARY_ack";
  const api = fakeArmada({ keys: { [key]: "fleet" }, store, clock });
  const linear = new FakeLinear(clock.now);
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd: "/work/widgets",
    env: { ARMADA_API_URL: ARMADA_URL, ARMADA_API_KEY: key, LINEAR_API_KEY: "synthetic-linear-key" },
    readFile: async () => config,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ghToken: () => null,
    fetch: api.fetch,
    now: clock.now,
    sleep: clock.sleep,
    linearWriter: () => linear,
  };
  const notice = (ticket: string | null = "DEMO-2") =>
    store.addInboxItem({
      project: "widgets",
      recipient: "coordinator",
      kind: "job",
      ticket,
      author: null,
      body: "Job completed",
      at: clock.now(),
    });
  return {
    io,
    api,
    store,
    clock,
    linear,
    notice,
    out: () => out.join(""),
    err: () => err.join(""),
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
  };
}

test("ack posts one phase-preserving note after recording, and an idempotent repeat never posts again", async () => {
  const t = terminal();
  t.linear.add("DEMO-2", { labels: [{ id: "phase-implementing", name: "implementing", group: "Agent phase" }] });
  const id = await t.notice();
  expect(await run(["inbox"], t.io)).toBe(0);
  expect(t.out()).toContain('armada ack <#id or key> --reason "<why>"');
  t.linear.afterComment = () =>
    expect(t.store.items.find((item) => item.id === id)?.resolution).toBe("acknowledged: Checked the result");
  expect(await run(["ack", `#${id}`, "--reason", "Checked the result"], t.io)).toBe(0);
  expect(t.linear.bodies).toEqual(["Agent status: implementing — note: acknowledged job: Checked the result"]);
  expect((await t.linear.readTicket("DEMO-2"))?.agentPhase).toBe("implementing");
  t.reset();
  expect(await run(["ack", String(id), "--reason", "Checked the result"], t.io)).toBe(0);
  expect(t.out()).toContain("already resolved");
  expect(t.linear.bodies).toHaveLength(1);
});

test("derived entries print an actionable key; acknowledgement posts a coordinator note and hides the entry", async () => {
  const t = terminal();
  t.linear.add("DEMO-2");
  await t.store.saveRuntimeHandle({
    project: "widgets",
    ticket: "DEMO-2",
    runtime: "conductor",
    handle: "ws/session",
    branch: null,
    at: t.clock.now(),
  });
  await t.store.recordEvent({
    project: "widgets",
    ticket: "DEMO-2",
    kind: "claim",
    phase: "implementing",
    at: t.clock.now(),
  });
  t.clock.advance(61 * 60_000);
  expect(await run(["inbox"], t.io)).toBe(0);
  expect(t.out()).toContain("key silent:DEMO-2:1");
  expect(await run(["ack", "silent:DEMO-2:1", "--reason", "Runner is healthy"], t.io)).toBe(0);
  expect(t.linear.bodies).toEqual(["Coordinator default acknowledged silent: Runner is healthy"]);
  t.reset();
  expect(await run(["inbox"], t.io)).toBe(0);
  expect(t.out()).not.toContain("silent:DEMO-2:1");
  expect(t.out()).not.toContain("Not acting on an entry?");
});

test("an old silence key records its reason on the ticket once while the new level stays visible", async () => {
  const t = terminal();
  t.linear.add("DEMO-2", { labels: [{ id: "phase-implementing", name: "implementing", group: "Agent phase" }] });
  await t.store.saveRuntimeHandle({
    project: "widgets",
    ticket: "DEMO-2",
    runtime: "conductor",
    handle: "ws/session",
    branch: null,
    at: t.clock.now(),
  });
  await t.store.recordEvent({
    project: "widgets",
    ticket: "DEMO-2",
    kind: "claim",
    phase: "implementing",
    at: t.clock.now(),
  });
  t.clock.advance(31 * 60_000);
  expect(await run(["inbox"], t.io)).toBe(0);
  expect(t.out()).toContain("key silent:DEMO-2:0");
  t.clock.advance(30 * 60_000);
  expect(await run(["ack", "silent:DEMO-2:0", "--reason", "Old silence was checked"], t.io)).toBe(0);
  expect(t.out()).toContain("already resolved");
  expect(t.linear.bodies).toEqual(["Agent status: implementing — note: acknowledged silent: Old silence was checked"]);
  expect(await run(["ack", "silent:DEMO-2:0", "--reason", "Old silence was checked"], t.io)).toBe(0);
  expect(t.linear.bodies).toHaveLength(1);
  t.reset();
  expect(await run(["inbox"], t.io)).toBe(0);
  expect(t.out()).toContain("key silent:DEMO-2:1");
});

test("ack uses the inbox's custom policy without a snapshot and ends with watch guidance", async () => {
  const t = terminal(`${DEMO_TOML}\n[policy]\nsilence_minutes = 2\nlaunch_grace_minutes = 0\n`);
  t.io.fetch = async (url, init) => {
    const response = await t.api.fetch(url, init);
    if (!url.endsWith("/fleet/inbox") || response.status !== 200) return response;
    const body = (await response.json()) as { result: Record<string, unknown> };
    return Response.json({ ...body, result: { ...body.result, waiting: ["DEMO-3"], slots: { taken: 1, max: 2 } } });
  };
  t.linear.add("DEMO-2");
  await t.store.saveRuntimeHandle({
    project: "widgets",
    ticket: "DEMO-2",
    runtime: "conductor",
    handle: "ws/session",
    branch: null,
    at: t.clock.now(),
  });
  await t.store.recordEvent({
    project: "widgets",
    ticket: "DEMO-2",
    kind: "claim",
    phase: "implementing",
    at: t.clock.now(),
  });
  t.clock.advance(3 * 60_000);
  expect(await run(["inbox"], t.io)).toBe(0);
  expect(t.out()).toContain("key silent:DEMO-2:0");
  t.reset();
  expect(await run(["ack", "silent:DEMO-2:0", "--reason", "Runner checked"], t.io)).toBe(0);
  expect(t.linear.bodies).toHaveLength(1);
  expect(t.out().trim().split("\n").at(-1)).toContain("keep watching: armada watch");
  expect(t.out()).toContain("1 of 2 workers in flight");
  expect(t.out()).toContain("1 waiting to launch");
  t.reset();
  expect(await run(["inbox"], t.io)).toBe(0);
  expect(t.out()).not.toContain("key silent:DEMO-2:0");
  t.reset();
  expect(await run(["ack", "silent:DEMO-2:0", "--reason", "Runner checked", "--json"], t.io)).toBe(0);
  expect(JSON.parse(t.out()).watch.line).toContain("keep watching: armada watch");
  expect(JSON.parse(t.out()).watch.line).toContain("1 of 2 workers in flight");
  expect(JSON.parse(t.out()).watch.line).toContain("1 waiting to launch");
  expect(t.linear.bodies).toHaveLength(1);
});

test("ticketless acknowledgements and missing reasons do not create tracker comments", async () => {
  const t = terminal();
  const id = await t.notice(null);
  expect(await run(["ack", String(id)], t.io)).toBe(2);
  expect(t.err()).toContain('--reason "<why>"');
  expect((await t.store.getInboxItem("widgets", id))?.resolvedAt).toBeNull();
  t.reset();
  expect(await run(["ack", String(id), "--reason", "Results archived"], t.io)).toBe(0);
  expect(t.out()).toContain("Ticketless entry: reason recorded in Armada only.");
  expect(t.linear.bodies).toEqual([]);
});

test("a Linear 503 makes only one physical comment attempt and prints recovery text after the durable ack", async () => {
  const t = terminal();
  t.linear.add("DEMO-2", { labels: [{ id: "phase-shipping", name: "shipping", group: "Agent phase" }] });
  const id = await t.notice();
  let posts = 0;
  t.io.linearWriter = (options) => ({
    ...createLinearWriter({
      ...options,
      fetch: async () => {
        posts++;
        return Response.json({ error: "unavailable" }, { status: 503 });
      },
    }),
    readTicket: t.linear.readTicket.bind(t.linear),
  });
  expect(await run(["ack", String(id), "--reason", "Checked"], t.io)).toBe(0);
  expect(posts).toBe(1);
  expect((await t.store.getInboxItem("widgets", id))?.resolution).toBe("acknowledged: Checked");
  expect(t.err()).toContain("creation was not retried");
  expect(t.out()).toContain("Post this on DEMO-2:\nAgent status: shipping — note: acknowledged job: Checked");
});

test("an older API names the deploy-first action and no tracker comment is posted", async () => {
  const t = terminal();
  const id = await t.notice();
  t.io.fetch = (url, init) =>
    url.endsWith("/fleet/ack")
      ? Promise.resolve(Response.json({ error: "no fleet operation ack", next: "update the CLI" }, { status: 404 }))
      : t.api.fetch(url, init);
  expect(await run(["ack", String(id), "--reason", "Checked"], t.io)).toBe(1);
  expect(t.err()).toContain("this Armada does not know ack yet; deploy the API first");
  expect((await t.store.getInboxItem("widgets", id))?.resolvedAt).toBeNull();
  expect(t.linear.bodies).toEqual([]);
});
