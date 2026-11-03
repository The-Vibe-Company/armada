import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import config from "../electron-builder.ts";
import {
  APP_ID,
  ENTITLEMENTS,
  NOTARIZATION_VARIABLES,
  PRODUCT_NAME,
  packagingConfig,
  SIGNING_VARIABLES,
} from "../src/packaging.ts";
import { shellPaths } from "../src/paths.ts";

const desktop = fileURLToPath(new URL("..", import.meta.url));

test("the shell's three paths resolve under the bundle's resources when packaged, under the checkout otherwise", () => {
  const resourcesPath = join("/Applications", "Armada.app", "Contents", "Resources");
  const packaged = shellPaths({
    packaged: true,
    resourcesPath,
    mainUrl: pathToFileURL(join(resourcesPath, "app.asar", "out", "main", "index.js")).href,
  });
  assert.deepEqual(packaged, {
    staticDir: join(resourcesPath, "app"),
    icon: join(resourcesPath, "icon.png"),
    daemonEntry: join(resourcesPath, "app.asar.unpacked", "out", "main", "armadad.js"),
  });
  // What electron-builder puts there: the extra resources and the unpacked daemon entry.
  const extras = packagingConfig({}).extraResources as { from: string; to: string }[];
  assert.deepEqual(
    extras.map((resource) => resource.to),
    [relative(resourcesPath, packaged.staticDir), relative(resourcesPath, packaged.icon)],
  );
  const unpacked = packagingConfig({}).asarUnpack as string[];
  const entry = relative(join(resourcesPath, "app.asar.unpacked"), packaged.daemonEntry);
  assert.ok(unpacked.includes(`${dirname(entry)}/**`), "the daemon entry and its chunks leave the asar");

  const checkout = shellPaths({
    packaged: false,
    resourcesPath,
    mainUrl: pathToFileURL(join(desktop, "out", "main", "index.js")).href,
  });
  assert.deepEqual(checkout, {
    staticDir: join(desktop, "..", "app", "dist", "/"),
    icon: join(desktop, "resources", "icon.png"),
    daemonEntry: join(desktop, "out", "main", "armadad.js"),
  });
  assert.ok(existsSync(checkout.icon));
});

test("electron-builder packages Armada for macOS arm64 as a dmg and a zip, unsigned unless a certificate is named", () => {
  const unsigned = packagingConfig({});
  assert.equal(unsigned.appId, APP_ID);
  assert.equal(unsigned.productName, PRODUCT_NAME);
  assert.equal(unsigned.asar, true);
  const unpacked = unsigned.asarUnpack as string[];
  assert.ok(unpacked.some((pattern) => pattern.includes("@napi-rs/keyring")));
  assert.deepEqual(unsigned.mac?.target, [
    { target: "dmg", arch: ["arm64"] },
    { target: "zip", arch: ["arm64"] },
  ]);
  assert.equal(unsigned.mac?.icon, "resources/icon.icns");
  assert.ok(existsSync(join(desktop, unsigned.mac?.icon ?? "")));
  assert.deepEqual(unsigned.publish, { provider: "github", owner: "The-Vibe-Company", repo: "armada" });
  assert.equal(unsigned.directories?.output, "release");

  assert.equal(unsigned.mac?.identity, null, "no certificate: electron-builder must not look for one");
  assert.equal(unsigned.mac?.hardenedRuntime, true);
  assert.equal(unsigned.mac?.entitlements, ENTITLEMENTS);
  assert.equal(unsigned.mac?.entitlementsInherit, ENTITLEMENTS);
  const entitlements = readFileSync(join(desktop, ENTITLEMENTS), "utf8");
  assert.match(entitlements, /<key>com\.apple\.security\.network\.client<\/key>\s*<true\/>/);
  assert.doesNotMatch(entitlements, /app-sandbox/);

  for (const name of SIGNING_VARIABLES) {
    const signed = packagingConfig({ [name]: "set" });
    assert.equal("identity" in (signed.mac ?? {}), false, `${name} turns signing on`);
  }
  assert.equal(packagingConfig({ CSC_LINK: "  " }).mac?.identity, null, "a blank variable does not");

  // Notarisation needs the Apple account, the app-specific password and the team: all three or none.
  assert.equal(unsigned.mac?.notarize, false, "no Apple account: electron-builder must not try notarytool");
  const apple = Object.fromEntries(NOTARIZATION_VARIABLES.map((name) => [name, "set"]));
  assert.equal(packagingConfig(apple).mac?.notarize, true);
  for (const name of NOTARIZATION_VARIABLES) {
    assert.equal(packagingConfig({ ...apple, [name]: " " }).mac?.notarize, false, `${name} missing turns it off`);
  }

  // The file electron-builder reads hands the rules the process environment.
  assert.deepEqual(config, packagingConfig(process.env));
});
