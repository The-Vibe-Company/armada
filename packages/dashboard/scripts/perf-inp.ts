// The main interactions of the dashboard, measured in Chrome with a slower CPU
// (THE-892; `bun run perf inp <url>`, on the `large` demo world): Playwright
// drives the page, the Event Timing API gives each interaction's time from
// input to next paint, as INP counts it. Each one runs five times and the
// median counts: one run that meets a poll's re-render or a GC is noise.
import { type Browser, chromium, type Page } from "playwright-core";
import type { Interaction } from "./perf";

/** The agent of the `large` world with hundreds of activity entries. */
const LONG_AGENT = "WID-400";
/** A session the owner has to validate (a merge to approve), in every demo world. */
const TO_VALIDATE = "WID-18";
const RUNS = 5;
/** The pages it opens; an agent's tabs are in its "Details", which `?tab=` opens (THE-916). */
export const INP_PAGES = ["/", `/agents/${LONG_AGENT}?tab=activity`, `/agents/${TO_VALIDATE}`];

declare global {
  interface Window {
    __interactions?: { start: number; duration: number }[];
  }
}

async function open(browser: Browser, url: string, cookie: string, slowdown: number): Promise<Page> {
  const [name = "", value = ""] = cookie.split("=");
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name, value, domain: new URL(url).hostname, path: "/" }]);
  // Records the events that start an interaction, from the first paint on.
  // Not a keyup: one that changes nothing on screen has no frame of its own,
  // and headless Chrome reports it when something else draws next (the
  // clock's next second).
  await context.addInitScript(() => {
    const STARTS = ["keydown", "pointerdown", "pointerup", "click"];
    window.__interactions = [];
    new PerformanceObserver((list) => {
      // `interactionId` is newer than TypeScript's DOM types.
      for (const e of list.getEntries() as (PerformanceEventTiming & { interactionId?: number })[])
        if (e.interactionId && STARTS.includes(e.name))
          window.__interactions?.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: slowdown });
  await page.goto(url, { waitUntil: "load" });
  // Hydrated and settled: the shell's poll and the first prefetches are done.
  await page.waitForTimeout(3000);
  return page;
}

/** The longest event of the interactions `act` makes, once the page painted after them. */
async function measure(page: Page, act: () => Promise<void>): Promise<number> {
  const since = await page.evaluate(() => performance.now());
  await act();
  // Event Timing entries are dispatched after the next paint.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 300)))),
  );
  return page.evaluate(
    (t) => Math.max(0, ...(window.__interactions ?? []).filter((i) => i.start >= t).map((i) => i.duration)),
    since,
  );
}

async function typical(page: Page, act: () => Promise<void>, reset?: () => Promise<void>): Promise<number> {
  const runs: number[] = [];
  for (let k = 0; k < RUNS; k++) {
    runs.push(await measure(page, act));
    if (reset) await reset();
    await page.waitForTimeout(500);
  }
  return runs.sort((a, b) => a - b)[Math.floor(RUNS / 2)] as number;
}

export async function measureInteractions(base: string, cookie: string, slowdown: number): Promise<Interaction[]> {
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
    args: ["--no-sandbox"],
  });
  try {
    const out: Interaction[] = [];

    // The overview is the agents list, grouped by coordinator (THE-916).
    const agents = await open(browser, `${base}/`, cookie, slowdown);
    const rows = await agents.locator("a.sc-agent[data-row]").count();
    out.push({
      name: `Open the ⌘K palette (overview, ${rows} rows)`,
      ms: await typical(
        agents,
        async () => {
          await agents.keyboard.press("Control+k");
          await agents.getByRole("dialog").waitFor();
        },
        async () => {
          await agents.keyboard.press("Escape");
          await agents.getByRole("dialog").waitFor({ state: "detached" });
        },
      ),
    });
    out.push({
      name: "Filter the agents by harness",
      ms: await typical(
        agents,
        async () => {
          await agents.locator('a[role="tab"][href="/?harness=claude-code"]').click();
          await agents.waitForURL(/harness=claude-code/);
        },
        async () => {
          await agents.locator('a[role="tab"][href="/"]').click();
          await agents.waitForURL((url) => url.pathname === "/" && !url.search);
        },
      ),
    });
    await agents.context().close();

    const agent = await open(browser, `${base}/agents/${LONG_AGENT}?tab=activity`, cookie, slowdown);
    const entries = await agent.locator(".ui-columns-main .ui-row").count();
    const tab = (to: string) => agent.locator(`a[role="tab"][href="/agents/${LONG_AGENT}${to || "?tab=activity"}"]`);
    out.push({
      name: "Switch an agent's tab (to Files)",
      ms: await typical(
        agent,
        async () => {
          await tab("?tab=files").click();
          await agent.waitForURL(/tab=files/);
        },
        async () => {
          await tab("").click();
          await agent.waitForURL(/tab=activity/);
        },
      ),
    });
    out.push({
      name: `Switch an agent's tab (back to its ${entries}-row activity)`,
      ms: await typical(
        agent,
        async () => {
          await tab("").click();
          await agent.waitForURL(/tab=activity/);
        },
        async () => {
          await tab("?tab=files").click();
          await agent.waitForURL(/tab=files/);
        },
      ),
    });
    await agent.context().close();

    // Once: the answer is recorded, and the card then says it was sent.
    const session = await open(browser, `${base}/agents/${TO_VALIDATE}`, cookie, slowdown);
    out.push({
      name: "Approve a validation (session to validate)",
      ms: await measure(session, async () => {
        await session.locator('button[name="choice"], button[name="action"][value="approve"]').first().click();
      }),
    });
    await session.context().close();
    return out;
  } finally {
    await browser.close();
  }
}
