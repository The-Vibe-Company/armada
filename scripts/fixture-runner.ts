import { e2eFixture } from "./fixture-ports.ts";
import { assertLocalPortsAvailable } from "./local-ports.ts";

// Preflight at the CLI boundary, not config import: workers reload configs
// after the runner has started its own listeners.
assertLocalPortsAvailable([e2eFixture.mockPort, e2eFixture.dashboardPort]);
const child = Bun.spawn(["bun", "x", "--no-install", "e2e", "run", ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.exitCode = await child.exited;
