import { expect, test } from "bun:test";
import { dockerHostUpgradeMessage } from "../src/docker-host-upgrade.ts";

test("host upgrade guidance compares daemon against server and keeps unknown versions explicit", () => {
  for (const version of ["2.46.0", "2.49.5", "2.9.9", null]) {
    const message = dockerHostUpgradeMessage(version, "2.49.6");
    expect(message).toContain("server 2.49.6");
    expect(message).toContain("armada host add");
    expect(message).toContain("same Docker machine");
  }
  for (const version of ["2.49.6", "2.50.0", "3.0.0"]) {
    expect(dockerHostUpgradeMessage(version, "2.49.6")).toBeNull();
  }
  for (const server of ["2.50.0-next.1", "2.49.6+build.7"]) {
    expect(dockerHostUpgradeMessage("2.46.0", server)).toContain(`server ${server}`);
    expect(dockerHostUpgradeMessage("2.50.0", server)).toBeNull();
  }
  expect(dockerHostUpgradeMessage("2.46.0", undefined)).toBeNull();
  expect(dockerHostUpgradeMessage("2.46.0", "not-a-version")).toBeNull();
});
