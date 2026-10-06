import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type Browser, chromium, type Page } from "playwright-core";
import * as ts from "typescript";
import { ownsKeys, tabStep } from "../lib/keyboard.ts";

// Field cases need only the tag and editability; dialog cases use a real DOM below.
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

  describe("an open dialog", () => {
    let browser: Browser | undefined;
    let page: Page;
    // The headless shell is installed before the suite; setup is not a behavior deadline.
    beforeAll(async () => {
      browser = await chromium.launch({ timeout: 15_000 });
    }, 20_000);
    beforeAll(async () => {
      if (!browser) throw new Error("browser setup did not complete");
      page = await browser.newPage();
    }, 10_000);
    afterAll(async () => {
      await browser?.close();
    }, 10_000);

    test("never reach the page behind an open dialog (⌘K, a screenshot)", async () => {
      const module = Buffer.from(
        ts.transpileModule(readFileSync(new URL("../lib/keyboard.ts", import.meta.url), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      ).toString("base64");
      const result = await page.evaluate(async (module) => {
        // Run the real owner against the browser's selector engine, rather than a selector-insensitive mock.
        const { ownsKeys: owns } = await import(`data:text/javascript;base64,${module}`);
        document.body.innerHTML = `<dialog><button id="closed"></button></dialog>
          <dialog open><button id="open"></button></dialog>
          <div role="dialog"><button id="aria"></button></div>
          <div contenteditable="true"><button id="editable"></button></div>
          <button id="outside"></button>`;
        return ["closed", "open", "aria", "editable", "outside"].map((id) => owns(document.getElementById(id)));
      }, module);
      expect(result).toEqual([false, true, true, true, false]);
    });
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
