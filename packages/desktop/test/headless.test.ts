import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  DATABASE_VARIABLE,
  daemonData,
  HEADLESS_VARIABLE,
  headlessDaemonEnv,
  headlessRequested,
  noDisplay,
  OZONE_HEADLESS_SWITCH,
  PROJECTS_VARIABLE,
  parseReadiness,
  readinessLine,
} from "../src/headless.ts";

test("ARMADA_DESKTOP_HEADLESS turns the headless shell on unless unset, 0 or false", () => {
  for (const value of ["1", "true", "yes", " on "])
    assert.equal(headlessRequested({ [HEADLESS_VARIABLE]: value }), true, `value ${JSON.stringify(value)}`);
  for (const value of [undefined, "", " ", "0", "false", "FALSE"])
    assert.equal(headlessRequested({ [HEADLESS_VARIABLE]: value }), false, `value ${JSON.stringify(value)}`);
});

test("the daemon's data is the explicit catalog and log, else under the user data; headless takes explicit paths only", () => {
  const userData = join("/Users", "owner", "Library", "Application Support", "Armada");
  assert.deepEqual(daemonData({}, userData, false), {
    projects: join(userData, "projects.json"),
    database: join(userData, "fleet.sqlite"),
  });
  const explicit = { [PROJECTS_VARIABLE]: "/tmp/fleet/projects.json", [DATABASE_VARIABLE]: "/tmp/fleet/fleet.sqlite" };
  assert.deepEqual(daemonData(explicit, userData, false), {
    projects: "/tmp/fleet/projects.json",
    database: "/tmp/fleet/fleet.sqlite",
  });
  assert.deepEqual(daemonData(explicit, userData, true), {
    projects: "/tmp/fleet/projects.json",
    database: "/tmp/fleet/fleet.sqlite",
  });
  // A headless shell never falls back to the account's own fleet.
  for (const env of [{}, { [PROJECTS_VARIABLE]: "/tmp/fleet/projects.json" }, { [DATABASE_VARIABLE]: " " }])
    assert.throws(() => daemonData(env, userData, true), {
      message: `${HEADLESS_VARIABLE} needs ${PROJECTS_VARIABLE} and ${DATABASE_VARIABLE}: a headless shell never opens this account's own fleet`,
    });
});

test("a headless shell's daemon gets its own configuration, app config and file keychain under the shell's directory; explicit values win", () => {
  const dataDir = join("/tmp", "armada-desktop-headless-abc");
  assert.deepEqual(headlessDaemonEnv({ PATH: "/usr/bin", HOME: undefined }, dataDir), {
    XDG_CONFIG_HOME: join(dataDir, "config"),
    ARMADA_APP_CONFIG: join(dataDir, "config.json"),
    ARMADA_KEYCHAIN: "file",
    PATH: "/usr/bin",
  });
  const explicit = {
    XDG_CONFIG_HOME: "/tmp/elsewhere",
    ARMADA_APP_CONFIG: "/tmp/elsewhere/app.json",
    ARMADA_KEYCHAIN: "native",
  };
  assert.deepEqual(headlessDaemonEnv(explicit, dataDir), explicit);
  // An empty value is unset, never a fall-back to the account's own paths.
  assert.equal(headlessDaemonEnv({ XDG_CONFIG_HOME: "", ARMADA_KEYCHAIN: "" }, dataDir).ARMADA_KEYCHAIN, "file");
  assert.equal(headlessDaemonEnv({ XDG_CONFIG_HOME: "" }, dataDir).XDG_CONFIG_HOME, join(dataDir, "config"));
});

test("only Linux without a display server needs Chromium's headless platform, passed by the launcher", () => {
  assert.equal(OZONE_HEADLESS_SWITCH, "--ozone-platform=headless");
  assert.equal(noDisplay("linux", {}), true);
  assert.equal(noDisplay("linux", { DISPLAY: ":99" }), false);
  assert.equal(noDisplay("linux", { WAYLAND_DISPLAY: "wayland-0" }), false);
  assert.equal(noDisplay("darwin", {}), false);
  assert.equal(noDisplay("win32", {}), false);
});

test("the readiness line round-trips and any other stdout line is ignored", () => {
  const readiness = {
    headless: true as const,
    url: "http://127.0.0.1:4831",
    wsUrl: "ws://127.0.0.1:4831/",
    windows: 0,
    dockVisible: false,
  };
  assert.deepEqual(parseReadiness(readinessLine(readiness)), readiness);
  for (const line of ['{"starting":true}', '{"headless":false}', "not json", '{"headless":true,"url":1}'])
    assert.equal(parseReadiness(line), null);
});
