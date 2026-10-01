import { describe, expect, test } from "bun:test";
import { configTemplate, parseConfig } from "../src/config.ts";
import type { Fleet } from "../src/live.ts";
import type { CiState, PullRequest } from "../src/types.ts";
import { claimTicket, Refusal, releaseTicket, reportPhase, type WorkerContext } from "../src/worker.ts";
import { DEMO_TOML, FakeLinear, NOW, tempFleet } from "./support.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const config = parseConfig(`${DEMO_TOML}\n[gates]\nrequired_checks = ["test"]\n`);

type Live = ReturnType<typeof tempFleet>;

function setup(o: { live?: Live | null; pull?: PullRequest | null; config?: typeof config } = {}) {
  const linear = new FakeLinear();
  const ctx: WorkerContext = {
    config: o.config ?? config,
    linear,
    fleet: async () =>
      o.live ? { fleet: o.live.fleet, warning: null } : { fleet: null, warning: "not signed in to Armada" },
    readPull: async () => (o.pull === undefined ? null : o.pull),
    now: () => NOW,
  };
  return { linear, ctx };
}

const labelsOf = (linear: FakeLinear, id: string) => linear.get(id).labels.map((l) => l.name);
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: unknown) => {
      if (!(err instanceof Refusal)) throw err;
      return `${err.message}\nNext: ${err.next}`;
    },
  );

