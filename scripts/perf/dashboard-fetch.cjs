/** Fixture-only server-fetch timing preload. Never records headers, bodies, or query strings.
 * NODE_OPTIONS="--require=./e2e/github-fetch.cjs --require=../../scripts/perf/dashboard-fetch.cjs"
 * Optional DASHBOARD_PERF_DELAY_MS models equal latency on two independent reads.
 * Its timings are a scheduling experiment, not deployed performance evidence.
 */
const { performance } = require("node:perf_hooks");
const original = globalThis.fetch;
const delay = Number(process.env.DASHBOARD_PERF_DELAY_MS ?? 0);
if (!Number.isFinite(delay) || delay < 0 || delay > 1000) throw new Error("Invalid fixture fetch delay");
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  // Only the local fixture service is observable/delayed, regardless of inherited environment.
  if (url.hostname !== "127.0.0.1" || url.port !== "54399") return original(input, init);
  const path = url.pathname;
  const start = performance.now();
  console.error(JSON.stringify({ fixtureFetch: "start", path, ms: Math.round(start) }));
  try {
    if (delay && (path === "/rest/v1/rpc/org_members" || path === "/api/v1/mcp/sandbox-connections")) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    return await original(input, init);
  } finally {
    console.error(
      JSON.stringify({
        fixtureFetch: "end",
        path,
        ms: Math.round(performance.now()),
        duration: Math.round(performance.now() - start),
      }),
    );
  }
};
