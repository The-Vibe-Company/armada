/** Mock-only before/after evidence for retiring Fleet and preserving its sandbox actions. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { BUSY, busyFleet } from "../e2e/busy-fleet";
import { MOCK, reset, signIn } from "../e2e/helpers";

const phase = process.env.EVIDENCE_PHASE;
if (phase !== "before" && phase !== "after") throw new Error("EVIDENCE_PHASE must be before or after");
const output = process.env.EVIDENCE_DIR ?? "test-results/fleet-evidence";
await mkdir(output, { recursive: true });
await reset();
const examples = new Set(Object.values(BUSY));
const seeded = await fetch(`${MOCK}/__test/add-sandboxes`, {
  method: "POST",
  body: JSON.stringify({ rows: busyFleet().filter((row) => examples.has(row.id)) }),
});
if (!seeded.ok) throw new Error("Could not seed evidence fixtures");
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
        await signIn(page, "alice@example.com");
        for (const [name, route] of [
          ["fleet", "/fleet?view=all"],
          ["sandboxes", "/sandboxes"],
          ["attention", `/sandboxes/${BUSY.unconcluded}`],
        ] as const) {
          await page.goto(route);
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          if (name === "fleet") await expect(page).toHaveURL(phase === "after" ? /\/sandboxes$/ : /\/fleet\?view=all$/);
          if (name === "attention") {
            // Capture settled conversation content, not whichever loading frame the browser reached first.
            await expect(page.getByRole("log", { name: "Messages" })).toContainText(
              "I moved the cache behind a feature flag.",
            );
            if (width < 1024) await page.getByRole("button", { name: "Details", exact: true }).click();
            if (phase === "after")
              await expect(page.locator("[data-sandbox-attention]").filter({ visible: true })).toBeVisible();
          }
          await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /light/);
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: join(output, `${phase}-${name}-${width}-${theme}.png`),
            fullPage: true,
            animations: "disabled",
          });
        }
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
if (phase === "after") {
  const sections: string[] = [];
  for (const name of ["fleet", "sandboxes", "attention"])
    for (const width of [1280, 390])
      for (const theme of ["light", "dark"]) {
        sections.push(`<h2>${name}: ${width}px, ${theme}</h2><div class="pair">`);
        for (const side of ["before", "after"]) {
          const file = `${side}-${name}-${width}-${theme}.png`;
          sections.push(`<a href="${file}">${side}<img src="${file}" alt="${side} ${name} ${width} ${theme}"></a>`);
        }
        sections.push("</div>");
      }
  await writeFile(
    join(output, "index.html"),
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Fleet retirement evidence</title><style>body{font:16px system-ui;margin:24px}.pair{display:flex;gap:16px;align-items:start}.pair a{width:50%}img{width:100%}</style><h1>Fleet retirement before/after</h1><p>24 mock captures. See README.txt for exact base/head provenance. Click any image for full size.</p>${sections.join("")}`,
  );
}
