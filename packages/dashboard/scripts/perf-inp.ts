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
/** How many sessions to validate the decision is measured on: each records its decision, so each runs once. */
const DECISIONS = 3;
/** The pages it opens; an agent's page opens on its summary, its files are `?tab=files` (THE-1021). */
export const INP_PAGES = [
  "/",
  "/?view=preview",
  `/agents/${LONG_AGENT}`,
  `/agents/${TO_VALIDATE}`,
  "/agents/GAD-9",
  "/validations",
];

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

/** The sessions in flight the owner has a validation open on, the demo's merge first. */
async function toValidate(base: string, cookie: string): Promise<string[]> {
  const res = await fetch(`${base}/api/fleet`, { headers: { cookie } });
  if (!res.ok) return [TO_VALIDATE];
  const fleet = (await res.json()) as {
    rows: { id: string }[];
    validations?: { ticket: string; kind: string; decision: unknown }[];
  };
  // A merge or an escalated question is decided on the session's page; work to check opens its validation (THE-1021).
  const open = (fleet.validations ?? [])
    .filter((v) => !v.decision && v.kind !== "validation" && fleet.rows.some((r) => r.id === v.ticket))
    .map((v) => v.ticket);
  const tickets = [...new Set([TO_VALIDATE, ...open].filter((t) => open.includes(t)))];
  return tickets.length ? tickets.slice(0, DECISIONS) : [TO_VALIDATE];
}

/** The oldest validation still open that Approve and Request changes decide (no choices), after the sessions' decisions. */
async function toDecideByKey(base: string, cookie: string): Promise<number | null> {
  const res = await fetch(`${base}/api/fleet`, { headers: { cookie } });
  if (!res.ok) return null;
  const fleet = (await res.json()) as {
    validations?: { id: number; createdAt: string; choices: string[] | null; decision: unknown }[];
  };
  const open = (fleet.validations ?? [])
    .filter((v) => !v.decision && !v.choices)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return open[0]?.id ?? null;
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

    // The overview is one list of every session, grouped by state (THE-1020).
    const agents = await open(browser, `${base}/`, cookie, slowdown);
    const rows = await agents.locator("a.ov-row[data-row]").count();
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
      name: "Filter the overview by project",
      ms: await typical(
        agents,
        async () => {
          await agents.locator('a.ov-chip[href="/?coordinator=gadgets"]').click();
          await agents.waitForURL(/coordinator=gadgets/);
        },
        async () => {
          await agents.locator('a.ov-chip[href="/"]').click();
          await agents.waitForURL((url) => url.pathname === "/" && !url.search);
        },
      ),
    });
    await agents.context().close();

    // List + preview: a click on a row shows its session in the pane.
    const split = await open(browser, `${base}/?view=preview`, cookie, slowdown);
    const pick = (n: number) => split.locator("a.ov-row[data-row]").nth(n);
    out.push({
      name: "Select a session in the preview pane",
      ms: await typical(
        split,
        async () => {
          await pick(1).click();
          await split.locator('a.ov-row[aria-current="true"]').nth(0).waitFor();
        },
        async () => {
          await pick(0).click();
        },
      ),
    });
    await split.context().close();

    const agent = await open(browser, `${base}/agents/${LONG_AGENT}`, cookie, slowdown);
    const entries = await agent.locator(".ag-history > li").count();
    const tab = (to: string) => agent.locator(`a[role="tab"][href="/agents/${LONG_AGENT}${to}"]`);
    const summary = (url: URL) => !url.searchParams.has("tab");
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
          await agent.waitForURL(summary);
        },
      ),
    });
    out.push({
      name: `Switch an agent's tab (back to its ${entries}-entry summary)`,
      ms: await typical(
        agent,
        async () => {
          await tab("").click();
          await agent.waitForURL(summary);
        },
        async () => {
          await tab("?tab=files").click();
          await agent.waitForURL(/tab=files/);
        },
      ),
    });
    await agent.context().close();

    // A decision is recorded, so each session to validate is decided once: the median of a few of them.
    const decided: number[] = [];
    for (const ticket of await toValidate(base, cookie)) {
      const session = await open(browser, `${base}/agents/${ticket}`, cookie, slowdown);
      decided.push(
        await measure(session, async () => {
          await session.locator('button[name="choice"], button[name="action"][value="approve"]').first().click();
        }),
      );
      await session.context().close();
    }
    out.push({
      name: `Decide a validation (median of ${decided.length} sessions to validate)`,
      ms: decided.sort((a, b) => a - b)[Math.floor(decided.length / 2)] ?? 0,
    });

    // The Validations page's keys (THE-1113): C puts the focus in the note and Esc takes it out, then A decides.
    const id = await toDecideByKey(base, cookie);
    if (id !== null) {
      const page = await open(browser, `${base}/approve/${id}`, cookie, slowdown);
      const inNote = () => page.evaluate(() => document.activeElement?.classList.contains("vd-note") ?? false);
      out.push({
        name: "Request changes with C on the Validations page",
        ms: await typical(
          page,
          async () => {
            await page.keyboard.press("c");
            await page.waitForFunction(() => document.activeElement?.classList.contains("vd-note"));
          },
          async () => {
            await page.keyboard.press("Escape");
            if (await inNote()) throw new Error("Esc left the focus in the note");
          },
        ),
      });
      // Without ARMADA_DASHBOARD_AUTHOR or an account the request needs a name: give one, as the owner would once.
      const name = page.locator('input[name="author"]:visible');
      if (await name.count()) {
        await name.fill("Perf");
        await name.blur();
      }
      out.push({
        name: "Approve with A on the Validations page",
        ms: await measure(page, async () => {
          await page.keyboard.press("a");
          await page.locator(".vd-detail .pending").waitFor();
        }),
      });
      await page.context().close();
    }
    return out;
  } finally {
    await browser.close();
  }
}
