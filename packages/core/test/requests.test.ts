import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { answerItem, askCoordinator } from "../src/inbox.ts";
import { type FleetStore, readInbox } from "../src/live.ts";
import { RequestRefusal, requestAnswer, requestLaunch } from "../src/requests.ts";
import type { FrontierTicket, InFlightTicket, StatusReport } from "../src/status.ts";
import { claimTicket, releaseTicket, type WorkerContext } from "../src/worker.ts";
import { DEMO_TOML, FakeLinear, NOW, tempFleet } from "./support.ts";

const config = parseConfig(`${DEMO_TOML}
[conductor]
default_profile = "opus"

[conductor.profiles.opus]
agent = "claude"
model = "opus-5-5"
effort = "high"

[conductor.profiles.codex]
agent = "codex"
model = "gpt-6"
effort = "high"
`);
const P = "widgets";

function setup(live: ReturnType<typeof tempFleet>) {
  const linear = new FakeLinear();
  const ctx: WorkerContext = {
    config,
    linear,
    fleet: async () => ({ fleet: live.fleet, warning: null }),
    readPull: null,
    now: () => NOW,
  };
  return { linear, ctx };
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: unknown) => {
      if (!(err instanceof RequestRefusal)) throw err;
      return err.code;
    },
  );

const inbox = (db: FleetStore) => readInbox(db, { project: P, silentAfterMinutes: 15, now: NOW });

describe("answering from the dashboard", () => {
  test("the answer waits in the coordinator's inbox until it is delivered; then the question and the request close", async () => {
    const live = tempFleet();
    const db = live.store;
    const { linear, ctx } = setup(live);
    linear.add("DEMO-7");
    await claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws/7" });
    const { item } = await askCoordinator(ctx, { ticket: "DEMO-7", question: "15 or 30 minutes?" });
    const question = item ?? 0;
    const ask = { project: P, question, author: "  Ada \n Lovelace ", now: NOW };

    expect(await code(requestAnswer(db, { ...ask, text: "  " }))).toBe("empty-answer");
    expect(await code(requestAnswer(db, { ...ask, text: "30", author: " " }))).toBe("no-author");
    expect(await code(requestAnswer(db, { ...ask, text: "x".repeat(4001) }))).toBe("answer-too-long");
    expect(await code(requestAnswer(db, { ...ask, question: 99, text: "30" }))).toBe("no-question");
    expect(await code(requestAnswer(db, { ...ask, project: "gadgets", text: "30" }))).toBe("no-question");

    const request = await requestAnswer(db, { ...ask, text: "30 minutes.\nShorter annoys people." });
    expect(await code(requestAnswer(db, { ...ask, text: "15" }))).toBe("answer-waiting");
    expect((await inbox(db)).map((e) => [e.id, e.kind, e.author, e.request])).toEqual([
      [question, "question", "ws/7", undefined],
      [request, "answer-request", "Ada Lovelace", { question, profile: null }],
    ]);

    const out = await answerItem(ctx, { target: `#${request}`, text: "30 minutes.\nShorter annoys people." });
    expect(linear.bodies.at(-1)).toBe(
      `Agent status: blocked — answer: 30 minutes.\n\nShorter annoys people.\n\nAnswers question #${question}, as Ada Lovelace asked from the dashboard (request #${request}).`,
    );
    expect(out.lines).toContain(`Dashboard request #${request} delivered; question #${question} resolved.`);
    expect(await inbox(db)).toEqual([]);
    expect(await code(requestAnswer(db, { ...ask, text: "15" }))).toBe("question-closed");
  });

  test("an answer the coordinator records itself, or a release, closes the owner's pending answer", async () => {
    const live = tempFleet();
    const db = live.store;
    const { linear, ctx } = setup(live);
    for (const id of ["DEMO-7", "DEMO-8"]) {
      linear.add(id);
      await claimTicket(ctx, { ticket: id, runtime: "conductor", handle: `ws/${id}` });
    }
    const first = (await askCoordinator(ctx, { ticket: "DEMO-7", question: "A?" })).item ?? 0;
    const second = (await askCoordinator(ctx, { ticket: "DEMO-8", question: "B?" })).item ?? 0;
    await requestAnswer(db, { project: P, question: first, text: "yes", author: "Ada", now: NOW });
    await requestAnswer(db, { project: P, question: second, text: "no", author: "Ada", now: NOW });

    await answerItem(ctx, { target: String(first), text: "yes, decided already" });
    await releaseTicket(ctx, { ticket: "DEMO-8", reason: "not needed" });
    expect(await inbox(db)).toEqual([]);
  });
});

