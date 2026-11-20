import { expect, test } from "bun:test";
import { boatRuntimeBootstrapScript } from "../src/runtime-bootstrap.ts";

test("the remote bootstrap requires a verified system Node before dispatching the ticket", () => {
  const script = boatRuntimeBootstrapScript("https://armada.invalid", { sha256: "a".repeat(64), bytes: 1 }, "/cache");
  expect(script).toMatch(
    /if ! runtime_node=\$\(find_runtime_node\); then\s+install_runtime_node[^\n]+\|\| exit 1\s+runtime_node=\$\(find_runtime_node\) \|\| exit 1\s+fi\s+printf '%s' "\$ARMADA_GIT_TOKEN" \| \(unset ARMADA_GIT_TOKEN ARMADA_SSH_PUBLIC_KEY; exec "\$runtime_node" -e /,
  );
});
