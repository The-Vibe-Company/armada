import { describe, expect, test } from "bun:test";
import { ArmadaApiError } from "../src/armada-api.ts";
import { parseConfig } from "../src/config.ts";
import { answerItem } from "../src/inbox.ts";
import { serveInbox } from "../src/live.ts";
import { requestDecision } from "../src/requests.ts";
import { closeValidated, submitValidation } from "../src/validate.ts";
import { chooseValidations, mergeApproval, type Validation, ValidationChoiceError } from "../src/validations.ts";
import { claimTicket, Refusal, reportPhase, type WorkerContext } from "../src/worker.ts";
import { DEMO_TOML, FakeLinear, NOW, tempFleet } from "./support.ts";

// What the owner validates (THE-885): a worker's design, the coordinator's
// escalated question, the owner's decision reaching the coordinator's inbox.
const config = parseConfig(DEMO_TOML);

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

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: unknown) => {
      if (!(err instanceof Refusal) && !(err instanceof ArmadaApiError)) throw err;
      return err.message;
    },
  );

describe("armada validate", () => {
  test("a worker submits its design: awaiting-validation with the link, on the owner's page; a resubmission replaces it", async () => {
    const live = tempFleet({ caller: { kind: "worker", ticket: "DEMO-7" } });
    const { linear, ctx } = setup(live);
    linear.add("DEMO-7");
    await claimTicket(ctx, { ticket: "DEMO-7", runtime: "conductor", handle: "ws-1/s-1" });
    await reportPhase(ctx, { ticket: "DEMO-7", phase: "implementing", message: "plan approved" });

    const out = await submitValidation(ctx, {
      ticket: "DEMO-7",
      kind: "validation",
      what: "Two directions for the product card\nA keeps the photo square.",
      choices: null,
      attachments: ["att-1"],
      worker: true,
    });
    expect(out.link).toBe("https://armada.example.test/approve/1");
    expect(out.state?.phase).toBe("awaiting-validation");
    expect(linear.get("DEMO-7").comments[0]?.status).toEqual({
      phase: "awaiting-validation",
      summary: "Two directions for the product card — https://armada.example.test/approve/1",
    });
    expect(out.lines.at(-1)).toStartWith("Stop here until the owner decides");
    expect(live.store.validations).toMatchObject([
      { id: 1, ticket: "DEMO-7", kind: "validation", author: "ws-1/s-1", attachments: ["att-1"], decision: null },
    ]);

    // Changes requested: the worker revises and submits again; the new one replaces the open one.
    await reportPhase(ctx, { ticket: "DEMO-7", phase: "implementing", message: "revising" });
    await submitValidation(ctx, {
      ticket: "DEMO-7",
      kind: "validation",
      what: "The revised card",
      choices: null,
      attachments: [],
      worker: true,
    });
    expect(live.store.validations.map((v) => [v.id, v.decision?.outcome ?? null])).toEqual([
      [1, "superseded"],
      [2, null],
    ]);
  });

  test("a worker session validates its own ticket only, and never a merge", async () => {
    const live = tempFleet({ caller: { kind: "worker", ticket: "DEMO-7" } });
    const v = { kind: "validation" as const, what: "x", reason: null, choices: null, pr: null, attachments: [] };
    expect(await refusal(live.fleet.validate({ ...v, ticket: "DEMO-8" }))).toBe(
      "Armada refused: a worker session only claims, reports, asks, validates and releases its own ticket (DEMO-7), not DEMO-8",
    );
    expect(await refusal(live.fleet.validate({ ...v, ticket: "DEMO-7", kind: "question", choices: ["a", "b"] }))).toBe(
      "Armada refused: fleet validate: a worker session only asks the owner to validate its work (kind validation)",
    );
    expect(live.store.validations).toEqual([]);
    // Its own validation carries no pull request card or reason it could invent.
    const pr = {
      number: 9,
      url: "https://github.com/acme/widgets/pull/9",
      title: "x",
      headSha: "a".repeat(40),
      files: null,
      additions: null,
      deletions: null,
      ci: "success" as const,
      preview: "https://elsewhere.example.test",
    };
    await live.fleet.validate({ ...v, ticket: "DEMO-7", pr, reason: "the rule says so" });
    expect(live.store.validations).toMatchObject([{ ticket: "DEMO-7", pr: null, reason: null }]);
  });
});

