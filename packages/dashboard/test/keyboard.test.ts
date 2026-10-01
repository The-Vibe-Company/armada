import { describe, expect, test } from "bun:test";
import { ownsKeys, tabStep } from "../lib/keyboard.ts";

// Stand-ins for the elements a key is typed in: a tag, and whether it sits in an open dialog.
const el = (tagName: string, { editable = false, inDialog = false } = {}) => ({
  tagName,
  isContentEditable: editable,
  closest: (selector: string) => (inDialog && selector.includes("dialog") ? {} : null),
});

describe("the shell's keys (j, k, Enter, Esc)", () => {
  test("never leave a text field, a choice or an editable block", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) expect(ownsKeys(el(tag))).toBe(true);
    expect(ownsKeys(el("DIV", { editable: true }))).toBe(true);
  });

  test("never reach the page behind an open dialog (⌘K, a screenshot)", () => {
    expect(ownsKeys(el("BUTTON", { inDialog: true }))).toBe(true);
  });

  test("belong to the page anywhere else", () => {
    expect(ownsKeys(el("A"))).toBe(false);
    expect(ownsKeys(el("MAIN"))).toBe(false);
    expect(ownsKeys(null)).toBe(false);
  });
});

describe("a row of tabs", () => {
  test("the arrows move to the next and the previous, wrapping", () => {
    expect(tabStep("ArrowRight", 0, 3)).toBe(1);
    expect(tabStep("ArrowRight", 2, 3)).toBe(0);
    expect(tabStep("ArrowLeft", 0, 3)).toBe(2);
  });

  test("Home and End go to the ends; any other key is the page's", () => {
    expect(tabStep("Home", 2, 3)).toBe(0);
    expect(tabStep("End", 0, 3)).toBe(2);
    expect(tabStep("j", 0, 3)).toBeNull();
    expect(tabStep("ArrowRight", 0, 0)).toBeNull();
  });
});
