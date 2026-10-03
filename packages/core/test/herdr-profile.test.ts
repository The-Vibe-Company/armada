import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { herdrPermissionArgs, setHerdrPermissions } from "../src/herdr-profile.ts";
import { DEMO_TOML } from "./support.ts";

const profile = (
  harness: "claude" | "codex" | "opencode" | "deepseek",
  extraArgs: string[] = [],
  permissions?: "ask" | "full",
) => ({
  harness,
  model: "model",
  effort: "high",
  extraArgs,
  ...(permissions ? { permissions } : {}),
});

describe("Herdr profile permissions", () => {
  test("adds each native full-permission flag once and keeps unrelated arguments", () => {
    expect(herdrPermissionArgs(profile("claude", ["--verbose"], "full"))).toEqual([
      "--verbose",
      "--dangerously-skip-permissions",
    ]);
    expect(
      herdrPermissionArgs(profile("codex", ["--dangerously-bypass-approvals-and-sandbox", "-c", "x"], "full")),
    ).toEqual(["--dangerously-bypass-approvals-and-sandbox", "-c", "x"]);
    expect(herdrPermissionArgs(profile("opencode", ["--auto", "--verbose", "--auto"], "full"))).toEqual([
      "--auto",
      "--verbose",
    ]);
    expect(herdrPermissionArgs(profile("deepseek", [], "full"))).toEqual(["--auto"]);
  });

  test("omitted permissions preserve legacy explicit flags", () => {
    expect(herdrPermissionArgs(profile("claude", ["--dangerously-skip-permissions"]))).toEqual([
      "--dangerously-skip-permissions",
    ]);
    expect(herdrPermissionArgs(profile("codex", ["--dangerously-bypass-approvals-and-sandbox", "-c", "x"]))).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      "x",
    ]);
  });

  test("sets ask, removes the known legacy bypass, and leaves other profiles and comments alone", () => {
    const text = `${DEMO_TOML}
[herdr.profiles.codex] # selected
harness = "codex"
model = "gpt"
effort = "high"
extra_args = ["--dangerously-bypass-approvals-and-sandbox", "-c", "check_for_update_on_startup=false"] # keep update setting

[herdr.profiles.claude]
harness = "claude"
model = "opus"
effort = "high"
permissions = "full" # already chosen
extra_args = ["--dangerously-skip-permissions"]
`;
    const next = setHerdrPermissions(text, ["codex"], "ask");
    expect(next).toContain("[herdr.profiles.codex] # selected");
    expect(next).toContain('permissions = "ask"');
    expect(next).toContain('extra_args = ["-c", "check_for_update_on_startup=false"] # keep update setting');
    expect(next).toContain('permissions = "full" # already chosen');
    expect(parseConfig(next).herdr.profiles.codex).toEqual({
      harness: "codex",
      model: "gpt",
      effort: "high",
      permissions: "ask",
      extraArgs: ["-c", "check_for_update_on_startup=false"],
    });
    expect(parseConfig(next).herdr.profiles.claude?.permissions).toBe("full");
  });

  test("replaces only named existing permissions and handles a CRLF profile", () => {
    const text = `${DEMO_TOML}
[herdr.profiles.one]
harness = "opencode"
model = "m"
effort = "high"
permissions = 'ask' # keep this comment

[herdr.profiles.two]
harness = "deepseek"
model = "deepseek/model"
effort = "high"
`.replaceAll("\n", "\r\n");
    const next = setHerdrPermissions(text, ["two"], "full");
    expect(next).toContain("permissions = 'ask' # keep this comment");
    expect(next).toContain('permissions = "full"\r\n');
    expect(parseConfig(next).herdr.profiles.two?.permissions).toBe("full");
    expect(parseConfig(next).herdr.profiles.one?.permissions).toBe("ask");
  });
});
