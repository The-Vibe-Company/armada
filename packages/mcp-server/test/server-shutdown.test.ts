import { expect, test } from "bun:test";
import { installServerShutdown } from "../src/server-shutdown.ts";

test("server shutdown retains shared services through draining and permits forced-stop escalation", async () => {
  const workers = Promise.withResolvers<void>();
  const sockets = Promise.withResolvers<void>();
  const docker = Promise.withResolvers<void>();
  const request = Promise.withResolvers<void>();
  const native = Promise.withResolvers<void>();
  const mcp = Promise.withResolvers<void>();
  const mcpEntered = Promise.withResolvers<void>();
  const mcpClosed = Promise.withResolvers<void>();
  const requests = new Set([request.promise]);
  void request.promise.then(() => requests.delete(request.promise));
  const stops: (boolean | undefined)[] = [];
  const trace: string[] = [];
  const nativeDone = native.promise.then(() => {
    trace.push("native-drained");
  });
  const server = {
    stop(force?: boolean) {
      stops.push(force);
      return nativeDone;
    },
    workerDone: Promise.resolve(),
  };
  installServerShutdown(server, {
    beginDrain: () => {
      trace.push("draining");
    },
    workersDone: workers.promise,
    stopSockets: () => sockets.promise,
    closeDocker: () => docker.promise,
    requests,
    closeMcp: () => {
      trace.push("mcp");
      mcpEntered.resolve();
      return mcp.promise.then(() => {
        trace.push("mcp-closed");
        mcpClosed.resolve();
      });
    },
    closePools: async () => {
      trace.push("pools");
    },
  });
  const shutdown = server.stop();
  expect(server.stop(true)).toBe(shutdown);
  expect(server.workerDone).toBe(shutdown);
  expect(stops).toEqual([undefined, true]);
  expect(trace).toEqual(["draining"]);
  workers.resolve();
  sockets.resolve();
  docker.resolve();
  await Promise.resolve();
  expect(trace).toEqual(["draining"]);
  request.resolve();
  await mcpEntered.promise;
  expect(trace).toEqual(["draining", "mcp"]);
  mcp.resolve();
  await mcpClosed.promise;
  expect(trace).toEqual(["draining", "mcp", "mcp-closed"]);
  native.resolve();
  await shutdown;
  expect(trace).toEqual(["draining", "mcp", "mcp-closed", "native-drained", "pools"]);
});
