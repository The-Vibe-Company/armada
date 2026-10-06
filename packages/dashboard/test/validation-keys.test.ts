import { describe, expect, test } from "bun:test";
import type { OwnerValidation } from "@armada/core/read";
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
  let id = 0;
  const decided = (sent: number, minute: number, by: string | null = "Ada", outcome = "approved") =>
    ({
      id: ++id,
      ticket: `WID-${id}`,
      kind: "validation",
      createdAt: at(sent),
      decision: { outcome, by, at: at(minute) },
    }) as OwnerValidation;

  test("is the owner's median time per decision in a sitting: the gaps between one person's decisions", () => {
    // Ada decides four in a row (gaps of 1, 2 and 4 min), Grace one after two minutes of Ada's: not hers.
    const sitting = [decided(0, 10), decided(0, 11), decided(0, 13), decided(0, 17), decided(0, 12, "Grace")];
    expect(decisionMedian(sitting)).toBe(2 * 60_000);
  });

  test("leaves out a gap past ten minutes, one sent after the decision before, and a replaced one", () => {
    const list = [
      decided(0, 10),
      decided(0, 12),
      decided(0, 14),
      decided(0, 40), // the next sitting
      decided(41, 43), // sent after the one before was decided: its gap is its wait
      decided(0, 45, "Ada", "superseded"),
    ];
    expect(decisionMedian(list)).toBeNull();
    expect(decisionMedian([...list, decided(0, 15)])).toBe(2 * 60_000);
  });
});
