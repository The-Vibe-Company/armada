// One Lighthouse run, in Node (Lighthouse's own runtime), for `bun run perf
// lighthouse` (THE-892). Signed in as a person is: the session cookie goes
// into Chrome's cookie jar before the run. A Cookie header would not do: once
// a page sets a cookie of its own, Chrome sends its jar instead.
//   node scripts/perf-lighthouse.mjs <url> <config.mjs> <name=value> <report.json>
// It writes the trace's layout shifts beside the report (<report.json>.shifts.json).
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [url, configPath, cookie, out] = process.argv.slice(2);
if (!url || !configPath || !cookie || !out) {
  console.error("usage: node scripts/perf-lighthouse.mjs <url> <config.mjs> <name=value> <report.json>");
  process.exit(2);
}

const lighthouseDir = dirname(createRequire(import.meta.url).resolve("lighthouse/package.json"));
const fromLighthouse = createRequire(join(lighthouseDir, "package.json"));
const { default: lighthouse } = await import(pathToFileURL(join(lighthouseDir, "core/index.js")).href);
const { launch } = await import(pathToFileURL(fromLighthouse.resolve("chrome-launcher")).href);
const { default: config } = await import(pathToFileURL(configPath).href);

/** One DevTools command on the browser's own target. */
async function browserCommand(port, method, params) {
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((open, fail) => {
    socket.onopen = open;
    socket.onerror = fail;
  });
  const answer = new Promise((done, fail) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      if (message.error) fail(new Error(message.error.message));
      else done(message.result);
    };
  });
  socket.send(JSON.stringify({ id: 1, method, params }));
  try {
    return await answer;
  } finally {
    socket.close();
  }
}

const chrome = await launch({
  chromeFlags: ["--headless=new", "--no-sandbox"],
  ...(process.env.CHROME_PATH ? { chromePath: process.env.CHROME_PATH } : {}),
});
try {
  const at = cookie.indexOf("=");
  await browserCommand(chrome.port, "Storage.setCookies", {
    cookies: [{ name: cookie.slice(0, at), value: cookie.slice(at + 1), url: new URL(url).origin, path: "/" }],
  });
  const result = await lighthouse(url, { port: chrome.port, output: "json", logLevel: "error" }, config);
  if (!result) throw new Error(`Lighthouse returned nothing for ${url}`);
  await writeFile(out, result.report);
  // Each layout shift of the trace, with the boxes of the nodes it moved (THE-982): bun run perf prints
  // them. A log only: a trace it cannot read writes none, and the run still counts.
  let shifts = [];
  try {
    const events = result.artifacts?.Trace?.traceEvents ?? [];
    const start = events.find((e) => e.name === "navigationStart")?.ts ?? events[0]?.ts ?? 0;
    const names = new Map((result.artifacts?.TraceElements ?? []).map((t) => [t.nodeId, t.node?.selector]));
    const box = (r) => (Array.isArray(r) ? r.map((n) => Math.round(n)) : []);
    shifts = events
      .filter((e) => e.name === "LayoutShift" && e.args?.data)
      .map(({ ts, args: { data } }) => ({
        ms: Math.round((ts - start) / 1000),
        score: data.score ?? 0,
        input: Boolean(data.had_recent_input),
        nodes: (data.impacted_nodes ?? []).map((n) => ({
          node: names.get(n.node_id) ?? `node ${n.node_id}`,
          before: box(n.old_rect),
          after: box(n.new_rect),
        })),
      }));
  } catch (error) {
    console.error(`No layout shifts read from the trace of ${url}: ${error}`);
  }
  await writeFile(`${out}.shifts.json`, JSON.stringify(shifts));
} finally {
  chrome.kill();
}
