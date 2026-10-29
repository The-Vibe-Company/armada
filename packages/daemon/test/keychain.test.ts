import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { githubToken } from "../src/forge/keychain.ts";
import { Keychain } from "../src/keychain.ts";
import { FakeKeychain } from "./support/keychain.ts";

test("owner keychain wins; absent/locked entries fall back to gh without leaking source errors", async () => {
  const owner = randomUUID();
  const fallback = randomUUID();
  const calls: string[] = [];
  const chain = new Keychain(new FakeKeychain());
  await chain.write("github", "github", owner);
  assert.equal(await githubToken({ keychain: chain, command: async () => assert.fail("keychain wins") }), owner);
  for (const missing of ["empty", "locked"]) {
    calls.length = 0;
    const keychain = {
      read: async () => {
        calls.push("keychain");
        if (missing === "locked") throw new Error(owner);
        return null;
      },
    };
    assert.equal(
      await githubToken({
        keychain,
        command: async (file, args) => {
          calls.push(file);
          assert.deepEqual(args, ["auth", "token"]);
          return `${fallback}\n`;
        },
      }),
      fallback,
    );
    assert.deepEqual(calls, ["keychain", "gh"]);
  }
  await assert.rejects(
    githubToken({
      keychain: {
        read: async () => {
          throw new Error(owner);
        },
      },
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
