import { HARNESSES } from "@armada/core";
export function agentHint(): string {
  return `Pass --agent ${HARNESSES.join(" or ")}.`;
}
