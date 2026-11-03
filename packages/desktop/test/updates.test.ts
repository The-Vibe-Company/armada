import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decide,
  NO_UPDATE_VARIABLE,
  redact,
  releasePage,
  signatureRefused,
  UpdateController,
  type Updater,
  type UpdateShell,
  type UpdateState,
  updatesEnabled,
} from "../src/updates.ts";

// Squirrel.Mac's refusals for an unsigned and an ad-hoc signed build (synthetic paths).
const UNSIGNED = new Error("Could not get code signature for running application");
const AD_HOC = new Error(
  "Code signature at URL file:///tmp/update.X/Armada.app/ did not pass validation: code failed to satisfy specified code requirement(s)",
);
const OFFLINE = new Error("net::ERR_INTERNET_DISCONNECTED");

test("updates run in an installed app only: never from source, headless or with ARMADA_DESKTOP_NO_UPDATE", () => {
  assert.equal(updatesEnabled({ packaged: true, headless: false, env: {} }), true);
  assert.equal(updatesEnabled({ packaged: true, headless: false, env: { [NO_UPDATE_VARIABLE]: "0" } }), true);
  assert.equal(updatesEnabled({ packaged: false, headless: false, env: {} }), false);
  assert.equal(updatesEnabled({ packaged: true, headless: true, env: {} }), false);
  for (const value of ["1", "true", "yes"])
    assert.equal(updatesEnabled({ packaged: true, headless: false, env: { [NO_UPDATE_VARIABLE]: value } }), false);
});

test("only Squirrel.Mac's signature refusals count as an unsigned build", () => {
  assert.equal(signatureRefused(UNSIGNED), true);
  assert.equal(signatureRefused(AD_HOC), true);
  assert.equal(signatureRefused(OFFLINE), false);
  assert.equal(signatureRefused(new Error("Cannot find latest-mac.yml in the latest release artifacts")), false);
});

test("the decision: restart once Squirrel holds a signed update, the release page when unsigned, once per version", () => {
  const none = new Set<string>();
  const cases: [boolean, boolean, UpdateState, ReadonlySet<string>, string][] = [
    [true, true, { kind: "idle" }, none, "silent"],
    [true, true, { kind: "downloading", version: "1.2.3" }, none, "silent"],
    [true, true, { kind: "ready", version: "1.2.3" }, none, "dialog-restart"],
    [true, true, { kind: "ready", version: "1.2.3" }, new Set(["1.2.3"]), "silent"],
    [true, false, { kind: "failed", version: "1.2.3", error: UNSIGNED }, none, "dialog-open-release"],
    [true, false, { kind: "failed", version: "1.2.3", error: UNSIGNED }, new Set(["1.2.3"]), "silent"],
    [true, false, { kind: "failed", error: UNSIGNED }, none, "silent"],
    [true, true, { kind: "failed", version: "1.2.3", error: OFFLINE }, none, "silent"],
    [false, true, { kind: "ready", version: "1.2.3" }, none, "silent"],
  ];
  for (const [packaged, signed, state, shown, expected] of cases)
    assert.equal(decide({ packaged, signed, state, shown }), expected, JSON.stringify({ packaged, signed, state }));
});

function harness(options: { restart?: boolean } = {}) {
  const calls: string[] = [];
  const updater: Updater = {
    checkForUpdates: async () => {
      calls.push("check");
      return { downloadPromise: Promise.reject(new Error("download failed")) };
    },
    quitAndInstall: () => calls.push("quitAndInstall"),
  };
  const shell: UpdateShell = {
    askRestart: async (version) => {
      calls.push(`ask ${version}`);
      return options.restart ?? false;
    },
    offerRelease: async (version, url) => {
      calls.push(`release ${version} ${url}`);
    },
    tellManual: async (outcome) => {
      calls.push(`manual ${outcome}`);
    },
    stopDaemon: async () => {
      await Promise.resolve();
      calls.push("daemon stopped");
    },
    shown: new Set(),
    remember: (shown) => calls.push(`remember ${[...shown].join(",")}`),
    log: () => {},
  };
  return { calls, controller: new UpdateController(updater, shell, true) };
}

test("a signed update asks once, and Restart now stops the daemon before installing", async () => {
  const { calls, controller } = harness({ restart: true });
  await controller.found("1.2.3");
  assert.deepEqual(calls, [], "nothing until Squirrel.Mac holds the update");
  await controller.ready();
  assert.deepEqual(calls, ["remember 1.2.3", "ask 1.2.3", "daemon stopped", "quitAndInstall"]);
});

test("Later asks nothing again for that version, even from the menu", async () => {
  const { calls, controller } = harness({ restart: false });
  await controller.found("1.2.3");
  await controller.ready();
  assert.deepEqual(calls, ["remember 1.2.3", "ask 1.2.3"]);
  calls.length = 0;
  await controller.check(true);
  await controller.found("1.2.3");
  await controller.ready();
  assert.deepEqual(calls, ["check"]);
});

test("an unsigned build offers the release page once; another failure shows nothing", async () => {
  const { calls, controller } = harness();
  await controller.found("1.2.3");
  await controller.failed(OFFLINE);
  assert.deepEqual(calls, []);
  await controller.found("1.2.3");
  await controller.failed(UNSIGNED);
  await controller.failed(UNSIGNED);
  assert.deepEqual(calls, [
    "remember 1.2.3",
    "release 1.2.3 https://github.com/The-Vibe-Company/armada/releases/tag/v1.2.3",
  ]);
});

test("a menu check with nothing new says so; an automatic one stays quiet", async () => {
  const { calls, controller } = harness();
  await controller.check(false);
  await controller.check(true);
  assert.deepEqual(calls, ["check", "check", "manual up-to-date"]);
});

test("release pages and log lines carry no query string and no non-version tag", () => {
  assert.equal(releasePage("1.2.3/../../evil"), null);
  assert.equal(
    redact("Downloading https://objects.example.test/a.zip?X-Amz-Signature=abc&token=def done"),
    "Downloading https://objects.example.test/a.zip done",
  );
});
