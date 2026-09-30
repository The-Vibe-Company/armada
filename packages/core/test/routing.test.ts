import { describe, expect, test } from "bun:test";
import { configTemplate, parseConfig } from "../src/config.ts";
import { chooseProfile, ProfileError } from "../src/routing.ts";
import { DEMO_TOML } from "./support.ts";

// The template's routing: web → opus, api → codex, Bug → debug, default opus.
const routed = parseConfig(
  configTemplate({ name: "Widgets", slug: "widgets", programRoot: "DEMO-1", repository: "acme/widgets" }),
);
const choose = (labels: string[], requested: string | null = null, reason: string | null = null) =>
  chooseProfile(routed, { ticket: "DEMO-7", labels, requested, reason });

describe("choosing a worker's profile", () => {
  test("the first rule in file order wins, whatever the order of the ticket's labels; labels ignore case", () => {
    expect(choose(["api"])).toMatchObject({
      name: "codex",
      source: "rule",
      rule: { index: 2, labels: ["api"], label: "api" },
      why: 'rule 2 of [[conductor.routing]] (label "api")',
    });
    expect(choose(["bug", "web"])).toMatchObject({ name: "opus", rule: { index: 1, label: "web" } });
    expect(choose(["Feature", "BUG"])).toMatchObject({ name: "debug", profile: { effort: "xhigh" } });
  });

  test("a ticket no rule matches gets default_profile", () => {
    expect(choose(["docs"])).toMatchObject({
      name: "opus",
      source: "default",
      rule: null,
      why: "conductor.default_profile (no routing rule matched)",
    });
  });

  test("--profile wins over the route, and an override of the route needs a reason", () => {
    expect(() => choose(["web"], "codex")).toThrow(
      new ProfileError(
        'DEMO-7 is routed to "opus" by rule 1 of [[conductor.routing]] (label "web"); say why "codex" instead with --reason "<why>"',
      ),
    );
    expect(choose(["web"], "codex", "  a back-end bug\n behind a web label ")).toMatchObject({
      name: "codex",
      source: "requested",
      routed: "opus",
      reason: "a back-end bug behind a web label",
      why: '--profile, instead of "opus" from rule 1 of [[conductor.routing]] (label "web"): a back-end bug behind a web label',
    });
    // Asking for the routed profile is no override.
    expect(choose(["web"], "opus")).toMatchObject({ source: "rule", routed: "opus", reason: null });
    expect(() => choose(["web"], "turbo")).toThrow('no Conductor profile "turbo" (available: opus, codex, debug)');
  });

  test("without routing: default_profile, else the only profile; several and no default must be named", () => {
    const profile = (name: string) =>
      `\n[conductor.profiles.${name}]\nagent = "claude"\nmodel = "m-${name}"\neffort = "high"\n`;
    const pick = (toml: string, requested: string | null = null) =>
      chooseProfile(parseConfig(toml), { ticket: "DEMO-7", labels: ["web"], requested, reason: null });
    const two = DEMO_TOML + profile("a") + profile("b");
    expect(pick(two, "b")).toMatchObject({ name: "b", source: "requested", routed: null, why: "--profile" });
    expect(() => pick(two)).toThrow(
      "several Conductor profiles and no conductor.default_profile; pass --profile (a, b)",
    );
    expect(() => pick(two, "toString")).toThrow(ProfileError);
    expect(pick(`${DEMO_TOML}[conductor]\ndefault_profile = "b"\n${profile("a")}${profile("b")}`)).toMatchObject({
      name: "b",
      why: "conductor.default_profile",
    });
    expect(pick(DEMO_TOML + profile("a"))).toMatchObject({ name: "a", source: "only" });
    expect(pick(DEMO_TOML)).toBeNull();
  });
});
