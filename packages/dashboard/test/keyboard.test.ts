import { describe, expect, test } from "bun:test";
import { ownsKeys, tabStep } from "../lib/keyboard.ts";

// Field cases need only the tag and editability; dialog cases live in keyboard.browser.ts.
const el = (tagName: string, { editable = false } = {}) => ({
  tagName,
  isContentEditable: editable,
  closest: () => null,
});

describe("the shell's keys (j, k, Enter, Esc)", () => {
  test("never leave a text field, a choice or an editable block", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) expect(ownsKeys(el(tag))).toBe(true);
    expect(ownsKeys(el("DIV", { editable: true }))).toBe(true);
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
    for (const [key, at, expected] of [
      ["ArrowRight", 0, 1],
      ["ArrowDown", 3, 4],
      ["ArrowRight", 4, 0],
      ["ArrowDown", 4, 0],
      ["ArrowLeft", 0, 4],
      ["ArrowUp", 2, 1],
      ["ArrowUp", 0, 4],
    ] as const)
      expect(tabStep(key, at, 5)).toBe(expected);
  });

  test("Home and End go to the ends; any other key is the page's", () => {
    expect(tabStep("Home", 2, 3)).toBe(0);
    expect(tabStep("End", 0, 3)).toBe(2);
    expect(tabStep("j", 0, 3)).toBeNull();
    expect(tabStep("Home", 3, 5)).toBe(0);
    expect(tabStep("End", 1, 5)).toBe(4);
    expect(tabStep("Enter", 2, 5)).toBeNull();
    expect(tabStep("ArrowRight", 0, 0)).toBeNull();
  });
});
