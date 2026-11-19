import { expect, test } from "bun:test";
import { nativeCodexLogin } from "../src/native-model-login.ts";

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
