import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { assertLocalPortsAvailable } from "./local-ports.ts";

afterEach(() => {
  // Restore process primitives so no other unit test inherits fixture probes.
  listen.mockRestore();
  diagnostics.mockRestore();
});
let listen: ReturnType<typeof spyOn<typeof Bun, "listen">>;
let diagnostics: ReturnType<typeof spyOn<typeof Bun, "spawnSync">>;
beforeEach(() => {
  listen = spyOn(Bun, "listen");
  diagnostics = spyOn(Bun, "spawnSync");
});

test("free fixture ports release their probes before servers start", () => {
  const stop = mock((_close: boolean) => {});
  listen.mockReturnValue({ stop } as unknown as ReturnType<typeof Bun.listen>);
  assertLocalPortsAvailable([54399, 3100]);
  expect(listen.mock.calls.map(([options]) => ("port" in options ? options.port : undefined))).toEqual([54399, 3100]);
  expect(stop.mock.calls).toEqual([[true], [true]]);
});

test("an occupied fixture port aborts with listener ownership instead of reusing it", () => {
  listen.mockImplementation(() => {
    throw new Error("address in use");
  });
  diagnostics.mockReturnValue({
    exitCode: 0,
    stdout: Buffer.from('LISTEN 127.0.0.1:54399 users:(("bun",pid=123))'),
  } as ReturnType<typeof Bun.spawnSync>);
  expect(() => assertLocalPortsAvailable([54399, 3100])).toThrow("pid=123");
});
