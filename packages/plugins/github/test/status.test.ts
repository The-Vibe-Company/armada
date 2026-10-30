import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keychain } from "@armada/daemon/keychain";
import { fileKeychain } from "../../../daemon/src/secrets/file.ts";
import { githubConnection } from "../src/status.ts";

test("GitHub falls back to a secret prompt without gh, persists it and reports the login/source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "github-connection-"));
  const path = process.env.PATH;
  process.env.PATH = dir;
  try {
    const keychain = new Keychain(fileKeychain(join(dir, "keys")));
    const token = randomBytes(24).toString("hex");
    const connection = githubConnection(
      {
        get: (name) => keychain.read("plugin", name),
        set: (name, value) => keychain.write("plugin", name, value),
        delete: (name) => keychain.remove("plugin", name),
        source: async () => "Saved key",
      },
      undefined,
      async (url, init) => {
        assert.equal(url, "https://api.github.com/user");
        assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${token}`);
        return Response.json({ login: "MiraOrchard", email: "mira@example.test", token });
      },
    );
    assert.equal((await connection.status!()).state, "disconnected");
    await connection.connect!({
      notify() {},
      prompt: async (prompt) => {
        assert.equal(prompt.type, "secret");
        return token;
      },
    });
    assert.equal(await keychain.read("plugin", "GITHUB_TOKEN"), token);
    assert.deepEqual(await connection.status!(), {
      installed: true,
      state: "connected",
      account: { label: "MiraOrchard (Saved key)" },
    });
    await connection.disconnect!();
    assert.equal((await connection.status!()).state, "disconnected");
  } finally {
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  }
});
