import { describe, expect, test } from "bun:test";
import { buildInsights, type OwnerValidation } from "@armada/core/read";
import { decisionMedian, type KeyPress, nextOpen, validationKey } from "../lib/validation-keys.ts";

const press = (key: string, over: Partial<KeyPress> = {}): KeyPress => ({
  key,
  meta: false,
  ctrl: false,
  alt: false,
  repeat: false,
  where: "page",
  ...over,
});
const open = { open: true, choices: 0, changing: false };

describe("the Validations page's keys", () => {
  test("A approves and C asks for changes, then ⌘↵ in the note sends them and Esc leaves it", () => {
    expect(validationKey(press("a"), open)).toEqual({ kind: "approve" });
    expect(validationKey(press("A"), open)).toEqual({ kind: "approve" });
    expect(validationKey(press("c"), open)).toEqual({ kind: "changes" });
    const note = { ...open, changing: true };
    expect(validationKey(press("Enter", { meta: true, where: "note" }), note)).toEqual({ kind: "send" });
    expect(validationKey(press("Enter", { ctrl: true, where: "note" }), note)).toEqual({ kind: "send" });
    expect(validationKey(press("Escape", { where: "note" }), note)).toEqual({ kind: "leave" });
  });

  test("never fire while typing: the note takes letters, ⌘↵ sends only after C, other fields own every key", () => {
    expect(validationKey(press("a", { where: "note" }), open)).toBeNull();
    expect(validationKey(press("Enter", { meta: true, where: "note" }), open)).toBeNull();
    expect(validationKey(press("Enter", { where: "note" }), { ...open, changing: true })).toBeNull();
    expect(validationKey(press("a", { where: "field" }), open)).toBeNull();
    expect(validationKey(press("Escape", { where: "field" }), open)).toBeNull();
  });

  test("a digit picks one of the choices sent, and A and C do nothing there", () => {
    const choices = { ...open, choices: 3 };
    expect(validationKey(press("1"), choices)).toEqual({ kind: "choice", index: 0 });
    expect(validationKey(press("3"), choices)).toEqual({ kind: "choice", index: 2 });
    expect(validationKey(press("4"), choices)).toBeNull();
    expect(validationKey(press("0"), choices)).toBeNull();
    expect(validationKey(press("a"), choices)).toBeNull();
    expect(validationKey(press("c"), choices)).toBeNull();
    expect(validationKey(press("6"), { ...open, choices: 6 })).toEqual({ kind: "choice", index: 5 });
  });

  test("nothing with a modifier (⌘A selects, ⌘C copies), on a held key, or once decided or sent", () => {
    expect(validationKey(press("a", { meta: true }), open)).toBeNull();
    expect(validationKey(press("c", { ctrl: true }), open)).toBeNull();
    expect(validationKey(press("a", { alt: true }), open)).toBeNull();
    expect(validationKey(press("a", { repeat: true }), open)).toBeNull();
    expect(validationKey(press("a"), { ...open, open: false })).toBeNull();
    expect(validationKey(press("Escape", { where: "note" }), { ...open, open: false })).toBeNull();
  });
});

describe("after a decision", () => {
  const pending = [{ id: 4 }, { id: 7 }, { id: 9 }];

  test("the next waiting one opens, oldest first, wrapping to the first left", () => {
    expect(nextOpen(pending, 4, new Set())).toBe(7);
    expect(nextOpen(pending, 9, new Set())).toBe(4);
  });

  test("one already sent here is skipped, and nothing opens once all are decided", () => {
    expect(nextOpen(pending, 4, new Set([7]))).toBe(9);
    expect(nextOpen(pending, 9, new Set([4, 7]))).toBeNull();
    expect(nextOpen([{ id: 4 }], 4, new Set())).toBeNull();
  });
});

describe("about how long the waiting ones take", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 5, 9, minutes)).toISOString();
  const decided = (id: number, sent: number, after: number, outcome = "approved") =>
    ({
      id,
      ticket: `WID-${id}`,
      kind: "validation",
      createdAt: at(sent),
      decision: { outcome, by: "Ada", at: at(sent + after) },
    }) as OwnerValidation;

  test("is the owner's median time to decide, the rule of the Insights' owner wait", () => {
    const list = [decided(1, 0, 2), decided(2, 5, 4), decided(3, 10, 9), decided(4, 20, 30, "superseded")];
    const records = list.map((v) => ({
      ticket: v.ticket,
      kind: v.kind,
      createdAt: v.createdAt,
      decidedAt: v.decision?.at ?? null,
      outcome: v.decision?.outcome ?? null,
    }));
    const insights = buildInsights({
      records: [
        { project: "widgets", silentAfterMinutes: 15, events: [], sessions: [], waits: [], validations: records },
      ],
      range: "7d",
      now: new Date(Date.UTC(2026, 0, 5, 12)),
    });
    expect(decisionMedian(list)).toBe(4 * 60_000);
    expect(decisionMedian(list)).toBe(insights.waits.owner.p50);
  });

  test("is hidden below three decisions", () => {
    expect(decisionMedian([decided(1, 0, 2), decided(2, 5, 4), decided(3, 10, 9, "superseded")])).toBeNull();
  });
});
