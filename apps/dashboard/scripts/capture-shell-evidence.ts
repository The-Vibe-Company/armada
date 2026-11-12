/** Existing command palette, production Next build, disposable authenticated mock only. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { reset, signIn } from "../e2e/helpers";

const phase = process.env.EVIDENCE_PHASE;
if (phase !== "before" && phase !== "after") throw new Error("Invalid EVIDENCE_PHASE");
const output = "test-results/shell-evidence";
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"] as const) {
      await reset();
      const context = await browser.newContext({
        baseURL: "http://127.0.0.1:3100",
        viewport: { width, height: 844 },
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      try {
        await context.addInitScript((v) => localStorage.setItem("theme", v), theme);
        const page = await context.newPage();
        await signIn(page, "alice@example.com", "/settings");
        await expect(page.getByRole("heading", { name: "Settings", exact: true, level: 1 })).toBeVisible();
        await page.keyboard.press("ControlOrMeta+k");
        const search = page.getByRole("combobox", { name: "Search pages and actions" });
        await expect(search).toBeFocused();
        for (const [view, query] of [
          ["default", ""],
          ["filtered", "sandbox"],
          ["empty", "zz-no-command"],
        ]) {
          await search.fill(query);
          if (view === "empty") await expect(page.getByText(/Nothing matches/)).toBeVisible();
          else await expect(page.getByRole("option").first()).toBeVisible();
          await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /light/);
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: join(output, `${phase}-${view}-${width}-${theme}.png`),
            fullPage: false,
            animations: "disabled",
          });
        }
      } finally {
        await context.close();
      }
    }
} finally {
  await browser.close();
}
if (phase === "after") {
  const parts: string[] = [];
  for (const view of ["default", "filtered", "empty"])
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
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Command palette evidence</title><style>body{font:16px system-ui;margin:24px}.pair{display:flex;gap:16px}.pair a{width:50%}img{width:100%}</style><h1>Shared command palette before/after</h1><p>24 mock-only screenshots, exact source provenance in README.txt.</p>${parts.join("")}`,
  );
}
