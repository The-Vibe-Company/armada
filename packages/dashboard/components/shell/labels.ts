// How an agent's state reads, in the viewer's language.
import type { AgentPhase } from "@armada/core/read";
import type { AgentState } from "@/lib/fleet-view";
import type { Strings } from "@/lib/i18n";

/** "Attend ta réponse", "CI rouge"… or, at work, its phase: "Implémentation". */
export const stateLabel = (t: Strings, state: AgentState, phase: AgentPhase) =>
  state.reason === "phase" ? t.shell.phases[phase] : t.shell.reasons[state.reason];
