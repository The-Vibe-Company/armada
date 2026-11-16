import { HARNESSES } from "@armada/core";

export function invalidAgentMessage(): string {
  return `Agent must be one of: ${HARNESSES.join(", ")}.`;
}
