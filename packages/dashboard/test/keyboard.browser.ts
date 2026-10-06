import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright-core";
import * as ts from "typescript";

// Playwright owns Chrome's debugging pipes in Node, outside the Bun/PGlite process (THE-1185).
describe("the shell's keys (j, k, Enter, Esc)", () => {
  let browser: Browser | undefined;
  let page: Page;
  before(
    async () => {
      browser = await chromium.launch({ channel: "chrome", timeout: 15_000 });
    },
    { timeout: 20_000 },
  );
  before(
    async () => {
      if (!browser) throw new Error("browser setup did not complete");
      page = await browser.newPage();
    },
    { timeout: 10_000 },
  );
  after(
    async () => {
      await browser?.close();
    },
    { timeout: 10_000 },
  );

  test("never reach the page behind an open dialog (⌘K, a screenshot)", { timeout: 5_000 }, async () => {
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
    assert.deepEqual(result, [false, true, true, true, false]);
  });
});