describe("the owner's decision", () => {
  test("reaches the coordinator's inbox as a decision item, which wakes armada watch", async () => {
    const live = tempFleet();
    const { linear, ctx } = setup(live);
    linear.add("DEMO-7");
    const { validation } = await submitValidation(ctx, {
      ticket: "DEMO-7",
      kind: "question",
      what: "Ship the adapter behind a flag first?",
      choices: ["Behind a flag", "On for everyone"],
      attachments: [],
      worker: false,
    });
    expect(linear.get("DEMO-7").comments[0]?.excerpt).toStartWith(
      "Question for the owner: Ship the adapter behind a flag first?",
    );
    const read = () =>
      serveInbox(live.store, "widgets", { coordinator: null, silentAfterMinutes: 15, etag: null }, NOW);
    const before = await read();
    expect(before?.items).toEqual([]);

    const decide = (choice: string) =>
      requestDecision(live.store, {
        project: "widgets",
        id: validation?.id ?? 0,
        action: "choice",
        choice,
        author: "Ada",
        now: NOW,
      });
    await expect(decide("Later")).rejects.toThrow("pick one of: Behind a flag, On for everyone");
    const item = await decide("Behind a flag");
    const after = await read();
    expect(after?.etag).not.toBe(before?.etag);
    expect(after?.items).toMatchObject([
      {
        id: item,
        kind: "decision",
        ticket: "DEMO-7",
        author: "Ada",
        request: { validation: validation?.id },
        body: `Ada answered DEMO-7's question "Ship the adapter behind a flag first?": Behind a flag\nRelay it to the worker, then armada answer <this item> "<what you did>".`,
      },
    ]);
    // Decided once: a second click, or another viewer, is refused.
    await expect(decide("On for everyone")).rejects.toThrow("was already decided");
  });
});

describe("armada answer", () => {
  test("records what the coordinator did with the owner's decision, and closes it", async () => {
    const live = tempFleet();
    const { linear, ctx } = setup(live);
    linear.add("DEMO-7");
    const { validation } = await submitValidation(ctx, {
      ticket: "DEMO-7",
      kind: "validation",
      what: "The card",
      choices: null,
      attachments: [],
      worker: false,
    });
    const item = await requestDecision(live.store, {
      project: "widgets",
      id: validation?.id ?? 0,
      action: "changes",
      note: "Softer shadow",
      author: "Ada",
      now: NOW,
    });
    const out = await answerItem(ctx, { target: String(item), text: "relayed to the worker" });
    expect(out.lines).toEqual([`Inbox item #${item} resolved.`]);
    expect(live.store.items.find((i) => i.id === item)?.resolution).toBe("relayed to the worker");
  });
});

describe("armada done", () => {
  test("closes a design ticket once the owner approved it: the design on the ticket, Done, the session ended", async () => {
    const live = tempFleet();
    const { linear, ctx } = setup(live);
    linear.add("DEMO-7", { statusType: "started", stateId: "st-progress" });
    const close = () =>
      closeValidated(ctx, { ticket: "DEMO-7", attachmentUrl: (id) => `https://armada.example.test/a/${id}` });
    expect(await refusal(close())).toBe("DEMO-7 has no validation the owner approved");

    const { validation } = await submitValidation(ctx, {
      ticket: "DEMO-7",
      kind: "validation",
      what: "Direction B: full-bleed photo",
      choices: null,
      attachments: ["att-9"],
      worker: false,
    });
    expect(await refusal(close())).toBe(
      "DEMO-7's validation #1 is still waiting for the owner: only an approved one closes the ticket",
    );
    await requestDecision(live.store, {
      project: "widgets",
      id: validation?.id ?? 0,
      action: "approve",
      note: "B, with a softer shadow",
      author: "Ada",
      now: NOW,
    });
    const out = await close();
    const t = linear.get("DEMO-7");
    expect(t.statusType).toBe("completed");
    expect(t.comments[0]?.status).toEqual({
      phase: "merged",
      summary: "done without a pull request: validation #1 approved by Ada at 2026-03-04 10:00 UTC",
    });
    expect(t.comments[0]?.excerpt).toContain("B, with a softer shadow");
    expect(out.lines.at(-1)).toBe("Building it is a separate ticket: cut it, blocked by this one.");
    expect(live.store.events.at(-1)).toMatchObject({ ticket: "DEMO-7", kind: "merge", phase: "merged" });
  });
});

