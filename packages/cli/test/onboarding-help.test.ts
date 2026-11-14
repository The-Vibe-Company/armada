import { expect, test } from "bun:test";
import { onboardingHelp } from "../src/onboarding-help.ts";
import { run } from "../src/run.ts";

test("nested onboarding help is focused and performs no authenticated or secret I/O", async () => {
  for (const command of [
    "org setup",
    "mcp connect",
    "mcp reconnect",
    "mcp revoke",

    "mcp list",
    "mcp catalog",
    "mcp status",
    "mcp sandbox-connections",

    "account status",
    "account logout",
    "logout",
    "github connect",
    "github reconnect",
    "github install",

    "github status",
    "github manage",
    "github refresh",
    "github disconnect",

    "token create",
    "token list",
    "token revoke",

    "org invitations create",
    "org invitations list",
    "org invitations resend",
    "org invitations revoke",
    "org invitations accept",

    "org members list",
    "org members add",
    "org members role",
    "org members remove",

    "org list",
    "org use",
    "org current",
    "org create",

    "org connect modal",
    "org connect",
    "org connect boat",
    "creds login codex",
    "creds login",
    "creds import",
    "creds import claude",
    "creds import codex",
    "creds set",
    "creds presets",
    "creds connect",
    "creds test",
    "creds list",
    "creds rename",
    "creds default",
    "creds remove",
    "creds rm",

    "golden create",
    "snapshot create",
    "snapshot update",
    "golden update",
    "host add",
    "host list",
    "host show",
    "host limits",
    "host revoke",

    "snapshot build-find",
    "snapshot build-status",
    "snapshot build-cancel",
    "golden build-find",
    "golden build-status",
    "golden build-cancel",
    "snapshot list",
    "golden list",
    "snapshot capabilities",
    "golden capabilities",
    "snapshot connect",
    "golden connect",
    "snapshot snapshot",
    "golden snapshot",
    "snapshot remove",
    "golden remove",
    "snapshot visibility",
    "golden visibility",
    "snapshot get",
    "golden get",
    "snapshot rebuild",
    "golden rebuild",
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
        `Usage: armada ${command.replace(/^golden (get|rebuild|create|update|size-policy|build-find|build-status|build-cancel|list|capabilities|connect|snapshot|remove|visibility)$/, "snapshot $1")}`,
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
    ["snapshot", "list", "--provider", "--help"],
    ["snapshot", "capabilities", "--", "-h"],
    ["snapshot", "remove", "starter", "--help"],
    ["snapshot", "visibility", "--visibility", "-h"],
    ["snapshot", "create", "starter", "--help"],
    ["snapshot", "update", "--config", "-h"],
    ["snapshot", "get", "snapshot-id", "--help"],
    ["snapshot", "rebuild", "--request-id", "-h"],
    ["creds", "rename", "account-id", "--help"],
    ["creds", "remove", "--org", "-h"],
    ["creds", "import", "claude", "--file", "-h"],
    ["creds", "import", "--", "--help"],
    ["creds", "connect", "openai", "--help"],
    ["creds", "test", "--model", "-h"],
    ["org", "use", "my-team", "--help"],
    ["org", "create", "--", "-h"],
    ["org", "members", "role", "teammate@example.com", "--help"],
    ["org", "members", "add", "--role", "-h"],
    ["org", "invitations", "accept", "--file", "-h"],
    ["org", "invitations", "accept", "--", "--help"],
    ["org", "connect", "boat", "--file", "-h"],
    ["org", "connect", "boat", "--", "--help"],
    ["token", "revoke", "token-id", "--help"],
    ["token", "create", "--label", "-h"],
    ["github", "manage", "installation-id", "--help"],
    ["github", "refresh", "--", "-h"],
    ["github", "connect", "--timeout", "-h"],
    ["github", "install", "--", "--help"],
    ["account", "status", "--", "--help"],
    ["logout", "extra", "-h"],
    ["host", "show", "workstation", "--help"],
    ["host", "limits", "--memory", "-h"],
    ["mcp", "status", "connection-id", "--help"],
    ["mcp", "sandbox-connections", "--org", "-h"],
    ["mcp", "connect", "--timeout", "-h"],
    ["mcp", "revoke", "connection-id", "--help"],
    ["constructor", "--help"],
    ["toString", "-h"],
  ])
    expect(onboardingHelp(argv)).toBeUndefined();
});
