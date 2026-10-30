import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keychain } from "@armada/daemon/keychain";
import { fileKeychain } from "../../../daemon/src/secrets/file.ts";
import { linearConnection } from "../src/status.ts";

test("Linear validates a secret prompt, stores it in the host keychain and returns only viewer name/organization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "linear-connection-"));
  try {
    const keychain = new Keychain(fileKeychain(join(dir, "keys")));
    const key = randomBytes(24).toString("hex");
    let calls = 0;
    const connection = linearConnection(
      {
        get: (name) => keychain.read("plugin", name),
        set: (name, value) => keychain.write("plugin", name, value),
        delete: (name) => keychain.remove("plugin", name),
        source: async () => "Saved key",
      },
      undefined,
      async (_url, init) => {
        calls++;
        assert.equal(new Headers(init.headers).get("Authorization"), key);
        return Response.json({
          data: { viewer: { name: "Mira", email: "mira@example.test", organization: { name: "Orchard" } } },
        });
      },
    );
    assert.equal((await connection.status!()).state, "disconnected");
    await connection.connect!({
      notify() {},
      prompt: async (prompt) => {
        assert.equal(prompt.type, "secret");
        assert.equal(prompt.message, "Linear API key");
        return key;
      },
    });
    assert.equal(await keychain.read("plugin", "LINEAR_API_KEY"), key);
    const status = await connection.status!();
    assert.deepEqual(status, {
      installed: true,
      state: "connected",
      account: { label: "Mira (Orchard)" },
      detail: "Saved key",
    });
    assert.equal(calls, 2);
    assert.ok(!JSON.stringify(status).includes(key));
    await connection.disconnect!();
    assert.equal((await connection.status!()).state, "disconnected");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Linear reuses the Armada key and sanitizes failed verification", async () => {
  let prompted = false;
  const connection = linearConnection(
    { get: async () => "injected", source: async () => "Armada" },
    undefined,
    async () => {
      throw new Error("injected mira@example.test");
    },
  );
  await connection.connect!({
    notify() {},
    prompt: async () => {
      prompted = true;
      return "";
    },
  });
  assert.equal(prompted, false);
  assert.deepEqual(await connection.status!(), {
    installed: true,
    state: "disconnected",
    detail: "Linear connection could not be verified",
  });
});
