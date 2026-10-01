import { describe, expect, test } from "bun:test";
import { configTemplate, parseConfig } from "../src/config.ts";
import { chooseProfile, ProfileError } from "../src/routing.ts";
import { DEMO_TOML } from "./support.ts";

// The template's routing: web → opus, api → codex, Bug → debug, default opus.
const routed = parseConfig(
  configTemplate({ name: "Widgets", slug: "widgets", programRoot: "DEMO-1", repository: "acme/widgets" }).replace(
    /^when = .*\n/gm,
    "",
  ),
);
const choose = (labels: string[], requested: string | null = null, reason: string | null = null) =>
  chooseProfile(routed, { ticket: "DEMO-7", labels, requested, reason });

describe("choosing a worker's profile", () => {
  test("plain-language rules defer unmatched tickets to the coordinator, even with a default or only profile", () => {
    const semantic = parseConfig(
      configTemplate({ name: "Widgets", slug: "widgets", programRoot: "DEMO-1", repository: "acme/widgets" }),
    );
    const pick = (labels: string[], requested: string | null = null, reason: string | null = null) =>
      chooseProfile(semantic, { ticket: "DEMO-7", labels, requested, reason });
    expect(pick(["web"])).toMatchObject({ name: "opus", source: "rule" });
    expect(() => pick([])).toThrow('armada brief DEMO-7 --profile <name> --reason "<why>"');
    expect(() => pick([], "codex")).toThrow('--reason "<why>"');
    expect(pick([], "codex", "  CLI and core\n rules (back end) ")).toMatchObject({
      name: "codex",
      routed: null,
      reason: "CLI and core rules (back end)",
      why: "Chosen by the coordinator: CLI and core rules (back end)",
    });
    const only = parseConfig(
      `${DEMO_TOML}\n[conductor.profiles.backend]\nagent = "codex"\nmodel = "m"\neffort = "high"\nwhen = "back end"\n`,
    );
    expect(() => chooseProfile(only, { ticket: "DEMO-7", labels: [], requested: null, reason: null })).toThrow(
      "Choose a profile",
    );
  });

  test("the first rule in file order wins, whatever the order of the ticket's labels; labels ignore case", () => {
    expect(choose(["api"])).toMatchObject({
      name: "codex",
      source: "rule",
      rule: { index: 2, labels: ["api"], label: "api" },
      why: 'rule 2 of [[conductor.routing]] (label "api")',
    });
    expect(choose(["bug", "web"])).toMatchObject({ name: "opus", rule: { index: 1, label: "web" } });
    expect(choose(["Feature", "BUG"])).toMatchObject({ name: "debug", profile: { effort: "xhigh" } });
    // Letters of any script count; other characters do not make two names equal.
    const scripts = parseConfig(
      `${DEMO_TOML}[conductor]\ndefault_profile = "a"\n[conductor.profiles.a]\nagent = "x"\nmodel = "y"\neffort = "z"\n[[conductor.routing]]\nlabels = ["前端", "Élevé"]\nprofile = "a"\n`,
    );
    const source = (labels: string[]) =>
      chooseProfile(scripts, { ticket: "DEMO-7", labels, requested: null, reason: null })?.source;
    expect([source(["后端"]), source(["Eleve"]), source(["élevé"]), source(["前端"])]).toEqual([
      "default",
      "default",
      "rule",
      "rule",
    ]);
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
    const withDefault = `${DEMO_TOML}[conductor]\ndefault_profile = "b"\n${profile("a")}${profile("b")}`;
    expect(pick(withDefault)).toMatchObject({ name: "b", why: "conductor.default_profile" });
    // With no routing rule, the default is only a default: another profile needs no reason.
    expect(pick(withDefault, "a")).toMatchObject({
      name: "a",
      routed: "b",
      reason: null,
      why: '--profile, instead of "b" from conductor.default_profile',
    });
    expect(pick(DEMO_TOML + profile("a"))).toMatchObject({ name: "a", source: "only" });
    expect(pick(DEMO_TOML)).toBeNull();
  });
});
