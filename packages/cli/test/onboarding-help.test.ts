import { expect, test } from "bun:test";
import { onboardingHelp } from "../src/onboarding-help.ts";
import { run } from "../src/run.ts";

test("nested onboarding help is focused and performs no authenticated or secret I/O", async () => {
  for (const command of [
    "org setup",
    "org connect modal",
    "creds login codex",
    "creds set",
    "golden create",
    "host add",
    "snapshot build-find",
    "snapshot build-status",
    "snapshot build-cancel",
    "golden build-find",
    "golden build-status",
    "golden build-cancel",
    "snapshot size-policy",
    "golden size-policy",
  ]) {
    for (const flag of ["--help", "-h"]) {
      let out = "";
      let err = "";
      const forbidden = () => {
        throw new Error("Help attempted I/O");
      };
      const code = await run(
        ["--profile", "new-user", ...command.split(" "), flag],
        {
          out: (value) => {
            out += value;
          },
          err: (value) => {
            err += value;
          },
        },
        { env: {}, fetch: Object.assign(forbidden, { preconnect: forbidden }), readStdin: forbidden },
      );
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(out).toContain(
        `Usage: armada ${command.replace(/^golden (size-policy|build-find|build-status|build-cancel)$/, "snapshot $1")}`,
      );
      expect(out).toContain("Example: armada");
    }
  }
});

test("help detection leaves malformed operations and literal payloads to their parsers", () => {
  for (const argv of [
    ["org", "connect", "modal", "--file", "--help"],
    ["golden", "create", "name", "--help"],
    ["creds", "set", "--help", "--unknown"],
    ["exec", "sandbox", "--", "--help"],
    ["send", "sandbox", "--help"],
    ["org", "setup", "--", "--help"],
    ["snapshot", "size-policy", "starter", "--help"],
    ["snapshot", "size-policy", "--file", "-h"],
    ["snapshot", "size-policy", "--", "--help"],
    ["constructor", "--help"],
    ["toString", "-h"],
  ])
    expect(onboardingHelp(argv)).toBeUndefined();
});
