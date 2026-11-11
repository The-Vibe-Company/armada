import assert from "node:assert/strict";
import { installShutdownHandlers } from "../../src/shutdown.ts";

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
