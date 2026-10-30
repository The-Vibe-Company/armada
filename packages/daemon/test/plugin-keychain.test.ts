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

test("declared secrets prefer the environment, then plugin storage, then legacy GitHub storage", async (t) => {
  const backend = new FakeKeychain();
  const keychain = new Keychain(backend);
  const previous = process.env.GITHUB_TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  });
  await keychain.write("github", "github", "legacy-github-credential");
  await keychain.write("plugin", "GITHUB_TOKEN", "plugin-github-credential");
  process.env.GITHUB_TOKEN = "environment-github-credential";
  assert.equal(await readPluginSecret("GITHUB_TOKEN", keychain), "environment-github-credential");
  delete process.env.GITHUB_TOKEN;
  assert.equal(await readPluginSecret("GITHUB_TOKEN", keychain), "plugin-github-credential");
  backend.entries.delete(JSON.stringify(["armada.plugins", "GITHUB_TOKEN"]));
  assert.equal(await readPluginSecret("GITHUB_TOKEN", keychain), "legacy-github-credential");
});
