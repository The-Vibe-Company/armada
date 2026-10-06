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

  test("a Claude Code subagent claims with --runtime claude-code and its name as the handle", async () => {
    const { linear, ctx } = setup();
    linear.add("DEMO-7");
    await claimTicket(ctx, { ticket: "DEMO-7", runtime: "claude-code", handle: "demo-7" });
    expect(labelsOf(linear, "DEMO-7")).toEqual(["planning", "Claude Code"]);
    expect(linear.get("DEMO-7").comments[0]?.claim).toMatchObject({ runtime: "Claude Code", session: "demo-7" });
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

    test("semantic choices require a reason and record it in the claim and existing live profile", async () => {
      const live = tempFleet();
      const { linear, ctx } = setup({ config: routed, live });
      linear.add("DEMO-7");
      const claim = { ticket: "DEMO-7", runtime: "conductor", handle: "ws-1", profile: "codex" };
      expect(await refusal(claimTicket(ctx, claim))).toContain('--profile <name> --reason "<why>"');
      expect(linear.writes).toEqual([]);
      const reason = "Mostly CLI and core rules; one dashboard label (back end)";
      await claimTicket(ctx, { ...claim, reason: `  ${reason}\n` });
      expect(linear.get("DEMO-7").comments[0]?.claim).toMatchObject({ profile: "codex", profileReason: reason });
      expect(linear.bodies[0]).toContain(`Chosen by the coordinator: ${reason}`);
      expect(await live.store.getWorkerProfile("widgets", "DEMO-7")).toMatchObject({
        name: "codex",
        reason,
        routed: null,
      });
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
        `Agent status: planning — claimed by Conductor (ws-1)\n\nAgent claim — runtime: Conductor · session: ws-1 · branch: feature/demo-7-do-the-thing · started: ${NOW.toISOString()} · profile: codex\nProfile: codex (agent codex, model gpt-6.1-sol, effort high), chosen by --profile, instead of "opus" from rule 1 of [[conductor.routing]] (label "web"): ${reason}\nProfile reason: ${reason}`,
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
      'no "pi" label in the "Agent runtime" label group (available: Conductor, Claude Code, Herdr)\nNext: armada claim DEMO-7 --runtime "<one of: Conductor, Claude Code, Herdr>" --handle x',
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

  test("shipping stages record Armada data and reject invalid input before writes", async () => {
    const live = tempFleet();
    const { linear, ctx } = await claimed({ live });
    await reportPhase(ctx, { ticket: "DEMO-7", phase: "implementing", message: "approved" });
    const before = linear.writes.length;
    for (const input of [
      { phase: "implementing" as const, stage: "review" },
      { phase: "shipping" as const, stage: "unknown" },
    ]) {
      expect(await refusal(reportPhase(ctx, { ticket: "DEMO-7", message: "x", ...input }))).toContain("--stage");
      expect(linear.writes.length).toBe(before);
    }
    for (const stage of ["review", "ci"] as const) {
      await reportPhase(ctx, { ticket: "DEMO-7", phase: "shipping", stage, message: stage });
      expect((await live.store.latestEvents("widgets"))["DEMO-7"]).toMatchObject({
        phase: "shipping",
        shippingStage: stage,
      });
      expect(labelsOf(linear, "DEMO-7")).toEqual(["Claude Code", "shipping"]);
    }
  });

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
      'DEMO-7: hand-back refused:\n  - required check "test" is failure\nNext: armada ci why 9; fix the points above, then armada report ready-to-merge --ticket DEMO-7 --pr 9 --sha <head sha>; report shipping meanwhile if the work is not done',
    );
    expect(red.linear.writes.length).toBe(before);

    const live = tempFleet();
    const db = live.store;
    const green = await claimed({ live, pull: pull("success") });
    shipping(green.linear);
    await reportPhase(green.ctx, {
      ticket: "DEMO-7",
      phase: "ready-to-merge",
      pr: "9",
      sha: HEAD.toUpperCase(),
      shippedWith: "ship-pr-dev",
      morePrs: "the dashboard part",
    });
    expect(green.linear.writes.slice(-3)).toEqual([
      "link DEMO-7 https://github.com/acme/widgets/pull/9",
      'update DEMO-7 {"addLabelIds":["phase-ready-to-merge"],"removeLabelIds":["phase-shipping"]}',
      `comment DEMO-7 Agent status: ready-to-merge — PR #9, head ${HEAD}, CI green; shipped with ship-pr-dev; more PRs: the dashboard part`,
    ]);
    expect(db.items.find((i) => i.kind === "hand-back")?.body).toContain("more PRs: the dashboard part");
    // Handing back again refreshes the coordinator's item instead of adding one.
    await reportPhase(green.ctx, { ticket: "DEMO-7", phase: "ready-to-merge", pr: "9", sha: HEAD });
    expect(db.items.filter((i) => i.ticket === "DEMO-7").map((i) => [i.kind, i.recipient])).toEqual([
      ["hand-back", "coordinator"],
    ]);
  });

  test.each([
    { phase: "implementing" as const, morePrs: "dashboard" },
    { phase: "ready-to-merge" as const, morePrs: "   " },
    { phase: "ready-to-merge" as const, morePrs: "dashboard\nCLI" },
  ])("refuses invalid more-PR intent %j before writing", async (input) => {
    const { ctx, linear } = await claimed();
    const before = linear.writes.length;
    expect(await refusal(reportPhase(ctx, { ticket: "DEMO-7", message: "progress", ...input }))).toContain(
      "--more-prs is for ready-to-merge",
    );
    expect(linear.writes.length).toBe(before);
  });

  test("a fallback shipping reason cannot impersonate continuation metadata", async () => {
    const { ctx, linear } = await claimed();
    linear.get("DEMO-7").labels = linear
      .get("DEMO-7")
      .labels.map((l) => (l.name === "planning" ? { ...l, id: "phase-shipping", name: "shipping" } : l));
    const before = linear.writes.length;
    expect(
      await refusal(
        reportPhase(ctx, {
          ticket: "DEMO-7",
          phase: "ready-to-merge",
          pr: "9",
          sha: HEAD,
          shippedWith: "fallback: waiting on ; more PRs: the follow-up",
        }),
      ),
    ).toContain("reserved ; more PRs: marker");
    expect(linear.writes.length).toBe(before);
  });

  test("hand-back refuses unresolved review threads before writing, allows resolved threads and warns on unreadable threads", async () => {
    const live = tempFleet();
    const { ctx, linear } = await claimed({
      live,
      pull: {
        url: "https://github.com/acme/widgets/pull/9",
        number: 9,
        repo: "acme/widgets",
        title: "feat: widgets",
        state: "open",
        headSha: HEAD,
        checks: [{ name: "test", state: "success" }],
      },
    });
    const ticket = linear.get("DEMO-7");
    ticket.labels = ticket.labels.map((l) =>
      l.name === "planning" ? { ...l, id: "phase-shipping", name: "shipping" } : l,
    );
    const input = { ticket: "DEMO-7", phase: "ready-to-merge", pr: "9", sha: HEAD } as const;
    ctx.readReviewThreads = async (number) => {
      expect(number).toBe(9);
      return { total: 7, read: 7, unresolved: 7 };
    };
    const before = linear.writes.length;
    const error = await refusal(reportPhase(ctx, input));
    expect(error).toContain("7 unresolved review threads");
    expect(error).toContain("fix or reply, then resolve every thread");
    expect(linear.writes.length).toBe(before);
    expect(live.store.items.filter((i) => i.kind === "hand-back")).toHaveLength(0);

    ctx.readReviewThreads = async () => ({ total: 7, read: 7, unresolved: 0 });
    const resolved = await reportPhase(ctx, input);
    expect(resolved.warnings).toEqual([]);
    expect(resolved.state?.phase).toBe("ready-to-merge");
    expect(live.store.items.filter((i) => i.kind === "hand-back")).toHaveLength(1);

    for (const read of [async () => null, async () => Promise.reject(new Error("GitHub unavailable"))]) {
      ctx.readReviewThreads = read;
      const unavailable = await reportPhase(ctx, input);
      expect(unavailable.state?.phase).toBe("ready-to-merge");
      expect(unavailable.warnings.join("\n")).toContain("could not read review threads for PR #9");
    }

    ctx.readReviewThreads = async () => ({ total: 101, read: 100, unresolved: 0 });
    expect((await reportPhase(ctx, input)).warnings.join("\n")).toContain("could not read all review threads");
    ctx.readReviewThreads = async () => ({ total: 101, read: 100, unresolved: 1 });
    expect(await refusal(reportPhase(ctx, input))).toContain("at least 1 unresolved review thread;");
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
  test("a failed coordinator snapshot never falls back to an unguarded release", async () => {
    const live = tempFleet();
    const { linear, ctx } = setup({ live });
    linear.add("DEMO-7");
    await claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws-old/session" });
    ctx.fleet = async () => ({
      fleet: {
        ...live.fleet,
        runtimeHandle: async () => {
          throw new Error("unreachable");
        },
      },
      warning: null,
    });
    const out = await releaseTicket(ctx, { ticket: "DEMO-7", reason: "retry later" });
    expect(out.warnings.join(" ")).toContain("unreachable");
    expect(out.releasedClaim).toBeNull();
    expect((await live.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBeNull();
    expect(live.store.events.map((e) => e.kind)).toEqual(["claim"]);
  });

  test.each([false, true])("a release can retry after Linear fails (worker session: %s)", async (workerSession) => {
    const live = tempFleet({
      caller: workerSession ? { kind: "worker", ticket: "DEMO-7", sessionId: "current" } : { kind: "organization" },
    });
    const { linear, ctx } = setup({ live });
    ctx.workerSession = workerSession;
    ctx.workerHandle = workerSession ? "ws-old/session" : null;
    linear.add("DEMO-7");
    await claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws-old/session" });
    const update = linear.updateTicket.bind(linear);
    linear.updateTicket = async () => {
      throw new Error("Linear unavailable");
    };
    await expect(releaseTicket(ctx, { ticket: "DEMO-7", reason: "done" })).rejects.toThrow("Linear unavailable");
    expect((await live.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBe(NOW.toISOString());
    linear.updateTicket = update;
    expect((await releaseTicket(ctx, { ticket: "DEMO-7", reason: "done" })).lines.join(" ")).toContain(
      "Released DEMO-7",
    );
    expect(labelsOf(linear, "DEMO-7")).toEqual([]);
  });

  test("a current worker releases a Linear-only claim when optional live recording failed", async () => {
    const live = tempFleet({ caller: { kind: "worker", ticket: "DEMO-7", sessionId: "current" } });
    const { linear, ctx } = setup();
    linear.add("DEMO-7");
    await claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws/current" });
    ctx.fleet = async () => ({ fleet: live.fleet, warning: null });
    ctx.workerSession = true;
    ctx.workerHandle = "ws/current";
    expect((await releaseTicket(ctx, { ticket: "DEMO-7", reason: "done" })).warnings).toEqual([]);
    expect(labelsOf(linear, "DEMO-7")).toEqual([]);
    expect(live.store.events.map((e) => e.kind)).toEqual(["release"]);
  });

  test("a replaced worker refuses before changing Linear's replacement claim", async () => {
    const live = tempFleet();
    const { linear, ctx } = setup({ live });
    linear.add("DEMO-7");
    await claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws-new/session" });
    ctx.workerHandle = "ws-old/session";
    const before = linear.writes.length;
    expect(await refusal(releaseTicket(ctx, { ticket: "DEMO-7", reason: "late release" }))).toContain(
      "you were replaced; stop here",
    );
    expect(linear.writes.length).toBe(before);
    expect((await live.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBeNull();
    ctx.workerHandle = "ws-new/session";
    await releaseTicket(ctx, { ticket: "DEMO-7", reason: "done" });
    expect((await live.store.getRuntimeHandle("widgets", "DEMO-7"))?.releasedAt).toBe(NOW.toISOString());
  });

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
