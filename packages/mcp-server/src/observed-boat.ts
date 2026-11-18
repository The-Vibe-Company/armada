import { createBoatProvider } from "@armada/provider-boat";
import { observeProvider } from "./request-observability.ts";

export function createObservedBoatProvider(options: Parameters<typeof createBoatProvider>[0], sandboxId?: string) {
  return observeProvider("boat", createBoatProvider(options), { sandboxId: () => sandboxId });
}
