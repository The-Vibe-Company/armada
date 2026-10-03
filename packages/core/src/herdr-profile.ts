import type { HerdrProfileChoice, ProfileChoice } from "./routing.ts";

/** Existing brief/fleet profile fields, with the local harness as the agent. */
export function herdrChoice(choice: HerdrProfileChoice): ProfileChoice {
  return {
    ...choice,
    profile: {
      runtime: "herdr",
      agent: choice.profile.harness,
      model: choice.profile.model,
      effort: choice.profile.effort,
      fastMode: false,
    },
  };
}

/** Opaque claim handle; all three identifiers come from the herdr response. */
export const herdrClaimHandle = (handle: { workspace: string; pane: string; agent: string }): string =>
  JSON.stringify({ workspace: handle.workspace, pane: handle.pane, agent: handle.agent });
