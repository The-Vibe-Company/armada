import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { systemKeychain } from "../src/keychain.ts";

test("test runners default to isolated file credentials before daemon imports", async () => {
  // Assert the selector before status(), so a missing preload never reads the OS keychain.
  assert.equal(process.env.ARMADA_KEYCHAIN, "file");
  assert.ok(process.env.XDG_CONFIG_HOME);
  assert.equal((await systemKeychain().status()).storage, "file");
});

test("shared daemon child environments select file credentials on every platform", async () => {
  const { daemonEnv, nodeExecutable } = await import("./support/node.ts");
  const directory = mkdtempSync(join(tmpdir(), "armada-child-keychain-"));
  try {
    const script = `
      import assert from "node:assert/strict";
      import { systemKeychain } from ${JSON.stringify(new URL("../src/keychain.ts", import.meta.url).href)};
      assert.equal(process.env.ARMADA_KEYCHAIN, "file");
      assert.equal(process.env.XDG_CONFIG_HOME, ${JSON.stringify(directory)});
      for (const platform of ["darwin", "linux", "win32"]) {
        Object.defineProperty(process, "platform", {value: platform});
        assert.equal((await systemKeychain().status()).storage, "file");
      }
    `;
    const child = spawnSync(nodeExecutable, ["--input-type=module", "-e", script], {
      env: daemonEnv(directory),
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Security contract: a new scratch environment must not undo runner isolation.
// Parse launch options so unrelated env objects (provider config, credentials)
// and braces inside inline Node preloads cannot mask a missing selector.
test("test daemon launches inherit the preload or explicitly isolate credentials", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const offenders: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", "out", ".next"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!/[/\\]test[/\\].*\.[cm]?[jt]sx?$/.test(path)) continue;
      const text = await readFile(path, "utf8");
      if (!/armadad|src\/index\.ts|server\/main/.test(text)) continue;
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      const bindings = new Map<string, ts.Expression>();
      const collect = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
          bindings.set(node.name.text, node.initializer);
        ts.forEachChild(node, collect);
      };
      collect(source);
      const daemonTarget = (node: ts.Node, seen = new Set<string>()): boolean => {
        if (ts.isStringLiteralLike(node) && /armadad|src\/index\.ts|server\/main/.test(node.text)) return true;
        if (ts.isIdentifier(node) && !seen.has(node.text)) {
          const binding = bindings.get(node.text);
          if (binding && daemonTarget(binding, new Set(seen).add(node.text))) return true;
        }
        return !!ts.forEachChild(node, (child) => daemonTarget(child, seen) || undefined);
      };
      const checkEnvironment = (options: ts.ObjectLiteralExpression) => {
        const env = options.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(source) === "env");
        if (!env || !ts.isPropertyAssignment(env)) return; // Omitted env inherits process.env or spread options.
        const value = env.initializer;
        const inherited = (expression: ts.Expression) =>
          expression.getText(source) === "process.env" ||
          (ts.isCallExpression(expression) && expression.expression.getText(source) === "daemonEnv");
        if (inherited(value)) return;
        if (ts.isObjectLiteralExpression(value)) {
          if (value.properties.some((p) => ts.isSpreadAssignment(p) && inherited(p.expression))) return;
          const keys = value.properties.filter(ts.isPropertyAssignment).map((p) => p.name.getText(source));
          if (keys.includes("ARMADA_KEYCHAIN") && keys.includes("XDG_CONFIG_HOME")) return;
        }
        const line = source.getLineAndCharacterOfPosition(env.getStart(source)).line + 1;
        const location = `${relative(root, path)}:${line}`;
        if (!offenders.includes(location)) offenders.push(location);
      };
      const inspect = (node: ts.Node) => {
        // Inspect fixture options where they are defined, including function returns
        // later passed as f.options or spread into a DaemonProcess constructor.
        if (
          ts.isObjectLiteralExpression(node) &&
          node.properties.some(
            (p) => ts.isPropertyAssignment(p) && p.name.getText(source) === "entry" && daemonTarget(p.initializer),
          )
        )
          checkEnvironment(node);
        if (
          (ts.isCallExpression(node) &&
            /^(?:(?:Bun\.)?spawn(?:Sync)?|execFile(?:Sync)?)$/.test(node.expression.getText(source)) &&
            daemonTarget(node)) ||
          (ts.isNewExpression(node) && node.expression.getText(source) === "DaemonProcess")
        ) {
          for (const argument of node.arguments ?? [])
            if (ts.isObjectLiteralExpression(argument)) checkEnvironment(argument);
        }
        ts.forEachChild(node, inspect);
      };
      inspect(source);
    }
  };
  await visit(join(root, "packages"));
  assert.deepEqual(offenders, [], "daemon test env must inherit process.env/daemonEnv or set both credential fields");
});

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
