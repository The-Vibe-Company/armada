/** Mock-only Settings confirmation evidence; baseline captures the unprotected entry point. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { reset, signIn } from "../e2e/helpers";

const phase = process.env.EVIDENCE_PHASE;
if (phase !== "before" && phase !== "after") throw new Error("Invalid EVIDENCE_PHASE");
const output = "test-results/account-evidence";
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
        await context.addInitScript((value) => localStorage.setItem("theme", value), theme);
        const page = await context.newPage();
        await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, body: "Mock GitHub" }));
        await signIn(page, "alice@example.com", "/settings");
        const mine = page.locator('[data-credentials="user"]');
        await mine.getByLabel("Kind").selectOption("boat");
        await mine.getByLabel("Value", { exact: true }).fill("evidence-only-synthetic-key");
        await mine.getByRole("button", { name: "Save key" }).click();
        const remove = mine.getByRole("button", { name: "Remove boat.dev API key" });
        await expect(remove).toBeVisible();
        await page.reload();
        await remove.scrollIntoViewIfNeeded();
        if (phase === "after") {
          await remove.click();
          await expect(page.getByRole("alertdialog")).toBeVisible();
        }
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: join(output, `${phase}-remove-key-${width}-${theme}.png`),
          fullPage: true,
          animations: "disabled",
        });
        if (phase === "after")
          await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
        const github = page.locator('[data-settings="github"]');
        const [request] = await Promise.all([
          page.waitForRequest((r) => r.url().startsWith("https://github.com/login/oauth/authorize")),
          github.getByRole("link", { name: "Connect GitHub", exact: true }).click(),
        ]);
        const state = new URL(request.url()).searchParams.get("state");
        await page.goto(`/github/callback?code=good-code&state=${state}`);
        await page.waitForURL("**/settings?github=connected");
        const disconnect = github.getByRole("button", { name: "Disconnect", exact: true });
        await expect(disconnect).toBeVisible();
        await disconnect.scrollIntoViewIfNeeded();
        if (phase === "after") {
          await disconnect.click();
          await expect(page.getByRole("alertdialog")).toBeVisible();
        }
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: join(output, `${phase}-disconnect-github-${width}-${theme}.png`),
          fullPage: true,
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
  for (const view of ["remove-key", "disconnect-github"])
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
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Account confirmations</title><style>body{font:16px system-ui;margin:24px}.pair{display:flex;gap:16px}.pair a{width:50%}img{width:100%}</style><h1>Settings before/after</h1><p>Before: immediate destructive entry point. After: confirmation before any mutation. Mock data only; exact source provenance in README.txt.</p>${parts.join("")}`,
  );
}
