import assert from "node:assert/strict";
import { installShutdownHandlers } from "../../src/shutdown.ts";

const mode = process.argv[3];
if (mode === "deadline") {
  globalThis.setTimeout = ((callback: () => void) => {
    queueMicrotask(callback);
    return 1;
  }) as unknown as typeof setTimeout;
}
const entered = Promise.withResolvers<void>();
const release = Promise.withResolvers<void>();
const server = Bun.serve({
  port: 0,
  async fetch() {
    entered.resolve();
    await release.promise;
    return new Response("completed");
  },
});
installShutdownHandlers({
  async stop(force) {
    if (mode === "deadline") {
      if (force) console.log("FORCED_STOP_VERIFIED");
      return new Promise<void>(() => {});
    }
    if (mode === "failure") throw new Error("private diagnostic must not escape");
    assert.equal(force, false);
    const drained = server.stop(force);
    release.resolve();
    await drained;
    assert.equal(await (await response).text(), "completed");
    console.log("SIGNAL_DRAIN_VERIFIED");
  },
});
const response = fetch(`http://127.0.0.1:${server.port}`);
await entered.promise;
process.kill(process.pid, process.argv[2] as NodeJS.Signals);
