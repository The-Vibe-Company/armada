/**
 * Repeatable, offline conversation projection benchmark.
 * Run: bun scripts/perf/chat.ts [samples] > /tmp/chat-perf.json
 * Run the identical script against both revisions; no provider calls or secrets.
 */
import { projectChat } from "../../apps/dashboard/src/lib/chat.ts";
import type { ChatEvent } from "../../apps/dashboard/src/lib/events.ts";

const samples = Number(process.argv[2] ?? 30);
if (!Number.isInteger(samples) || samples < 5 || samples > 1000) {
  throw new Error("samples must be an integer from 5 to 1000");
}
const results = [];
for (const count of [1000, 10000, 30000]) {
  for (const mode of ["legacy", "identified"] as const) {
    const events: ChatEvent[] = Array.from({ length: count }, (_, i) => ({
      id: String(i),
      at: i,
      conversationId: "conversation",
      promptId: "prompt",
      kind: "message",
      text: "chunk",
      partial: true,
      tools: [],
      ...(mode === "identified" ? { messageId: "message", textMode: "delta" as const } : {}),
    }));
    // Retain an unfinished turn: there is no final snapshot to discard the chunks.
    for (let i = 0; i < 3; i++) projectChat(events);
    const times = [];
    let items = 0;
    for (let i = 0; i < samples; i++) {
      const start = performance.now();
      items = projectChat(events).items.length;
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    results.push({
      mode,
      events: count,
      items,
      samples,
      p50Ms: times[Math.ceil(samples * 0.5) - 1],
      p95Ms: times[Math.ceil(samples * 0.95) - 1],
    });
  }
}
console.log(
  JSON.stringify(
    {
      runtime: Bun.version,
      platform: process.platform,
      arch: process.arch,
      note: "Warm CPU-only synthetic projection; not browser open latency or provider latency.",
      results,
    },
    null,
    2,
  ),
);
