import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { githubToken, type TokenCommand } from "../src/forge/keychain.ts";

test("owner keychain wins on macOS; absent/locked entries fall back to gh without leaking command errors", async () => {
  const owner = randomUUID();
  const fallback = randomUUID();
  const calls: string[] = [];
  assert.equal(
    await githubToken({
      platform: "darwin",
      command: async (file) => {
        calls.push(file);
        return owner;
      },
    }),
    owner,
  );
  assert.deepEqual(calls, ["security"]);
  for (const missing of ["empty", "locked"]) {
    calls.length = 0;
    const command: TokenCommand = async (file) => {
      calls.push(file);
      if (file === "security") {
        if (missing === "locked") throw new Error(owner);
        return "";
      }
      return `${fallback}\n`;
    };
    assert.equal(await githubToken({ platform: "darwin", command }), fallback);
    assert.deepEqual(calls, ["security", "gh"]);
  }
  calls.length = 0;
  assert.equal(
    await githubToken({
      platform: "linux",
      command: async (file) => {
        calls.push(file);
        return fallback;
      },
    }),
    fallback,
  );
  assert.deepEqual(calls, ["gh"]);
  await assert.rejects(
    githubToken({
      platform: "darwin",
      command: async () => {
        throw new Error(owner);
      },
    }),
    (error: Error) => error.message.includes("credentials unavailable") && !error.message.includes(owner),
  );
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(
    githubToken({ signal: stopped.signal, command: async () => assert.fail("must not spawn after abort") }),
  );
});
