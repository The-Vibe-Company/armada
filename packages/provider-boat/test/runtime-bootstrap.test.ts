import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { boatRuntimeBootstrapScript } from "../src/runtime-bootstrap.ts";

test("the generated interpreter probe rejects Node without the APIs needed for artifact downloads", () => {
  const script = boatRuntimeBootstrapScript("https://armada.invalid", { sha256: "a".repeat(64), bytes: 1 }, "/cache");
  const probe = script.match(/-e '([^']+)' >\/dev\/null 2>&1/)?.[1] ?? "";
  const process = { exit: (code: number) => code };
  expect(runInNewContext(probe, { process, AbortSignal })).toBe(1);
  expect(runInNewContext(probe, { process, fetch, AbortSignal: {} })).toBe(1);
  expect(runInNewContext(probe, { process, fetch, AbortSignal })).toBeUndefined();
});
