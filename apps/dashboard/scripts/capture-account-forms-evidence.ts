/** Organization create and rejected sign-in, disposable mock only. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { reset, signIn } from "../e2e/helpers";

const phase = process.env.EVIDENCE_PHASE;
if (phase !== "before" && phase !== "after") throw new Error("Invalid EVIDENCE_PHASE");
const output = "test-results/account-forms-evidence";
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
        await signIn(page, "alice@example.com", "/orgs");
        if (phase === "after") {
          await page.getByRole("button", { name: "New org", exact: true }).click();
          await expect(page.getByRole("dialog", { name: "Create an org" })).toBeVisible();
        }
        const name = page.getByLabel("Name", { exact: true });
        await name.fill("Side Project");
        await name.scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: join(output, `${phase}-organization-create-${width}-${theme}.png`),
          fullPage: false,
          animations: "disabled",
        });
        await context.clearCookies();
        await page.goto("/login");
        await page.getByLabel("Email", { exact: true }).fill("alice@example.com");
        await page.getByRole("button", { name: "Email me a sign-in link" }).click();
        await page.getByLabel("Code", { exact: true }).fill("000000");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await expect(page.getByRole("alert")).toContainText("That code is wrong or has expired.");
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: join(output, `${phase}-login-error-${width}-${theme}.png`),
          fullPage: false,
          animations: "disabled",
        });
      } finally {
        await context.close();
      }
    }
} finally {
  await browser.close();
}
if (phase === "after") {
  const parts: string[] = [];
  for (const view of ["organization-create", "login-error"])
    for (const width of [1280, 390])
      for (const theme of ["light", "dark"]) {
        parts.push(`<h2>${view} ${width}px ${theme}</h2><div class="pair">`);
        for (const side of ["before", "after"]) {
          const f = `${side}-${view}-${width}-${theme}.png`;
          parts.push(`<a href="${f}">${side}<img src="${f}" alt="${side} ${view} ${width} ${theme}"></a>`);
        }
        parts.push("</div>");
      }
  await writeFile(
    join(output, "index.html"),
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Account forms evidence</title><style>body{font:16px system-ui;margin:24px}.pair{display:flex;gap:16px}.pair a{width:50%}img{width:100%}</style><h1>Account forms before/after</h1><p>16 mock-only viewport captures; exact source provenance in README.txt.</p>${parts.join("")}`,
  );
}
