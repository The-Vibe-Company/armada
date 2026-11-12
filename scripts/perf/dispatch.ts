/** Offline scaffolding baseline: bun scripts/perf/dispatch.ts [samples]. No SQL/network/provider calls. */
import { createSqlData } from "../../packages/mcp-server/src/data.ts";
import { RequestTiming } from "../../packages/mcp-server/src/request-timing.ts";
import { callSharedTool } from "../../packages/mcp-server/src/tool-api.ts";
import type { ToolContext } from "../../packages/mcp-server/src/tools.ts";

const samples = Number(process.argv[2] ?? 30);
if (!Number.isInteger(samples) || samples < 5 || samples > 1000) throw new Error("samples must be 5..1000");
const caller: ToolContext["caller"] = { userId: "00000000-0000-4000-8000-000000000001", orgs: [], via: "service" };
const blocked = async (): Promise<never> => {
  throw new Error("Offline benchmark cannot perform external I/O");
};
const context: ToolContext = {
  caller,
  data: createSqlData({ query: blocked })(caller),
  provider: blocked,
  exposedSecrets: async () => [],
  launchCredentials: { resolve: blocked },
  now: () => new Date(),
  sleep: blocked,
};
const total: number[] = [];
const phases = new Map<string, number[]>();
for (let i = 0; i < samples + 3; i++) {
  const timing = new RequestTiming();
  const start = performance.now();
  const result = await callSharedTool({ ...context, measure: timing.measure.bind(timing) }, "golden_list", {});
  const elapsed = performance.now() - start;
  if (JSON.stringify(result) !== '{"goldens":[]}') throw new Error("Unexpected empty tool result");
  if (i < 3) continue;
  total.push(elapsed);
  for (const part of timing.header().split(",")) {
    const match = /^\s*([a-z_]+);dur=([0-9.]+)\s*$/.exec(part);
    if (!match?.[1] || !match[2]) continue;
    const values = phases.get(match[1]) ?? [];
    values.push(Number(match[2]));
    phases.set(match[1], values);
  }
}
function stats(values: number[]) {
  values.sort((a, b) => a - b);
  return { p50: values[Math.ceil(values.length * 0.5) - 1], p95: values[Math.ceil(values.length * 0.95) - 1] };
}
console.log(
  JSON.stringify(
    {
      runtime: Bun.version,
      platform: process.platform,
      arch: process.arch,
      samples,
      note: "Warm empty-org golden_list over the real in-memory MCP stack. No auth, SQL, cloud or user-facing latency claim.",
      totalMs: stats(total),
      serverMs: Object.fromEntries([...phases].map(([name, values]) => [name, stats(values)])),
    },
    null,
    2,
  ),
);
