import { afterEach, expect, spyOn, test } from "bun:test";
import { installShutdownHandlers } from "../src/shutdown.ts";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of restore.splice(0).reverse()) cleanup();
});

for (const outcome of ["drained", "failure", "deadline"] as const) {
  test(`shutdown ${outcome} is idempotent and reports the correct exit status`, async () => {
    const handlers = new Map<string, () => void>();
    const on = spyOn(process, "on").mockImplementation(((signal: string, handler: () => void) => {
      handlers.set(signal, handler);
      return process;
    }) as typeof process.on);
    restore.push(() => on.mockRestore());
    const exit = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    restore.push(() => exit.mockRestore());
    const info = spyOn(console, "info").mockImplementation(() => {});
    restore.push(() => info.mockRestore());
    const error = spyOn(console, "error").mockImplementation(() => {});
    restore.push(() => error.mockRestore());
    let deadline: (() => void) | undefined;
    const timer = {} as ReturnType<typeof setTimeout>;
    const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
      expect(ms).toBe(25_000);
      deadline = callback;
      return timer;
    }) as typeof setTimeout);
    restore.push(() => timeout.mockRestore());
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
    restore.push(() => clear.mockRestore());
    const pending = Promise.withResolvers<void>();
    const stops: (boolean | undefined)[] = [];
    installShutdownHandlers({
      stop(force) {
        stops.push(force);
        return pending.promise;
      },
    });
    expect([...handlers.keys()]).toEqual(["SIGTERM", "SIGINT"]);
    handlers.get("SIGTERM")!();
    handlers.get("SIGINT")!();
    expect(stops).toEqual([false]);
    expect(exit).not.toHaveBeenCalled();
    if (outcome === "deadline") {
      deadline!();
      expect(stops).toEqual([false, true]);
      expect(error).toHaveBeenCalledWith(
        "armada-server: shutdown deadline exceeded; in-flight work may need reconciliation",
      );
    } else {
      if (outcome === "failure") pending.reject(new Error("private failure"));
      else pending.resolve();
      await Promise.resolve();
      expect(clear).toHaveBeenCalledWith(timer);
      if (outcome === "failure") expect(error).toHaveBeenCalledWith("armada-server: shutdown failed");
      else expect(error).not.toHaveBeenCalled();
    }
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(outcome === "drained" ? 0 : 1);
  });
}
