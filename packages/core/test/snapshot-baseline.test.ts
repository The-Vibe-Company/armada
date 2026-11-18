import { expect, test } from "bun:test";
import { snapshotBaselineVerify, snapshotBaselineVerifyAfterSetup } from "../src/snapshot-baseline.ts";

test("after repository setup, project toolchain pins on PATH pass while the baseline's fixed paths stay exact", () => {
  const pathPins = [
    `[ "$(node --version)" = 'v22.22.2' ]`,
    `[ "$(npm --version)" = '10.9.7' ]`,
    `[ "$(git --version)" = 'git version 2.52.0' ]`,
  ];
  for (const pin of pathPins) {
    expect(snapshotBaselineVerify).toContain(pin);
    expect(snapshotBaselineVerifyAfterSetup).not.toContain(pin);
  }
  for (const fixed of [
    `[ "$(/usr/bin/git --version)" = 'git version 2.52.0' ]`,
    `[ "$(/opt/armada/runtime-bun/bun --version)" = '1.4.2' ]`,
    "/usr/bin/python3 -c 'import sys; assert sys.version_info >= (3, 11)'",
    "/usr/bin/gh --version",
  ]) {
    expect(snapshotBaselineVerify).toContain(fixed);
    expect(snapshotBaselineVerifyAfterSetup).toContain(fixed);
  }
  for (const tool of ["node", "npm", "git", "bun", "jq", "ripgrep"])
    expect(snapshotBaselineVerifyAfterSetup).toContain(`echo 'ARMADA_BASELINE_1_FAILED ${tool}' >&2`);
});
