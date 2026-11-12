/** Six Build pages, real production Next build against the disposable e2e mock only. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { reset, signIn } from "../e2e/helpers";

const phase = process.env.EVIDENCE_PHASE;
if (phase !== "before" && phase !== "after") throw new Error("EVIDENCE_PHASE must be before or after");
const unconfigured = process.env.EVIDENCE_SCENARIO === "unconfigured";
const output = process.env.EVIDENCE_DIR ?? "test-results/build-evidence";
await mkdir(output, { recursive: true });
await reset();
const browser = await chromium.launch();
try {
  for (const width of [1280, 390])
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        baseURL: "http://127.0.0.1:3100",
        viewport: { width, height: 844 },
        colorScheme: theme === "dark" ? "dark" : "light",
      });
      try {
        await context.addInitScript((value) => localStorage.setItem("theme", value), theme);
        const page = await context.newPage();
        await signIn(page, "alice@example.com", unconfigured ? "/harness" : "/sandboxes");
        if (unconfigured) {
          // Candidate evidence requires status semantics; baseline evidence supports either revision.
          const currentNotice = page.getByRole("status").filter({ hasText: "The Armada server is not configured" });
          const notice =
            phase === "before"
              ? currentNotice.or(page.getByRole("alert").filter({ hasText: "The Armada server is not configured" }))
              : currentNotice;
          await expect(notice).toBeVisible();
          await expect(notice).toHaveText("The Armada server is not configured: subscriptions cannot be managed here.");
          await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /light/);
          await page.screenshot({
            path: join(output, `${phase}-harness-unconfigured-${width}-${theme}.png`),
            fullPage: true,
            animations: "disabled",
          });
          continue;
        }
        for (const [route, title, trigger] of [
          ["environments", "Environments", "New"],
          ["templates", "Templates", "New"],
          ["tools", "Tools", "Add server"],
          ["variables", "Variables", "Add"],
          ["skills", "Skills", "Add key"],
          ["harness", "Harness", "Add a subscription"],
        ] as const) {
          await page.goto(`/${route}`);
          await expect(page.getByRole("heading", { name: title, level: 1, exact: true })).toBeVisible();
          const hasDetail = route !== "skills" && route !== "harness";
          if (hasDetail) {
            // The header can stream before its rows. Never substitute a loading frame for detail evidence.
            const list = page.getByRole("list", {
              name: route === "variables" ? "Variables and secrets" : title,
              exact: true,
            });
            await expect(list).toBeVisible();
            const selector = list.locator("[data-select-item]").first();
            await expect(selector).toBeVisible();
            await selector.click();
            await expect(page.locator("aside[aria-labelledby]").filter({ visible: true })).toBeVisible();
          } else if (route === "skills") {
            await expect(page.getByRole("list", { name: "Skillpack keys", exact: true })).toBeVisible();
          } else {
            await expect(page.locator("[data-account]").filter({ visible: true }).first()).toBeVisible();
          }
          await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /light/);
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: join(output, `${phase}-${route}-detail-${width}-${theme}.png`),
            fullPage: true,
            animations: "disabled",
          });
          if (hasDetail) await page.keyboard.press("Escape");
          await page.getByRole("button", { name: trigger, exact: true }).click();
          await expect(page.getByRole("dialog")).toBeVisible();
          if (route === "environments" && (await page.getByText("Show the create form", { exact: true }).isVisible())) {
            await page.getByText("Show the create form", { exact: true }).click();
          }
          await page.screenshot({
            path: join(output, `${phase}-${route}-form-${width}-${theme}.png`),
            fullPage: true,
            animations: "disabled",
          });
          await page.keyboard.press("Escape");
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
  for (const route of ["environments", "templates", "tools", "variables", "skills", "harness"])
    for (const view of route === "harness" ? ["detail", "form", "unconfigured"] : ["detail", "form"])
      for (const width of [1280, 390])
        for (const theme of ["light", "dark"]) {
          parts.push(`<h2>${route} ${view}: ${width}px, ${theme}</h2><div class="pair">`);
          for (const side of ["before", "after"]) {
            const file = `${side}-${route}-${view}-${width}-${theme}.png`;
            parts.push(
              `<a href="${file}">${side}<img src="${file}" alt="${side} ${route} ${view} ${width} ${theme}"></a>`,
            );
          }
          parts.push("</div>");
        }
  await writeFile(
    join(output, "index.html"),
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Build quality evidence</title><style>body{font:16px system-ui;margin:24px}.pair{display:flex;gap:16px;align-items:start}.pair a{width:50%}img{width:100%}</style><h1>Build quality before/after</h1><p>104 mock-only captures; source provenance in README.txt. Click for full size.</p>${parts.join("")}`,
  );
}
