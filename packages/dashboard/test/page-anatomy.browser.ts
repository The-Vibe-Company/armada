import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import { type Browser, chromium, type Page } from "playwright-core";

// Playwright owns Chrome's debugging pipes in Node, outside the Bun/PGlite process (THE-1185).
describe("globals.css", () => {
  // THE-982: the browser may paint a page before its HTML has all arrived. A
  // bar sized by its content then grows as its buttons arrive, and the phone's
  // tab bar, pinned to the bottom, jumped up by up to 47 px (CLS 0.001 to 0.004
  // on the overview). On a phone each bar's height is its own.
  describe("phone geometry", () => {
    let browser: Browser | undefined;
    let page: Page;
    // Browser setup and cleanup have their own bounds; assertions keep their 5 s deadline.
    before(
      async () => {
        browser = await chromium.launch({ channel: "chrome", timeout: 15_000 });
      },
      { timeout: 20_000 },
    );
    before(
      async () => {
        if (!browser) throw new Error("browser setup did not complete");
        page = await browser.newPage({ viewport: { width: 375, height: 812 } });
      },
      { timeout: 10_000 },
    );
    after(
      async () => {
        await browser?.close();
      },
      { timeout: 10_000 },
    );

    test("gives the phone's bars a height of their own", { timeout: 5_000 }, async () => {
      const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
      await page.setContent(
        `<style>${css}</style><div class="sh-side"><div class="sh-brand">Brand</div></div><nav class="sh-tabbar">Tabs</nav>`,
      );
      const heights = () =>
        page.evaluate(() =>
          [".sh-side", ".sh-brand", ".sh-tabbar"].map((selector) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error("missing bar fixture");
            return element.getBoundingClientRect().height;
          }),
        );
      const before = await heights();
      assert.deepEqual(before, [52, 32, 60]);
      await page.evaluate(() => {
        for (const selector of [".sh-brand", ".sh-tabbar"]) {
          const child = document.createElement("span");
          child.style.height = "150px";
          child.style.display = "block";
          document.querySelector(selector)?.appendChild(child);
        }
      });
      assert.deepEqual(await heights(), before);
    });
  });
});
