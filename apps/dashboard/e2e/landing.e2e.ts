import { type Browser, expect, test } from "@playwright/test";
import { TRANSCRIPT } from "../src/components/landing/transcript";
import { reset, signIn } from "./helpers";

/** `/` answers by cookie (the landing or the dashboard), so no shared cache may keep either answer. */
const UNCACHED = /^private, no-cache, no-store/;

// The public landing restored from armada-v1-final (#564): a signed-out visitor sees it on `/`, a member does not.

test.beforeEach(reset);

test("a signed-out visitor sees the landing on / and signs in from it", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.headers()["cache-control"]).toMatch(UNCACHED);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(
    "Run a fleet of coding agents. See every move.",
  );
  await expect(page.locator("#fleet .lp-replica")).toBeAttached();
  await page.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByText("Sign in to Armada")).toBeVisible();
});

test("the landing and the login page link the Armada icons, served to a signed-out visitor", async ({ page }) => {
  for (const path of ["/", "/login"]) {
    await page.goto(path);
    const links = page.locator('head link[rel="icon"], head link[rel="apple-touch-icon"]');
    const hrefs = await links.evaluateAll((all) => all.map((link) => (link as HTMLLinkElement).href));
    expect(hrefs.map((href) => new URL(href).pathname).sort()).toEqual([
      "/apple-icon.png",
      "/favicon.ico",
      "/icon.svg",
    ]);
    for (const href of hrefs) {
      // No session cookie: an icon is served as is, never sent to the login page.
      const icon = await page.request.get(href, { maxRedirects: 0 });
      expect(icon.status()).toBe(200);
      expect(icon.headers()["content-type"]).toMatch(/^image\//);
    }
  }
});

test("a signed-in member's / is the dashboard, not the landing", async ({ page }) => {
  await signIn(page, "alice@example.com", "/sandboxes");
  const front = await page.request.get("/", { maxRedirects: 0 });
  expect(front.status()).toBe(307);
  expect(front.headers().location).toMatch(/\/sandboxes$/);
  expect(front.headers()["cache-control"]).toMatch(UNCACHED);
  await page.goto("/");
  await expect(page).toHaveURL(/\/sandboxes$/);
  await expect(page.locator(".lp")).toHaveCount(0);
});

test("the method's steps follow the arrow keys, Home and End", async ({ page }) => {
  await page.goto("/landing");
  const tabs = page.getByRole("tablist", { name: "The method, step by step" }).getByRole("tab");
  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(tabs.nth(4)).toHaveAttribute("aria-selected", "true");
});

/** What moves on the landing over its clock: the sky's canvas, the v1 replay's beat, the terminal's replay. */
async function tenSeconds(browser: Browser, reducedMotion: "reduce" | "no-preference") {
  const context = await browser.newContext({ reducedMotion });
  const page = await context.newPage();
  await page.clock.install();
  await page.goto("/landing");
  const sky = page.locator(".lp-sky");
  // Sized and drawn once hydrated (a canvas starts at 300 × 150).
  await expect.poll(() => sky.evaluate((c: HTMLCanvasElement) => c.width)).not.toBe(300);
  const before = await sky.evaluate((c: HTMLCanvasElement) => c.toDataURL());
  await page.clock.runFor(1_000);
  const skyMoved = (await sky.evaluate((c: HTMLCanvasElement) => c.toDataURL())) !== before;
  await page.locator("#fleet .lp-fleet-stage").scrollIntoViewIfNeeded();
  await expect(page.locator(".lp-replica[data-stage]")).toBeAttached();
  await page.clock.runFor(10_000);
  const stage = await page.locator(".lp-replica").getAttribute("data-stage");
  await page.locator("#cli").scrollIntoViewIfNeeded();
  // The terminal starts its replay (one command, being typed) once it is seen: the same bounded probe both ways.
  let terminalReplayed = false;
  for (let k = 0; k < 20 && !terminalReplayed; k++) {
    await page.clock.runFor(250);
    terminalReplayed = (await page.locator(".lp-terminal-command").count()) < TRANSCRIPT.length;
  }
  await context.close();
  return { skyMoved, stage, terminalReplayed };
}

test("with reduced motion the landing holds still; with motion the same probe sees it move", async ({ browser }) => {
  expect(await tenSeconds(browser, "reduce")).toEqual({ skyMoved: false, stage: "opening", terminalReplayed: false });
  const moving = await tenSeconds(browser, "no-preference");
  expect(moving).toEqual({ skyMoved: true, stage: expect.not.stringMatching(/^opening$/), terminalReplayed: true });
});
