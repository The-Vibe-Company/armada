import { expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { answerItem, checkInbox } from "../src/inbox.ts";
import { parseStatusLine } from "../src/linear.ts";
import { type Fleet, type FleetStore, readInbox, recordReport } from "../src/live.ts";
import { RequestRefusal, requestAnswer } from "../src/requests.ts";
import { claimTicket, releaseTicket, reportPhase, type WorkerContext } from "../src/worker.ts";
import { DEMO_TOML, FakeLinear, fakeClock, NOW, tempFleet } from "./support.ts";

const project = "widgets";
const plan = "Build the parser\n\n1. Add validation.\n2. Test malformed input.";

async function setup(clock = fakeClock()) {
  const live = tempFleet({ clock });
  const db = live.store;
  const linear = new FakeLinear();
  const ctx: WorkerContext = {
    config: parseConfig(DEMO_TOML),
    linear,
    fleet: async () => ({ fleet: live.fleet, warning: null }),
    readPull: null,
    now: () => NOW,
  };
  linear.add("DEMO-7");
  await claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws/7" });
  return { db, linear, ctx, live };
}

const inbox = (db: FleetStore) => db.openInboxItems({ project, recipient: "coordinator" });
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

test("--plan posts the plan as its own block under a one-line status; awaiting-approval still sends it in full", async () => {
  const { db, ctx, linear } = await setup();
  const long = `## Plan\n\n- ${"Parse every widget field and reject the malformed ones ".repeat(3)}\n- Test it.`;
  await reportPhase(ctx, { ticket: "DEMO-7", phase: "implementing", plan: long });
  const summary = `${"Parse every widget field and reject the malformed ones ".repeat(2).slice(0, 99).trimEnd()}…`;
  expect(linear.bodies.at(-1)).toBe(`Agent status: implementing — ${summary}\n\n## Plan\n\n${long}`);
  expect(parseStatusLine(linear.bodies.at(-1) ?? "")).toEqual({ phase: "implementing", summary, plan: true });
  expect(await inbox(db)).toEqual([]);

  const { db: db2, ctx: ctx2, linear: linear2 } = await setup();
  await reportPhase(ctx2, {
    ticket: "DEMO-7",
    phase: "awaiting-approval",
    message: "Plan: parser first\nThe tests come from the issue.",
    plan,
  });
  const block = `The tests come from the issue.\n\n## Plan\n\n${plan}`;
  expect(linear2.bodies.at(-1)).toBe(`Agent status: awaiting-approval — Plan: parser first\n\n${block}`);
  expect(await inbox(db2)).toEqual([expect.objectContaining({ kind: "plan", body: `Plan: parser first\n\n${block}` })]);
});

test("inbox --wait wakes when a worker posts a plan", async () => {
  const clock = fakeClock();
  const { ctx, live } = await setup(clock);
  const sleep = async (ms: number) => {
    await clock.sleep(ms);
    await reportPlan(ctx);
  };
  const out = await checkInbox(live.fleet, {
    project,
    silentAfterMinutes: 15,
    now: clock.now,
    wait: { timeoutMs: 60_000, sleep },
  });
  expect(out.wait?.timedOut).toBe(false);
  expect(out.items).toEqual([expect.objectContaining({ kind: "plan", body: plan, new: true })]);
});

test.each(["item", "ticket", "item-note", "ticket-note"])(
  "%s answers resolve the plan and record it on Linear",
  async (mode) => {
    const { db, ctx, linear, live } = await setup();
    await reportPlan(ctx);
    const pending = (await inbox(db))[0];
    const target = mode.startsWith("item") ? String(pending?.id) : "DEMO-7";
    live.clock.advance(1);
    await answerItem(ctx, { target, text: "approved", note: mode.endsWith("note") });
    expect(await inbox(db)).toEqual([]);
    expect(await db.getInboxItem(project, pending?.id ?? 0)).toMatchObject({ resolution: "approved" });
    expect(linear.bodies.at(-1)).toContain(
      `Agent status: awaiting-approval — ${mode.endsWith("note") ? "note" : "answer"}: approved`,
    );
    const later = new Date(NOW.getTime() + 16 * 60_000);
    expect(await readInbox(db, { project, silentAfterMinutes: 15, now: later })).toEqual([
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
  const requestId = await requestAnswer(db, request);
  expect((await inbox(db)).map((item) => item.kind)).toEqual(["plan", "answer-request"]);
  await expect(requestAnswer(db, request)).rejects.toBeInstanceOf(RequestRefusal);
  await answerItem(ctx, { target: String(requestId), text: "approved" });
  expect(await inbox(db)).toEqual([]);
  expect(linear.bodies.at(-1)).toContain(`plan #${pending?.id}`);
  expect(linear.bodies.at(-1)).toContain("Ada");
  await expect(requestAnswer(db, request)).rejects.toBeInstanceOf(RequestRefusal);
});

test.each(["phase", "release", "answer", "note"])("%s closes obsolete plan answer requests", async (mode) => {
  const { db, ctx } = await setup();
  await reportPlan(ctx);
  const pending = (await inbox(db))[0];
  await requestAnswer(db, {
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
  const { db, ctx, linear } = await setup();
  await linear.updateTicket("DEMO-7", { addLabelIds: ["plan-approved"] });
  await reportPhase(ctx, { ticket: "DEMO-7", phase: "implementing", plan });
  expect(await inbox(db)).toEqual([]);
});

test("an older CLI's plain plan is annotated from the stored snapshot and one answer resolves it", async () => {
  const { db, ctx } = await setup();
  // An older CLI sends no pre-approval hint in its report payload.
  await recordReport(
    db,
    project,
    {
      ticket: "DEMO-7",
      phase: "awaiting-approval",
      previous: "planning",
      summary: "Build the parser",
      message: plan,
      prUrl: null,
      headSha: null,
    },
    NOW,
  );
  const snapshot = {
    config: ctx.config,
    repository: ctx.config.github.repository,
    issues: [{ id: "DEMO-7", statusType: "started" as const, labels: ["plan-approved"] }],
    prs: [],
  };
  const options = { project, now: NOW, silentAfterMinutes: 15, snapshot };
  const pending = (await readInbox(db, options)).find((entry) => entry.kind === "plan");
  expect(pending?.body).toBe(`Pre-approved at launch; answer approved to let this worker continue.\n\n${plan}`);
  snapshot.issues[0]?.labels.push("needs-plan-approval");
  expect((await readInbox(db, options)).find((entry) => entry.kind === "plan")?.body).toBe(plan);
  await answerItem(ctx, { target: String(pending?.id), text: "approved" });
  expect(await inbox(db)).toEqual([]);
});

test("closing a plan leaves another project's plan and approval request untouched", async () => {
  const { db, ctx } = await setup();
  await reportPlan(ctx);
  const otherPlan = await db.addInboxItem({
    project: "gadgets",
    ticket: "DEMO-7",
    kind: "plan",
    recipient: "coordinator",
    author: "other/7",
    body: plan,
    at: NOW,
  });
  await requestAnswer(db, {
    project: "gadgets",
    question: otherPlan,
    text: "approved",
    author: "Grace",
    now: NOW,
  });
  await reportPhase(ctx, { ticket: "DEMO-7", phase: "implementing", message: "approved" });
  expect(await inbox(db)).toEqual([]);
  expect((await db.openInboxItems({ project: "gadgets", recipient: "coordinator" })).map((item) => item.kind)).toEqual([
    "plan",
    "answer-request",
  ]);
});

test("losing Armada still posts the full plan and awaiting-approval phase on Linear", async () => {
  const { ctx, linear } = await setup();
  const broken = {
    report: async () => {
      throw new Error("connection reset");
    },
  } as unknown as Fleet;
  ctx.fleet = async () => ({ fleet: broken, warning: null });
  const out = await reportPlan(ctx);
  expect(linear.bodies.at(-1)).toBe(
    `Agent status: awaiting-approval — Build the parser\n\n1. Add validation.\n2. Test malformed input.`,
  );
  expect(out.warnings).toEqual(["Armada: could not record the report (connection reset); Linear is up to date"]);
  expect(out.inbox).toBeNull();
});
