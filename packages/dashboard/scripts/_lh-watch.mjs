// TEMPORARY (THE-982 diagnosis, removed before the pull request): one Lighthouse
// run like scripts/perf-lighthouse.mjs, on a puppeteer page that watches the
// document overflow sideways and logs every layout shift the page sees.
//   node scripts/_lh-watch.mjs <url> <config.mjs> <name=value>
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [url, configPath, cookie] = process.argv.slice(2);
const lighthouseDir = dirname(createRequire(import.meta.url).resolve("lighthouse/package.json"));
const fromLighthouse = createRequire(join(lighthouseDir, "package.json"));
const { default: lighthouse } = await import(pathToFileURL(join(lighthouseDir, "core/index.js")).href);
const { launch } = await import(pathToFileURL(fromLighthouse.resolve("chrome-launcher")).href);
const puppeteer = (await import(pathToFileURL(fromLighthouse.resolve("puppeteer-core")).href)).default;
const { default: config } = await import(pathToFileURL(configPath).href);

const watcher = () => {
  const w = window;
  w.__log = [];
  const log = (s) => console.debug(`[cls] ${location.pathname} ${Math.round(performance.now())} ${s}`);
  log(`document start ${Math.round(performance.timeOrigin)}`);
  const name = (e) =>
    `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${typeof e.className === "string" && e.className.trim() ? `.${e.className.trim().split(/\s+/).join(".")}` : ""}`;
  const path = (e) => {
    const parts = [];
    for (let n = e; n && parts.length < 6; n = n.parentElement) parts.unshift(name(n));
    return parts.join(" > ");
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
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
  const check = (why) => {
    const d = document.documentElement;
    if (!d) return;
    const now = `${innerWidth}x${innerHeight} scroll ${d.scrollWidth}`;
    if (now !== last) log(`viewport ${now} (${why})`);
    last = now;
    if ((innerWidth > 412 || d.scrollWidth > 412) && dumped < 3) {
      dumped++;
      const wide = [];
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
};

const chrome = await launch({
  chromeFlags: ["--headless=new", "--no-sandbox"],
  ...(process.env.CHROME_PATH ? { chromePath: process.env.CHROME_PATH } : {}),
});
try {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  const at = cookie.indexOf("=");
  await browser.setCookie({
    name: cookie.slice(0, at),
    value: cookie.slice(at + 1),
    domain: new URL(url).hostname,
    path: "/",
  });
  await page.evaluateOnNewDocument(watcher);
  const lines = [];
  page.on("console", (m) => {
    const text = m.text();
    if (text.startsWith("[cls] ")) lines.push(text.slice(6));
  });
  const result = await lighthouse(url, { output: "json", logLevel: "error" }, config, page);
  const lhr = result.lhr;
  const cls = Math.round(lhr.audits["cumulative-layout-shift"].numericValue * 1000) / 1000;
  const hit =
    cls > 0 || lines.some((l) => !l.startsWith("blank ") && / OVERFLOW | shift /.test(l) && !/ \(input\) /.test(l));
  console.log(`${new URL(url).pathname} CLS ${cls}${hit ? " HIT" : ""}`);
  for (const item of lhr.audits["layout-shifts"]?.details?.items ?? [])
    console.log(`  lighthouse: ${item.score?.toFixed(4)} ${item.node?.selector ?? "?"}`);
  if (hit || process.env.VERBOSE) for (const l of lines.filter((l) => !l.startsWith("blank "))) console.log(`  ${l}`);
  await browser.disconnect();
} finally {
  chrome.kill();
}
