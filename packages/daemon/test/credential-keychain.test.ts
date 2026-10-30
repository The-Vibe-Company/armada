import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Keychain } from "../src/keychain.ts";
import { fileKeychain } from "../src/secrets/file.ts";
import { macKeychain } from "../src/secrets/macos.ts";
import { FakeKeychain } from "./support/keychain.ts";

test("native Keychain instances serialize shared mutations without storing a credential on disk", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "armada-native-lock-"));
  const prior = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  t.after(async () => {
    if (prior === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prior;
    await rm(directory, { recursive: true, force: true });
  });
  const first = new Keychain(macKeychain());
  const second = new Keychain(macKeychain());
  const release = await first.lock("pi", "orchard");
  let entered = false;
  const next = second.lock("pi", "orchard").then((unlock) => {
    entered = true;
    return unlock;
  });
  const unrelated = await second.lock("pi", "other");
  assert.equal(entered, false);
  await unrelated();
  await release();
  await (await next)();
  assert.equal(entered, true);
  assert.deepEqual(await readdir(join(directory, "armada", "desktop", "keychain-locks")), []);
});

test("one gateway stores coordinator provider/key atomically and scopes Linear and GitHub entries", async () => {
  const backend = new FakeKeychain();
  const chain = new Keychain(backend);
  assert.deepEqual(await chain.status(), { provider: null, storage: "os-keychain" });
  const key = randomBytes(24).toString("hex");
  await chain.setCoordinator("anthropic", key);
  assert.deepEqual(await chain.coordinator(), { provider: "anthropic", key });
  await chain.setCoordinator("openai-compatible", key);
  assert.deepEqual(await new Keychain(backend).coordinator(), { provider: "openai-compatible", key });
  assert.deepEqual(await chain.status(), { provider: "openai-compatible", storage: "os-keychain" });
  await chain.write("linear", "harbor", key);
  await chain.write("github", "github", key);
  assert.equal(await chain.read("linear", "harbor"), key);
  assert.equal(await chain.read("linear", "other"), null);
  assert.equal(await chain.read("github", "github"), key);
  await assert.rejects(chain.setCoordinator("openai-compatible", `${key}\n`), /Invalid model credential/);
  assert.deepEqual(await chain.coordinator(), { provider: "openai-compatible", key });
});

test("Linux fallback persists private files, replaces atomically and refuses loose permissions or symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-keychain-"));
  const credentials = join(directory, "credentials");
  const key = randomBytes(24).toString("hex");
  try {
    const chain = new Keychain(fileKeychain(credentials));
    assert.equal(await chain.coordinator(), null);
    await chain.setCoordinator("openai-compatible", key);
    assert.deepEqual(await new Keychain(fileKeychain(credentials)).coordinator(), {
      provider: "openai-compatible",
      key,
    });
    assert.equal((await stat(credentials)).mode & 0o777, 0o700);
    const files = await readdir(credentials);
    assert.equal(files.length, 1);
    const file = join(credentials, files[0] as string);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await chain.setCoordinator("anthropic", key);
    assert.equal((await JSON.parse(await readFile(file, "utf8"))).provider, "anthropic");
    assert.deepEqual(await readdir(credentials), files);
    await chmod(file, 0o644);
    await assert.rejects(chain.coordinator(), /^Error: Credential lookup failed$/);
    await rm(file);
    await symlink(join(directory, "outside"), file);
    await assert.rejects(chain.coordinator(), /^Error: Credential lookup failed$/);
    await rm(file);
    await chmod(credentials, 0o755);
    await assert.rejects(chain.setCoordinator("openai-compatible", key), /^Error: Credential could not be saved$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux system storage accepts only trimmed absolute XDG roots, otherwise uses the private home config", {
  skip: process.platform !== "linux",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "armada-keychain-root-"));
  try {
    for (const xdg of ["", "relative", " ./relative ", ` ${join(directory, "absolute")} `]) {
      const home = join(directory, "home");
      const script = `
        import assert from "node:assert/strict";
        import { existsSync } from "node:fs";
        import { randomBytes } from "node:crypto";
        import { join, isAbsolute } from "node:path";
        import { systemKeychain } from ${JSON.stringify(new URL("../src/keychain.ts", import.meta.url).href)};
        const keychain = systemKeychain();
        await keychain.setCoordinator("openai-compatible", randomBytes(24).toString("hex"));
        assert.equal((await keychain.coordinator())?.provider, "openai-compatible");
        const linearKey = randomBytes(24).toString("hex");
        await keychain.write("linear", "orchard", linearKey);
        assert.equal((await keychain.read("linear", "orchard")) === linearKey, true);
        const asked = process.env.XDG_CONFIG_HOME.trim();
        const root = isAbsolute(asked) ? asked : join(process.env.HOME, ".config");
        assert.equal(existsSync(join(root, "armada", "desktop", "credentials")), true);
        assert.equal(existsSync(join(process.cwd(), "relative")), false);
        assert.equal(existsSync(join(process.cwd(), "armada")), false);
      `;
      const result = spawnSync("node", ["--input-type=module", "-e", script], {
        cwd: directory,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg },
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 0, result.stderr);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
