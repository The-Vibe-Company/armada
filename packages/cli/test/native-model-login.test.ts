import { expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { nativeCodexLogin } from "../src/native-model-login.ts";

// Tests the real child-process JSONL/file boundary, not an invented OAuth server.
test("native local login returns private auth material but exposes only the approved device challenge", async () => {
  const shown: string[][] = [];
  const result = await nativeCodexLogin({
    executable: `${import.meta.dir}/fixtures/native-codex-login.ts`,
    path: process.env.PATH ?? "/usr/bin:/bin",
    signal: AbortSignal.timeout(3000),
    device: (url, code) => {
      shown.push([url, code]);
    },
  });
  expect(JSON.parse(result).tokens.refresh_token).toBe("synthetic-refresh");
  expect(shown).toEqual([["https://auth.openai.com/codex/device", "ABCD-EFGH"]]);
});

test("cancellation at the device challenge prevents local auth publication", async () => {
  const controller = new AbortController();
  await expect(
    nativeCodexLogin({
      executable: `${import.meta.dir}/fixtures/native-codex-login.ts`,
      path: process.env.PATH ?? "/usr/bin:/bin",
      signal: controller.signal,
      device: () => controller.abort(),
    }),
  ).rejects.toThrow("No account was published");
});

test("native npm-wrapper login cleans the inherited-pipe child and private auth home", async () => {
  const value = await nativeCodexLogin({
    executable: `${import.meta.dir}/fixtures/native-codex-wrapper.ts`,
    path: process.env.PATH ?? "/usr/bin:/bin",
    signal: AbortSignal.timeout(3000),
    device: () => {},
  });
  const native = JSON.parse(value);
  await expect(stat(native.fixtureHome)).rejects.toMatchObject({ code: "ENOENT" });
  if (process.platform === "linux") {
    const status = await readFile(`/proc/${native.fixturePid}/status`, "utf8").catch(() => "");
    // A killed descendant can briefly remain a zombie until init reaps it.
    if (status && !/^State:\s+Z/m.test(status)) {
      const pending = [...status.matchAll(/^(?:SigPnd|ShdPnd):\s+([a-f0-9]+)/gm)].reduce(
        (mask, match) => mask | BigInt(`0x${match[1]}`),
        0n,
      );
      try {
        expect(pending & 256n).toBe(256n);
      } finally {
        try {
          process.kill(native.fixturePid, "SIGKILL");
        } catch {}
      } // SIGKILL pending, never an unfenced live session.
    }
  }
});
