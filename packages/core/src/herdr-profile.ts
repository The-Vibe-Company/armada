import type { HerdrHarness } from "./config.ts";
import type { HerdrProfileChoice, ProfileChoice } from "./routing.ts";

/** Actual Herdr kind; native dsh needs resumable input first (THE-949). */
export const herdrHarnessKind = (harness: HerdrHarness): Exclude<HerdrHarness, "deepseek"> =>
  harness === "deepseek" ? "opencode" : harness;

export const herdrHarnessLabel = (harness: HerdrHarness): string =>
  harness === "deepseek" ? "deepseek (OpenCode + DeepSeek provider)" : harness;

/** Existing brief/fleet profile fields, with the local harness as the agent. */
export function herdrChoice(choice: HerdrProfileChoice): ProfileChoice {
  return {
    ...choice,
    profile: {
      runtime: "herdr",
      agent: herdrHarnessLabel(choice.profile.harness),
      model: choice.profile.model,
      effort: choice.profile.effort,
      fastMode: false,
    },
  };
}

/** Opaque claim handle; all three identifiers come from the herdr response. */
export const herdrClaimHandle = (handle: { workspace: string; pane: string; agent: string }): string =>
  JSON.stringify({ workspace: handle.workspace, pane: handle.pane, agent: handle.agent });
