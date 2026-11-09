import { type Browser, expect, test } from "@playwright/test";
import { TRANSCRIPT } from "../src/components/landing/transcript";
import { reset, signIn } from "./helpers";

/** `/` answers by cookie (the landing or the dashboard), so no shared cache may keep either answer. */
const UNCACHED = /^private, no-cache, no-store/;

// The public landing restored from armada-v1-final (#564), its story retold by #587: a signed-out visitor sees
// it on `/`, a member does not.

test.beforeEach(reset);

test("a signed-out visitor sees the landing on / and signs in from it", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.headers()["cache-control"]).toMatch(UNCACHED);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveAccessibleName(
    "Run a fleet of coding agents. See every move.",
  );
  // Every in-page link (the nav's, the hero's, the skip link) lands on a section of the page.
  const targets = await page
    .locator('a[href^="#"]')
    .evaluateAll((links) =>
      links.map((a) => a.getAttribute("href") ?? "").filter((href) => !document.getElementById(href.slice(1))),
    );
  expect(targets).toEqual([]);
  await page.locator("#install").getByRole("link", { name: "Sign in to try Armada" }).click();
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

test("on a phone, the story's index reaches every section the navigation hides", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto("/landing");
  const index = page.getByRole("navigation", { name: "The story" });
  for (const [name, id] of [
    ["Method", "method"],
    ["Fleet", "fleet"],
    ["CLI", "cli"],
    ["Keys", "keys"],
    ["Install", "install"],
  ] as const) {
    // The top navigation keeps only Sign in and Install on a phone (AEOM run-20261109-1256's journeys broke there).
    const link = index.getByRole("link", { name, exact: true });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.locator(`#${id}`)).toBeInViewport();
  }
  await context.close();
});

test("every story command reads exactly as it is copied, words apart, at desktop and phone widths", async ({
  browser,
}) => {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto("/landing");
    const buttons = page.locator("main .lp-ch .lp-copy");
    expect(await buttons.count()).toBeGreaterThan(5);
    for (const button of await buttons.all()) {
      const copied = (await button.getAttribute("aria-label"))?.replace(/^Copy: /, "");
      // What a person reads: the rendered text, its line breaks taken as the spaces they replaced.
      const shown = (await button.locator(".lp-copy-command").innerText()).replace(/^\$\s*/, "").replace(/\s+/g, " ");
      expect(shown, `at ${width}px`).toBe(copied);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await context.close();
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

/** What moves on the landing over its clock: the sky's canvas and the terminal's replay. */
async function moves(browser: Browser, reducedMotion: "reduce" | "no-preference") {
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
  await page.locator("#install .lp-terminal").scrollIntoViewIfNeeded();
  // The terminal starts its replay (one command, being typed) once it is seen: the same bounded probe both ways.
  let terminalReplayed = false;
  for (let k = 0; k < 20 && !terminalReplayed; k++) {
    await page.clock.runFor(250);
    terminalReplayed = (await page.locator(".lp-terminal-command").count()) < TRANSCRIPT.length;
  }
  await context.close();
  return { skyMoved, terminalReplayed };
}

test("with reduced motion the landing holds still; with motion the same probe sees it move", async ({ browser }) => {
  expect(await moves(browser, "reduce")).toEqual({ skyMoved: false, terminalReplayed: false });
  expect(await moves(browser, "no-preference")).toEqual({ skyMoved: true, terminalReplayed: true });
});
