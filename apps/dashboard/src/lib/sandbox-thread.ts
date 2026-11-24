import { isSandboxPlacementProvider } from "@armada/core";
import { capabilities } from "@armada/core/machine-capabilities";

export function sandboxUsesRuntime(sandbox: {
  provider: string | null;
  boat_runtime: boolean;
  runtime_transport: string | null;
}) {
  return (
    (isSandboxPlacementProvider(sandbox.provider) && capabilities(sandbox.provider).launchSource === "host") ||
    sandbox.boat_runtime ||
    sandbox.runtime_transport === "dialout"
  );
}
