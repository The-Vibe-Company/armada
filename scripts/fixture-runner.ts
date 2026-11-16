import { assertLocalPortsAvailable } from "./local-ports.ts";

// Preflight at the CLI boundary, not config import: workers reload configs
// after the runner has started its own listeners.
assertLocalPortsAvailable([54399, 3100]);
const runner = process.argv[2];
if (runner !== "playwright" && runner !== "e2e") throw new Error("Expected playwright or e2e runner");
const child = Bun.spawn(
  ["bun", "x", "--no-install", runner, ...(runner === "e2e" ? ["run"] : ["test"]), ...process.argv.slice(3)],
  {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.exitCode = await child.exited;
