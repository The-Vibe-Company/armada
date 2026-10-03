// TEMPORARY (THE-982 diagnosis, removed before the pull request): loads a page
// many times under Lighthouse's mobile emulation and throttling, and whenever
// the layout viewport grows (the document overflowed sideways) names every
// element that reaches past the screen's width.
//   bun scripts/_cls-diag.ts <base> <path> <runs>
import { chromium } from "playwright-core";
import { issueSession, SESSION_COOKIE } from "../lib/auth";

const [base = "http://localhost:4822", path = "/", runsArg = "20"] = process.argv.slice(2);
const runs = Number(runsArg);
const password = process.env.ARMADA_DASHBOARD_PASSWORD ?? "local-check";
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chrome" }),
  args: ["--no-sandbox"],
});
let hits = 0;
for (let i = 0; i < runs; i++) {
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 823 },
    deviceScaleFactor: 1.75,
    isMobile: true,
    hasTouch: true,
  });
  await ctx.addCookies([{ name: SESSION_COOKIE, value: issueSession(password, Date.now()), url: base }]);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.CPU ?? 4) });
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 562.5,
    downloadThroughput: (1474.56 * 1024) / 8,
    uploadThroughput: (675 * 1024) / 8,
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __log: string[] };
    w.__log = [];
    const log = (s: string) => w.__log.push(`${Math.round(performance.now())} ${s}`);
    const name = (e: Element) =>
      `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${typeof e.className === "string" && e.className.trim() ? `.${e.className.trim().split(/\s+/).join(".")}` : ""}`;
    const path = (e: Element) => {
      const parts: string[] = [];
      for (let n: Element | null = e; n && parts.length < 6; n = n.parentElement) parts.unshift(name(n));
      return parts.join(" > ");
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as {
        value: number;
        hadRecentInput: boolean;
        sources: { node?: Node; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
      }[])
        log(
          `shift ${e.value.toFixed(5)}${e.hadRecentInput ? " (input)" : ""} ${e.sources
            .map(
              (s) =>
                `${s.node instanceof Element ? path(s.node) : (s.node?.nodeName ?? "?")} [${[s.previousRect.x, s.previousRect.y, s.previousRect.width, s.previousRect.height].map(Math.round)}] -> [${[s.currentRect.x, s.currentRect.y, s.currentRect.width, s.currentRect.height].map(Math.round)}]`,
            )
            .join(" | ")}`,
        );
    }).observe({ type: "layout-shift", buffered: true });
    let dumped = 0;
    let last = "";
    const check = (why: string) => {
      const d = document.documentElement;
      if (!d) return;
      const now = `${innerWidth}x${innerHeight} scroll ${d.scrollWidth}`;
      if (now !== last) log(`viewport ${now} (${why})`);
      last = now;
      if ((innerWidth > 412 || d.scrollWidth > 412) && dumped < 3) {
        dumped++;
        const wide: string[] = [];
        for (const e of document.querySelectorAll("body *")) {
          const r = e.getBoundingClientRect();
          if (r.right > 412.5 || r.left < -0.5) {
            const cs = getComputedStyle(e);
            wide.push(
              `${path(e)} [${Math.round(r.left)}..${Math.round(r.right)}] pos=${cs.position} display=${cs.display} ovx=${cs.overflowX} transform=${cs.transform} translate=${cs.translate}`,
            );
          }
        }
        log(`OVERFLOW (${why}) ${wide.length} elements past the screen:\n    ${wide.slice(0, 60).join("\n    ")}`);
      }
    };
    addEventListener("resize", () => check("resize"));
    const frame = () => {
      check("frame");
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page.goto(`${base}${path}`, { waitUntil: "load" });
  await page.waitForTimeout(15_000);
  const lines = await page.evaluate(() => (window as unknown as { __log: string[] }).__log);
  const hit = lines.some((l) => l.includes("OVERFLOW") || / shift /.test(` ${l}`));
  if (hit) hits++;
  console.log(`run ${i + 1}${hit ? " HIT" : ""}`);
  if (hit || process.env.VERBOSE) for (const l of lines) console.log(`  ${l}`);
  await ctx.close();
}
console.log(`${hits}/${runs} runs overflowed or shifted`);
await browser.close();
