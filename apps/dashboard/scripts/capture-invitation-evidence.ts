/** Real invite validation/reset UI, disposable mock only; no email is sent outside it. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { reset, signIn } from "../e2e/helpers";

const phase = process.env.EVIDENCE_PHASE;
if (phase !== "before" && phase !== "after") throw new Error("Invalid EVIDENCE_PHASE");
const output = "test-results/invitation-evidence";
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
        await signIn(page, "alice@example.com", "/orgs/00000000-0000-4000-8000-000000000010");
        const email = page.getByLabel("Email", { exact: true });
        const role = page.getByLabel("Role", { exact: true });
        await email.fill("carol@corp");
        await role.selectOption("admin");
        await page.getByRole("button", { name: "Send invitation", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: "Enter one full email address" })).toBeVisible();
        await expect(email).toHaveValue(phase === "after" ? "carol@corp" : "");
        await expect(role).toHaveValue(phase === "after" ? "admin" : "member");
        await email.scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: join(output, `${phase}-refused-${width}-${theme}.png`),
          fullPage: false,
          animations: "disabled",
        });
        await email.fill("carol@example.com");
        await page.getByRole("button", { name: "Send invitation", exact: true }).click();
        const invitation = page.locator('[data-invitation="carol@example.com"]');
        await expect(invitation).toBeVisible();
        await expect(invitation).toContainText(phase === "after" ? "admin" : "member");
        await expect(email).toHaveValue("");
        await expect(role).toHaveValue("member");
        await invitation.scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: join(output, `${phase}-corrected-${width}-${theme}.png`),
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
  for (const view of ["refused", "corrected"])
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
    `<!doctype html><meta name="viewport" content="width=device-width"><title>Invitation draft evidence</title><style>body{font:16px system-ui;margin:24px}.pair{display:flex;gap:16px}.pair a{width:50%}img{width:100%}</style><h1>Invitation drafts before/after</h1><p>16 mock-only viewport captures. Before refusal loses email and admin choice, so email-only correction sends member. After refusal retains the intended draft and correction sends admin. Successful forms still reset. Exact source provenance in README.txt.</p>${parts.join("")}`,
  );
}