const frontierTicket = (id: string, route: FrontierTicket["route"]): FrontierTicket => ({
  id,
  title: `Ticket ${id}`,
  url: `https://linear.app/acme/issue/${id}`,
  spec: null,
  readyForAgent: true,
  onCriticalPath: false,
  unlocks: [],
  route,
});

const report = (frontier: FrontierTicket[], inFlight: Pick<InFlightTicket, "id">[] = []) =>
  ({ frontier, inFlight }) as unknown as StatusReport;

describe("launching from the dashboard", () => {
  test("a ready ticket gets one launch request, on its routed profile or the one chosen; the claim resolves it", async () => {
    const live = tempFleet();
    const db = live.store;
    const { linear, ctx } = setup(live);
    const routed = { profile: "opus", why: "conductor.default_profile" };
    const ready = report([frontierTicket("DEMO-9", routed), frontierTicket("DEMO-10", routed)], [{ id: "DEMO-3" }]);
    const launch = { config, report: ready, author: "Ada", now: NOW };

    expect(await code(requestLaunch(db, { ...launch, ticket: "DEMO-3", profile: null }))).toBe("in-flight");
    expect(await code(requestLaunch(db, { ...launch, ticket: "DEMO-4", profile: null }))).toBe("not-ready");
    expect(await code(requestLaunch(db, { ...launch, ticket: "DEMO-9", profile: "sonnet" }))).toBe("unknown-profile");
    await db.saveRuntimeHandle({
      project: P,
      ticket: "DEMO-10",
      runtime: "Conductor",
      handle: "ws/x",
      branch: null,
      at: NOW,
    });
    expect(await code(requestLaunch(db, { ...launch, ticket: "DEMO-10", profile: null }))).toBe("in-flight");

    const id = await requestLaunch(db, {
      ...launch,
      author: "Ada O'Neil $(id)",
      ticket: "demo-9",
      profile: "codex",
    });
    expect(await code(requestLaunch(db, { ...launch, ticket: "DEMO-9", profile: null }))).toBe("launch-waiting");
    expect(await db.getInboxItem(P, id)).toMatchObject({
      kind: "launch-request",
      ticket: "DEMO-9",
      author: "Ada O'Neil $(id)",
      request: { question: null, profile: "codex" },
      body: `Launch DEMO-9 — Ticket DEMO-9\nProfile: codex (agent codex, model gpt-6, effort high)\nRouting gives opus (conductor.default_profile); Ada O'Neil $(id) chose codex: brief and claim with --profile codex --reason 'asked from the dashboard by Ada O'\\''Neil $(id)'`,
    });

    linear.add("DEMO-9");
    const out = await claimTicket(ctx, { ticket: "DEMO-9", runtime: "conductor", handle: "ws/9" });
    expect(out.lines).toContain(`Launch request #${id} from Ada O'Neil $(id) resolved.`);
    expect(linear.bodies.at(-1)).toBe(
      `Agent status: planning — launched as Ada O'Neil $(id) asked from the dashboard (request #${id})`,
    );
    expect(await db.getInboxItem(P, id)).toMatchObject({ resolution: "claimed by Conductor (ws/9)" });
  });

  test("the coordinator declines a launch with armada answer: closed, nothing posted on the ticket", async () => {
    const live = tempFleet();
    const db = live.store;
    const { linear, ctx } = setup(live);
    const ready = report([frontierTicket("DEMO-9", { profile: "opus", why: "conductor.default_profile" })]);
    const id = await requestLaunch(db, {
      config,
      report: ready,
      ticket: "DEMO-9",
      profile: null,
      author: "Ada",
      now: NOW,
    });
    expect(await db.getInboxItem(P, id)).toMatchObject({ request: { profile: "opus" } });

    const out = await answerItem(ctx, { target: String(id), text: "it collides with DEMO-3" });
    expect(out.lines).toEqual([`Launch request #${id} for DEMO-9 declined; the dashboard shows it closed.`]);
    expect(linear.bodies).toEqual([]);
    expect(await db.getInboxItem(P, id)).toMatchObject({ resolution: "declined: it collides with DEMO-3" });
    // A new request is possible once the old one is closed.
    expect(
      await requestLaunch(db, {
        config,
        report: ready,
        ticket: "DEMO-9",
        profile: null,
        author: "Ada",
        now: NOW,
      }),
    ).toBeGreaterThan(id);
  });
});