describe("claim", () => {
  test("claims the ticket in Linear and records the handle and the event through Armada", async () => {
    const live = tempFleet();
    const db = live.store;
    const { linear, ctx } = setup({ live });
    linear.add("DEMO-7");
    const out = await claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws-1/s-1" });

    const t = linear.get("DEMO-7");
    expect([t.statusType, t.assigneeId, labelsOf(linear, "DEMO-7")]).toEqual([
      "started",
      "user-owner",
      ["planning", "Conductor"],
    ]);
    expect(t.comments[0]?.claim).toMatchObject({
      runtime: "Conductor",
      session: "ws-1/s-1",
      branch: "feature/demo-7-do-the-thing",
      startedAt: NOW.toISOString(),
    });
    expect(t.comments[0]?.status).toEqual({ phase: "planning", summary: "claimed by Conductor (ws-1/s-1)" });
    expect(out.warnings).toEqual([]);
    expect(await db.getRuntimeHandle("widgets", "DEMO-7")).toMatchObject({ runtime: "Conductor", handle: "ws-1/s-1" });
    expect(await db.lastEventTimes("widgets")).toEqual({ "DEMO-7": NOW.toISOString() });
    expect((await db.listProjects()).map((p) => p.slug)).toEqual(["widgets"]);
  });

  test("a ticket another worker holds is refused and left untouched", async () => {
    const { linear, ctx } = setup();
    linear.add("DEMO-7", { statusType: "started" });
    linear.post(
      "DEMO-7",
      "Agent claim — runtime: Codex · session: ws-9 · branch: b · started: x",
      "2026-03-04T09:00:00Z",
    );
    expect(await refusal(claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws-1" }))).toBe(
      "DEMO-7 is already claimed by Codex · ws-9 since 2026-03-04T09:00:00Z\nNext: armada status, to pick another ticket ready to start",
    );
    expect(linear.writes).toEqual([]);
  });

  test("a ticket whose comments could not all be read is refused, since an older claim may be hidden", async () => {
    const { linear, ctx } = setup();
    linear.add("DEMO-7", { commentsTruncated: true });
    expect(await refusal(claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws-1" }))).toBe(
      'not every comment of DEMO-7 could be read, so an older claim may be hidden; nothing was written\nNext: armada claim DEMO-7 --runtime "conductor" --handle "ws-1" again once Linear answers',
    );
    expect(linear.writes).toEqual([]);
  });

  test("when two claims race, the older one wins and the loser withdraws its comment", async () => {
    const { linear, ctx } = setup();
    linear.add("DEMO-7");
    linear.afterComment = () =>
      linear.post("DEMO-7", "Agent claim — runtime: Codex · session: ws-9", "2026-03-04T09:59:59Z");
    expect(await refusal(claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws-1" }))).toBe(
      "DEMO-7 was claimed first by Codex · ws-9; your claim was withdrawn\nNext: armada status, to pick another ticket ready to start",
    );
    expect(linear.get("DEMO-7").comments.map((c) => c.claim?.session)).toEqual(["ws-9"]);
    expect(labelsOf(linear, "DEMO-7")).toEqual([]);
  });

  test("claiming again from the same session repairs labels without a second claim", async () => {
    const { linear, ctx } = setup();
    linear.add("DEMO-7");
    // An underscore survives the round trip through the comment.
    await claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws_1/s_1" });
    linear.get("DEMO-7").labels = [];
    await claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws_1/s_1" });
    expect(labelsOf(linear, "DEMO-7")).toEqual(["planning", "Conductor"]);
    expect(linear.get("DEMO-7").comments).toHaveLength(1);
  });

  describe("with a profile", () => {
    // The template's routing: web → opus, api → codex, Bug → debug.
    const routed = parseConfig(
      configTemplate({ name: "Widgets", slug: "widgets", programRoot: "DEMO-1", repository: "acme/widgets" }),
    );
    const webTicket = (linear: FakeLinear) =>
      linear.add("DEMO-7", { labels: [{ id: "l-web", name: "web", group: null }] });

    test("overriding the routed profile without a reason is refused before any write", async () => {
      const { linear, ctx } = setup({ config: routed });
      webTicket(linear);
      const claim = { ticket: "DEMO-7", runtime: "conductor", handle: "ws-1", profile: "codex" };
      expect(await refusal(claimTicket(ctx, claim))).toBe(
        'DEMO-7 is routed to "opus" by rule 1 of [[conductor.routing]] (label "web"); say why "codex" instead with --reason "<why>"\nNext: armada brief DEMO-7, which shows the profile the ticket routes to',
      );
      expect(linear.writes).toEqual([]);
    });

    test("the claim comment and the live data record the profile, and an override's reason", async () => {
      const live = tempFleet();
      const db = live.store;
      const { linear, ctx } = setup({ config: routed, live });
      webTicket(linear);
      const reason = "the page is fine; the session API is broken";
      await claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws-1", profile: "codex", reason });

      const [comment] = linear.get("DEMO-7").comments;
      expect(comment?.claim).toMatchObject({ session: "ws-1", startedAt: NOW.toISOString(), profile: "codex" });
      expect(linear.bodies[0]).toBe(
        `Agent status: planning — claimed by Conductor (ws-1)\n\nAgent claim — runtime: Conductor · session: ws-1 · branch: feature/demo-7-do-the-thing · started: ${NOW.toISOString()} · profile: codex\nProfile: codex (agent codex, model gpt-6.1-sol, effort high), chosen by --profile, instead of "opus" from rule 1 of [[conductor.routing]] (label "web"): ${reason}`,
      );
      expect(await db.getRuntimeHandle("widgets", "DEMO-7")).toMatchObject({ handle: "ws-1", profile: "codex" });
      expect(await db.getWorkerProfile("widgets", "DEMO-7")).toMatchObject({ name: "codex", routed: "opus", reason });

      // A resume keeps the claim's profile, whatever it asks for.
      const resumed = await claimTicket(ctx, {
        ticket: "DEMO-7",
        runtime: "conductor",
        handle: "ws-1",
        profile: "debug",
      });
      expect(resumed.warnings).toContain(
        "the claim keeps profile codex, not debug; release and claim again to change it",
      );
      expect(resumed.state).toEqual({
        status: "In Progress",
        phase: "planning",
        runtime: "Conductor",
        profile: "codex",
      });
      expect(await db.getWorkerProfile("widgets", "DEMO-7")).toMatchObject({ name: "codex" });

      // A release forgets it.
      await releaseTicket(ctx, { ticket: "DEMO-7", reason: "relaunch" });
      expect(await db.getWorkerProfile("widgets", "DEMO-7")).toBeNull();
    });
  });

  test("an unknown runtime names the labels that exist", async () => {
    const { linear, ctx } = setup();
    linear.add("DEMO-7");
    expect(await refusal(claimTicket(ctx, { ticket: "DEMO-7", runtime: "pi", handle: "x" }))).toBe(
      'no "pi" label in the "Agent runtime" label group (available: Conductor, Claude Code)\nNext: armada claim DEMO-7 --runtime "<one of: Conductor, Claude Code>" --handle x',
    );
  });
});

describe("report", () => {
  async function claimed(o: { live?: Live | null; pull?: PullRequest | null } = {}) {
    const s = setup(o);
    s.linear.add("DEMO-7");
    await claimTicket(s.ctx, { ticket: "DEMO-7", runtime: "claude-code", handle: "ws-1" });
    return s;
  }

  test("a valid move swaps the phase label, posts the status line and lists the worker's inbox", async () => {
    const live = tempFleet();
    const db = live.store;
    const { linear, ctx } = await claimed({ live });
    await db.addInboxItem({
      project: "widgets",
      ticket: "DEMO-7",
      kind: "question",
      recipient: "worker",
      author: "coordinator",
      body: "Use the v2 endpoint.",
      at: NOW,
    });
    const out = await reportPhase(ctx, {
      ticket: "DEMO-7",
      phase: "implementing",
      message: "plan approved\n\n1. build\n2. test",
    });
    expect(labelsOf(linear, "DEMO-7")).toEqual(["Claude Code", "implementing"]);
    expect(linear.writes.at(-1)).toBe("comment DEMO-7 Agent status: implementing — plan approved");
    expect(out.inbox?.map((i) => i.body)).toEqual(["Use the v2 endpoint."]);
  });

  test("an invalid move is refused with the reason and writes nothing", async () => {
    const { linear, ctx } = await claimed();
    const before = linear.writes.length;
    expect(await refusal(reportPhase(ctx, { ticket: "DEMO-7", phase: "shipping", message: "x" }))).toContain(
      "cannot go from planning to shipping",
    );
    expect(linear.writes.length).toBe(before);
  });

  test("ready-to-merge is checked against the pull request head and the required checks", async () => {
    const pull = (state: CiState): PullRequest => ({
      url: "https://github.com/acme/widgets/pull/9",
      number: 9,
      repo: "acme/widgets",
      title: "feat: widgets",
      state: "open",
      headSha: HEAD,
      checks: [{ name: "test", state }],
    });
    const shipping = (linear: FakeLinear) => {
      const t = linear.get("DEMO-7");
      t.labels = t.labels.map((l) => (l.name === "planning" ? { ...l, id: "phase-shipping", name: "shipping" } : l));
    };

    const red = await claimed({ pull: pull("failure") });
    shipping(red.linear);
    const before = red.linear.writes.length;
    expect(await refusal(reportPhase(red.ctx, { ticket: "DEMO-7", phase: "ready-to-merge", pr: "9", sha: HEAD }))).toBe(
      'DEMO-7: hand-back refused:\n  - required check "test" is failure\nNext: fix the points above, then armada report ready-to-merge --ticket DEMO-7 --pr 9 --sha <head sha>; report shipping meanwhile if the work is not done',
    );
    expect(red.linear.writes.length).toBe(before);

    const live = tempFleet();
    const db = live.store;
    const green = await claimed({ live, pull: pull("success") });
    shipping(green.linear);
    await reportPhase(green.ctx, { ticket: "DEMO-7", phase: "ready-to-merge", pr: "9", sha: HEAD.toUpperCase() });
    expect(green.linear.writes.slice(-3)).toEqual([
      "link DEMO-7 https://github.com/acme/widgets/pull/9",
      'update DEMO-7 {"addLabelIds":["phase-ready-to-merge"],"removeLabelIds":["phase-shipping"]}',
      `comment DEMO-7 Agent status: ready-to-merge — PR #9, head ${HEAD}, CI green`,
    ]);
    // Handing back again refreshes the coordinator's item instead of adding one.
    await reportPhase(green.ctx, { ticket: "DEMO-7", phase: "ready-to-merge", pr: "9", sha: HEAD });
    expect(db.items.filter((i) => i.ticket === "DEMO-7").map((i) => [i.kind, i.recipient])).toEqual([
      ["hand-back", "coordinator"],
    ]);
  });

  test("losing Armada still writes Linear and warns", async () => {
    const { linear, ctx } = await claimed();
    const broken = { report: async () => Promise.reject(new Error("connection reset")) } as unknown as Fleet;
    const out = await reportPhase(
      { ...ctx, fleet: async () => ({ fleet: broken, warning: null }) },
      { ticket: "DEMO-7", phase: "planning", message: "reading" },
    );
    expect(linear.writes.at(-1)).toBe("comment DEMO-7 Agent status: planning — reading");
    expect(out.warnings).toEqual(["Armada: could not record the report (connection reset); Linear is up to date"]);
    expect(out.inbox).toBeNull();
  });
});

describe("release", () => {
  test("removes the agent labels, moves the ticket back and closes the handle", async () => {
    const live = tempFleet();
    const db = live.store;
    const { linear, ctx } = setup({ live });
    const ready = { id: "ready", name: ctx.config.tracker.readyLabel, group: null };
    linear.add("DEMO-7", { labels: [ready] });
    await claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws-1" });
    await releaseTicket(ctx, { ticket: "DEMO-7", reason: "wrong ticket" });
    const t = linear.get("DEMO-7");
    expect([t.statusType, t.labels, t.comments[0]?.status]).toEqual([
      "unstarted",
      [ready],
      { phase: "released", summary: "wrong ticket" },
    ]);
    expect((await db.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBe(NOW.toISOString());
    // Released: a new worker may claim it.
    await claimTicket(ctx, { ticket: "DEMO-7", runtime: "claude-code", handle: "ws-2" });
    expect(labelsOf(linear, "DEMO-7")).toEqual([ready.name, "planning", "Claude Code"]);
  });
});
