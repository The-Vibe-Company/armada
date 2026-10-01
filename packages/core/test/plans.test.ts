import { afterEach, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { answerItem, checkInbox, readInbox } from "../src/inbox.ts";
import { RequestRefusal, requestAnswer, tursoRequests } from "../src/requests.ts";
import { addInboxItem, type Db, getInboxItem, openInboxItems } from "../src/turso.ts";
import { claimTicket, releaseTicket, reportPhase, type WorkerContext } from "../src/worker.ts";
import { closeTempTurso, DEMO_TOML, FakeLinear, NOW, tempTurso } from "./support.ts";

afterEach(closeTempTurso);

const project = "widgets";
const plan = "Build the parser\n\n1. Add validation.\n2. Test malformed input.";

async function setup() {
  const { db } = await tempTurso();
  const linear = new FakeLinear();
  const ctx: WorkerContext = {
    config: parseConfig(DEMO_TOML),
    linear,
    turso: async () => ({ db, warning: null }),
    readPull: null,
    now: () => NOW,
  };
  linear.add("DEMO-7");
  await claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws/7" });
  return { db, linear, ctx };
}

const inbox = (db: Db) => openInboxItems(db, { project, recipient: "coordinator" });
const reportPlan = (ctx: WorkerContext) =>
  reportPhase(ctx, { ticket: "DEMO-7", phase: "awaiting-approval", message: plan });

test("a plan reaches the coordinator with its full text and handle, once per approval transition", async () => {
  const { db, ctx } = await setup();
  await reportPlan(ctx);
  const [pending] = await inbox(db);
  if (!pending) throw new Error("plan missing from the coordinator's inbox");
  expect(pending).toMatchObject({ kind: "plan", ticket: "DEMO-7", author: "ws/7", body: plan });
  await reportPhase(ctx, { ticket: "DEMO-7", phase: "awaiting-approval", message: "waiting for approval" });
  expect(await inbox(db)).toEqual([pending]);
  await reportPhase(ctx, { ticket: "DEMO-7", phase: "planning", message: "revise the plan" });
  expect(await inbox(db)).toEqual([]);
  await reportPlan(ctx);
  expect((await inbox(db))[0]?.id).not.toBe(pending?.id);
});

test("inbox --wait wakes when a worker posts a plan", async () => {
  const { db, ctx } = await setup();
  let clock = NOW.getTime();
  const out = await checkInbox(db, {
    project,
    silentAfterMinutes: 15,
    now: () => new Date(clock),
    wait: {
      timeoutMs: 10_000,
      sleep: async (ms) => {
        clock += ms;
        await reportPlan(ctx);
      },
    },
  });
  expect(out.wait?.timedOut).toBe(false);
  expect(out.items).toEqual([expect.objectContaining({ kind: "plan", body: plan, new: true })]);
});

test.each(["item", "ticket", "item-note", "ticket-note"])(
  "%s answers resolve the plan and record it on Linear",
  async (mode) => {
    const { db, ctx, linear } = await setup();
    await reportPlan(ctx);
    const pending = (await inbox(db))[0];
    const target = mode.startsWith("item") ? String(pending?.id) : "DEMO-7";
    ctx.now = () => new Date(NOW.getTime() + 1);
    await answerItem(ctx, { target, text: "approved", note: mode.endsWith("note") });
    expect(await inbox(db)).toEqual([]);
    expect(await getInboxItem(db, project, pending?.id ?? 0)).toMatchObject({ resolution: "approved" });
    expect(linear.bodies.at(-1)).toContain(
      `Agent status: awaiting-approval — ${mode.endsWith("note") ? "note" : "answer"}: approved`,
    );
    const later = new Date(NOW.getTime() + 16 * 60_000);
    expect(await readInbox(db, { project, silentAfterMinutes: 15, now: () => later })).toEqual([
      expect.objectContaining({ kind: "silent", ticket: "DEMO-7" }),
    ]);
    await reportPhase(ctx, { ticket: "DEMO-7", phase: "awaiting-approval", message: "resuming shortly" });
    expect(await inbox(db)).toEqual([]);
  },
);

test("Approve uses an answer request, closed together with its plan and attributed on the ticket", async () => {
  const { db, ctx, linear } = await setup();
  await reportPlan(ctx);
  const pending = (await inbox(db))[0];
  const request = { project, question: pending?.id ?? 0, text: "approved", author: "Ada", now: NOW };
  const requestId = await requestAnswer(tursoRequests(db), request);
  expect((await inbox(db)).map((item) => item.kind)).toEqual(["plan", "answer-request"]);
  await expect(requestAnswer(tursoRequests(db), request)).rejects.toBeInstanceOf(RequestRefusal);
  await answerItem(ctx, { target: String(requestId), text: "approved" });
  expect(await inbox(db)).toEqual([]);
  expect(linear.bodies.at(-1)).toContain(`plan #${pending?.id}`);
  expect(linear.bodies.at(-1)).toContain("Ada");
  await expect(requestAnswer(tursoRequests(db), request)).rejects.toBeInstanceOf(RequestRefusal);
});

test.each(["phase", "release", "answer", "note"])("%s closes obsolete plan answer requests", async (mode) => {
  const { db, ctx } = await setup();
  await reportPlan(ctx);
  const pending = (await inbox(db))[0];
  await requestAnswer(tursoRequests(db), {
    project,
    question: pending?.id ?? 0,
    text: "approved",
    author: "Ada",
    now: NOW,
  });
  if (mode === "release") await releaseTicket(ctx, { ticket: "DEMO-7", reason: "owner cancelled" });
  else if (mode === "phase") await reportPhase(ctx, { ticket: "DEMO-7", phase: "implementing", message: "approved" });
  else await answerItem(ctx, { target: String(pending?.id), text: "approved", note: mode === "note" });
  expect(await inbox(db)).toEqual([]);
});

test("pre-approved plans enter implementing without an approval inbox item", async () => {
  const { db, ctx } = await setup();
  await reportPhase(ctx, { ticket: "DEMO-7", phase: "implementing", message: plan });
  expect(await inbox(db)).toEqual([]);
});

test("closing a plan leaves another project's plan and approval request untouched", async () => {
  const { db, ctx } = await setup();
  await reportPlan(ctx);
  const otherPlan = await addInboxItem(db, {
    project: "gadgets",
    ticket: "DEMO-7",
    kind: "plan",
    recipient: "coordinator",
    author: "other/7",
    body: plan,
    at: NOW,
  });
  await requestAnswer(tursoRequests(db), {
    project: "gadgets",
    question: otherPlan,
    text: "approved",
    author: "Grace",
    now: NOW,
  });
  await reportPhase(ctx, { ticket: "DEMO-7", phase: "implementing", message: "approved" });
  expect(await inbox(db)).toEqual([]);
  expect((await openInboxItems(db, { project: "gadgets", recipient: "coordinator" })).map((item) => item.kind)).toEqual(
    ["plan", "answer-request"],
  );
});

test("losing Turso still posts the full plan and awaiting-approval phase on Linear", async () => {
  const { ctx, linear } = await setup();
  const broken = {
    execute: async () => {
      throw new Error("connection reset");
    },
  } as unknown as Db;
  ctx.turso = async () => ({ db: broken, warning: null });
  const out = await reportPlan(ctx);
  expect(linear.bodies.at(-1)).toBe(
    `Agent status: awaiting-approval — Build the parser\n\n1. Add validation.\n2. Test malformed input.`,
  );
  expect(out.warnings).toEqual(["Turso: could not record the report (connection reset); Linear is up to date"]);
  expect(out.inbox).toBeNull();
});
