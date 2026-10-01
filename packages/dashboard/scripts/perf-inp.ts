// The main interactions of the dashboard, measured in Chrome with a slower CPU
// (THE-892; `bun run perf inp <url>`, on the `large` demo world): Playwright
// drives the page, the Event Timing API gives each interaction's time from
// input to next paint, as INP counts it. Each one runs three times and the
// slowest counts.
import { type Browser, chromium, type Page } from "playwright-core";
import type { Interaction } from "./perf";

/** The agent of the `large` world with hundreds of activity entries. */
const LONG_AGENT = "WID-400";
const RUNS = 3;

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

async function worst(page: Page, act: () => Promise<void>, reset?: () => Promise<void>): Promise<number> {
  let ms = 0;
  for (let k = 0; k < RUNS; k++) {
    ms = Math.max(ms, await measure(page, act));
    if (reset) await reset();
    await page.waitForTimeout(500);
  }
  return ms;
}

export async function measureInteractions(base: string, cookie: string, slowdown: number): Promise<Interaction[]> {
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
    args: ["--no-sandbox"],
  });
  try {
    const out: Interaction[] = [];

    const agents = await open(browser, `${base}/agents`, cookie, slowdown);
    const rows = await agents.locator("a[data-row]").count();
    out.push({
      name: `Open the ⌘K palette (/agents, ${rows} rows)`,
      ms: await worst(
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
      ms: await worst(
        agents,
        async () => {
          await agents.locator('a[role="tab"][href="/agents?harness=claude-code"]').click();
          await agents.waitForURL(/harness=claude-code/);
        },
        async () => {
          await agents.locator('a[role="tab"][href="/agents"]').click();
          await agents.waitForURL(/\/agents$/);
        },
      ),
    });
    await agents.context().close();

    const agent = await open(browser, `${base}/agents/${LONG_AGENT}`, cookie, slowdown);
    const entries = await agent.locator(".ui-columns-main .ui-row").count();
    const tab = (to: string) => agent.locator(`a[role="tab"][href="/agents/${LONG_AGENT}${to}"]`);
    out.push({
      name: "Switch an agent's tab (to Files)",
      ms: await worst(
        agent,
        async () => {
          await tab("?tab=files").click();
          await agent.waitForURL(/tab=files/);
        },
        async () => {
          await tab("").click();
          await agent.waitForURL(new RegExp(`/agents/${LONG_AGENT}$`));
        },
      ),
    });
    out.push({
      name: `Switch an agent's tab (back to its ${entries}-row activity)`,
      ms: await worst(
        agent,
        async () => {
          await tab("").click();
          await agent.waitForURL(new RegExp(`/agents/${LONG_AGENT}$`));
        },
        async () => {
          await tab("?tab=files").click();
          await agent.waitForURL(/tab=files/);
        },
      ),
    });
    await agent.context().close();

    // Once: the answer is recorded, and the card then says it was sent.
    const overview = await open(browser, `${base}/`, cookie, slowdown);
    out.push({
      name: "Answer a decision (overview)",
      ms: await measure(overview, async () => {
        await overview.locator('button[name="choice"], button[name="action"][value="approve"]').first().click();
      }),
    });
    await overview.context().close();
    return out;
  } finally {
    await browser.close();
  }
}
