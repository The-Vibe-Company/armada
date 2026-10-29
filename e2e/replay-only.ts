import { AgentError, type StepExecutor } from "e2e";

export const CACHE_MISS =
  "No model configured; unrecorded agent step skipped. Record it with the project's vault secrets.";

// e2e 0.21 preflights the built-in agent before replay, even without a model.
// A custom executor lets the harness replay first and only handles cache misses.
export const replayOnly: StepExecutor = {
  name: "replay-only",
  async runStep() {
    throw new AgentError("MODEL_UNAVAILABLE", CACHE_MISS);
  },
};
