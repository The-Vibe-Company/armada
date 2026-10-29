import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Keychain } from "../src/keychain.ts";
import { readPluginSecret } from "../src/plugins/keychain.ts";
import { FakeKeychain } from "./support/keychain.ts";

test("plugin secrets use the shared gateway and reserved namespace without altering values", async () => {
  const backend = new FakeKeychain();
  const keychain = new Keychain(backend);
  const value = `  ${randomBytes(24).toString("hex")}\nvalue \n`;
  await keychain.write("plugin", "MODEL_KEY", value);
  await keychain.write("github", "OTHER_KEY", randomBytes(24).toString("hex"));
  assert.equal(await readPluginSecret("MODEL_KEY", keychain), value);
  assert.equal(backend.entries.get(JSON.stringify(["armada.plugins", "MODEL_KEY"])), value);
  assert.equal(await readPluginSecret("OTHER_KEY", keychain), null);
  assert.equal(await readPluginSecret("MISSING_KEY", keychain), null);
  assert.equal(
    await readPluginSecret("MODEL_KEY", {
      read: async () => {
        throw new Error("private backend output");
      },
    }),
    null,
  );
});
