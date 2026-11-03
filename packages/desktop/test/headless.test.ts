import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  DATABASE_VARIABLE,
  daemonData,
  HEADLESS_VARIABLE,
  headlessRequested,
  noDisplay,
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

test("only Linux without a display server takes Chromium's headless platform", () => {
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