describe("the launch's judgement of [[policy.validation]]", () => {
  const rules = [{ when: "a design ticket", show: "attach the design and wait" }];
  const judge = (requested: string | null, reason: string | null = null) =>
    chooseValidations(rules, { ticket: "DEMO-7", requested, reason, command: "armada brief DEMO-7 --prompt" });
  const next = (f: () => unknown) => {
    try {
      f();
    } catch (err) {
      if (err instanceof ValidationChoiceError) return err.next;
    }
    throw new Error("expected a refusal");
  };

  test("is asked of every brief when the project has rules; none needs no reason, a rule does", () => {
    expect(
      chooseValidations([], { ticket: "DEMO-7", requested: null, reason: null, command: "armada brief DEMO-7" }),
    ).toBe(null);
    expect(next(() => judge(null))).toBe("armada brief DEMO-7 --prompt --validation none");
    expect(judge("none")).toEqual({ rules: [], reason: null });
    expect(next(() => judge("1"))).toBe(
      "armada brief DEMO-7 --prompt --validation 1 --validation-reason '<why this ticket is one>'",
    );
    expect(judge("1", "a mockup of the new card")).toEqual({
      rules: [{ index: 1, when: "a design ticket", show: "attach the design and wait" }],
      reason: "a mockup of the new card",
    });
    expect(next(() => judge("2", "x"))).toBe("armada brief DEMO-7 --prompt --validation none");
  });
});

describe("the claim", () => {
  test("records the validation rules the coordinator judged apply, with its reason", async () => {
    const { linear, ctx } = setup(tempFleet());
    linear.add("DEMO-7");
    await claimTicket(ctx, {
      ticket: "DEMO-7",
      runtime: "conductor",
      handle: "ws-1/s-1",
      validation: { rules: [{ index: 1, when: "a design ticket", show: "attach it" }], reason: "a mockup of the card" },
    });
    expect(linear.get("DEMO-7").comments[0]?.excerpt).toContain(
      "Owner validation: rule 1 (a design ticket) — a mockup of the card",
    );
  });
});

describe("a merge approval", () => {
  const asked = (over: Partial<Validation> = {}): Validation => ({
    id: 1,
    project: "widgets",
    ticket: "DEMO-7",
    kind: "merge",
    what: "x",
    reason: null,
    choices: null,
    pr: {
      number: 9,
      url: "https://github.com/acme/widgets/pull/9",
      title: "x",
      headSha: "a".repeat(40),
      files: null,
      additions: null,
      deletions: null,
      ci: "success",
      preview: null,
    },
    attachments: [],
    author: "coordinator",
    createdAt: NOW.toISOString(),
    decision: { outcome: "approved", answer: null, note: null, by: "Ada", at: NOW.toISOString() },
    ...over,
  });

  test("counts for the head the owner saw, or that head with only the base merged in", () => {
    const approved = [asked()];
    expect(mergeApproval(approved, 9, { sha: "a".repeat(40), sameAs: [] }).state).toBe("approved");
    expect(
      mergeApproval(approved, 9, { sha: "b".repeat(40), sameAs: ["b".repeat(40), "c".repeat(40), "a".repeat(40)] })
        .state,
    ).toBe("approved");
    expect(mergeApproval(approved, 9, { sha: "b".repeat(40), sameAs: [] }).state).toBe("stale");
    expect(mergeApproval(approved, 8, { sha: "a".repeat(40), sameAs: [] }).state).toBe("none");
    expect(mergeApproval([asked({ decision: null })], 9, { sha: "a".repeat(40), sameAs: [] }).state).toBe("pending");
  });
});
