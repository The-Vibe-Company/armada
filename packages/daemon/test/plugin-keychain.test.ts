import assert from "node:assert/strict";
import { test } from "node:test";
import { readPluginSecret } from "../src/plugins/keychain.ts";

test("plugin secrets use the reserved keychain service and hide missing/locked command errors", async () => {
  const calls: [string, string[]][] = [];
  assert.equal(
    await readPluginSecret("MODEL_KEY", {
      platform: "darwin",
      command: async (file, args) => {
        calls.push([file, args]);
        return "fixture-secret\n";
      },
    }),
    "fixture-secret",
  );
  assert.deepEqual(calls, [["security", ["find-generic-password", "-s", "armada.plugins", "-a", "MODEL_KEY", "-w"]]]);
  assert.equal(
    await readPluginSecret("MULTILINE_KEY", {
      platform: "darwin",
      command: async () => "  fixture\nvalue \n",
    }),
    "  fixture\nvalue ",
  );
  assert.equal(
    await readPluginSecret("MISSING_KEY", {
      platform: "darwin",
      command: async () => {
        throw new Error("private command output");
      },
    }),
    null,
  );
  let offPlatformCalls = 0;
  assert.equal(
    await readPluginSecret("MODEL_KEY", {
      platform: "linux",
      command: async () => {
        offPlatformCalls++;
        return "fixture-secret";
      },
    }),
    null,
  );
  assert.equal(offPlatformCalls, 0);
});
