import { GoldenError, HARNESSES, type Harness } from "@armada/core";

export function requireLaunchAgent(value: string | undefined): Harness {
  const harness = HARNESSES.find((candidate) => candidate === value);
  if (!harness) throw new GoldenError("invalid_config", `Pass --agent ${HARNESSES.join(" or ")}.`);
  return harness;
}

export function invalidAgentMessage(): string {
  return `Agent must be one of: ${HARNESSES.join(", ")}.`;
}
