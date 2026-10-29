import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Architecture/security contract requested by THE-1995: new providers must not bypass the gateway.
test("only the credential gateway imports storage adapters; only native adapter accesses OS keychain", async () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const paths = await readdir(root, { recursive: true });
  const offenders: string[] = [];
  let native = false;
  let gateway = false;
  for (const path of paths.filter((p) => p.endsWith(".ts"))) {
    const text = await readFile(join(root, path), "utf8");
    const name = relative(root, join(root, path)).replaceAll("\\", "/");
    if (name === "secrets/macos.ts") {
      native = text.includes("@napi-rs/keyring") && text.includes(".getPassword(");
      continue;
    }
    if (/@napi-rs\/keyring|find-generic-password|\.getPassword\s*\(/.test(text)) offenders.push(name);
    if (name === "keychain.ts") {
      gateway = text.includes("this.#backend.read(");
      continue;
    }
    if (
      !name.startsWith("secrets/") &&
      /["'][^"']*secrets\/(?:backend|file|macos)(?:\.ts)?["']|#backend\.read\s*\(/.test(text)
    )
      offenders.push(name);
  }
  assert.equal(native, true);
  assert.equal(gateway, true);
  assert.deepEqual(offenders, []);
});
