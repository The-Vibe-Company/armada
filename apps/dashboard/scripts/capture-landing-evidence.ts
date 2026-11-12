/** Public copy feedback, real clipboard after a denied attempt, no real providers. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const phase = process.env.EVIDENCE_PHASE;
if (phase !== "before" && phase !== "after") throw new Error("Invalid EVIDENCE_PHASE");
const output = "test-results/landing-evidence";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        baseURL: "http://127.0.0.1:3100",
        viewport: { width, height: 844 },
        colorScheme: theme,
        reducedMotion: "reduce",
        permissions: ["clipboard-read", "clipboard-write"],
      });
      try {
        await context.addInitScript((value) => {
          localStorage.setItem("theme", value);
          let fail = true;
          const write = navigator.clipboard.writeText.bind(navigator.clipboard);
          Object.defineProperty(navigator.clipboard, "writeText", {
            configurable: true,
            value: async (text: string) => {
              if (fail) {
                fail = false;
                throw new DOMException("Clipboard denied", "NotAllowedError");
              }
              await write(text);
            },
          });
        }, theme);
        const page = await context.newPage();
        await page.goto("/landing");
        const copy = page.locator(".lp-copy").first();
        await expect(copy).toBeVisible();
        const capture = async (view: string) => {
          await copy.scrollIntoViewIfNeeded();
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: join(output, `${phase}-${view}-${width}-${theme}.png`),
            fullPage: false,
            animations: "disabled",
          });
        };
        await capture("ready");
        await copy.click();
        if (phase === "after")
          await expect(copy.getByRole("status")).toHaveText(
            "Could not copy. Select the command to copy it manually, or try again.",
          );
        await expect(copy).toHaveAttribute("aria-label", /^Copy:/);
        await capture("rejected");
        await copy.click();
        await expect(copy).toHaveAttribute("aria-label", /^Copied:/);
        await capture("copied");
      } finally {
        await context.close();
      }
    }
} finally {
  await browser.close();
}
if (phase === "after") {
  const parts: string[] = [];
  for (const view of ["ready", "rejected", "copied"])
    for (const width of [1280, 390])
      for (const theme of ["light", "dark"]) {
        parts.push(`<h2>${view} ${width}px ${theme}</h2><div class="pair">`);
        for (const side of ["before", "after"]) {
          const file = `${side}-${view}-${width}-${theme}.png`;
          parts.push(`<a href="${file}">${side}<img src="${file}" alt="${side} ${view} ${width} ${theme}"></a>`);
        }
        parts.push("</div>");
      }
  await writeFile(
    join(output, "index.html"),
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Landing copy evidence</title><style>body{font:16px system-ui;margin:24px}.pair{display:flex;gap:16px}.pair a{width:50%}img{width:100%}</style><h1>Public landing before/after</h1><p>24 viewport screenshots. The marketing page intentionally remains dark in either theme. Before rejection has no feedback; after explains manual copy/retry. Exact source provenance in README.txt.</p>${parts.join("")}`,
  );
}
