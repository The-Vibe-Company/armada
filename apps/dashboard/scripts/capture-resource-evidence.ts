/** Screenshot evidence only: run against the production dashboard and its disposable e2e mock. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { reset, signIn } from "../e2e/helpers";

const phase = process.env.EVIDENCE_PHASE;
if (phase !== "before" && phase !== "after") throw new Error("EVIDENCE_PHASE must be before or after");
const output = process.env.EVIDENCE_DIR ?? "test-results/resource-evidence";
await mkdir(output, { recursive: true });
await reset();
const browser = await chromium.launch();
try {
  for (const width of [1280, 390]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        baseURL: "http://127.0.0.1:3100",
        viewport: { width, height: 844 },
        colorScheme: theme === "dark" ? "dark" : "light",
      });
      try {
        await context.addInitScript((value) => localStorage.setItem("theme", value), theme);
        const page = await context.newPage();
        await signIn(page, "alice@example.com", "/environments");
        for (const [route, label] of [
          ["environments", "Environments"],
          ["templates", "Templates"],
          ["tools", "Tools"],
          ["variables", "Variables and secrets"],
        ] as const) {
          await page.goto(`/${route}`);
          const list = page.getByRole("list", { name: label, exact: true });
          await expect(list).toBeVisible();
          await list.locator("[data-select-item]").first().click();
          await expect(page.locator("#resource-panel").filter({ visible: true })).toBeVisible();
          await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /light/);
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: join(output, `${phase}-${route}-${width}-${theme}.png`),
            fullPage: true,
            animations: "disabled",
          });
          await page.keyboard.press("Escape");
        }
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
await writeFile(join(output, `${phase}.txt`), `Captured 16 ${phase} views: four pages × two widths × two themes.\n`);

if (phase === "after") {
  const sections: string[] = [];
  for (const route of ["environments", "templates", "tools", "variables"]) {
    for (const width of [1280, 390]) {
      for (const theme of ["light", "dark"]) {
        sections.push(`<section><h2>${route}: ${width}px, ${theme}</h2><div class="pair">`);
        for (const side of ["before", "after"]) {
          const file = `${side}-${route}-${width}-${theme}.png`;
          sections.push(`<a href="${file}">${side}<img src="${file}" alt="${side} ${route} ${width} ${theme}"></a>`);
        }
        sections.push("</div></section>");
      }
    }
  }
  await writeFile(
    join(output, "index.html"),
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Resource layout evidence</title>
<style>body{font:16px system-ui;margin:24px}.pair{display:flex;gap:16px;align-items:start}.pair a{width:50%}img{width:100%;height:auto}section{margin-bottom:32px}</style>
<h1>Resource layout before/after</h1><p>32 mock-only captures. See README.txt for exact source provenance. Click any image for full size.</p>${sections.join("")}`,
  );
}
