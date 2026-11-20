import { expect, test } from "bun:test";
import { missingDeviceLoginConfiguration } from "./device-login-configuration.ts";

test.each([["production"], [["production"]]])(
  "checks the shared consent key in both projects and OAuth credentials only on the server (Vercel target %j)",
  (target) => {
    const railway = {
      ARMADA_CLI_CONSENT_KEY: "",
      ARMADA_CLI_OAUTH_CLIENT_ID: "fixture",
      ARMADA_CLI_OAUTH_CLIENT_SECRET: null,
    };
    const dashboardKey = { key: "ARMADA_CLI_CONSENT_KEY", value: "fixture" };

    expect(missingDeviceLoginConfiguration(railway, { envs: [{ ...dashboardKey, target: ["preview"] }] })).toEqual([
      "Railway server: ARMADA_CLI_CONSENT_KEY",
      "Vercel dashboard: ARMADA_CLI_CONSENT_KEY",
    ]);
    expect(missingDeviceLoginConfiguration({}, { envs: [] })).toContain("Railway server: ARMADA_CLI_OAUTH_CLIENT_ID");
    expect(missingDeviceLoginConfiguration({}, { envs: [] })).toContain(
      "Railway server: ARMADA_CLI_OAUTH_CLIENT_SECRET",
    );
    expect(
      missingDeviceLoginConfiguration(
        { ...railway, ARMADA_CLI_CONSENT_KEY: "fixture" },
        { envs: [{ ...dashboardKey, target }] },
      ),
    ).toEqual([]);
  },
);
