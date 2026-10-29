import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGINS } from "../packages/daemon/src/plugins/catalog.ts";

// Exercise the published Node bundle: plugins may import a separate copy of the SDK.
const build = Bun.spawn([process.execPath, "run", "--cwd", "packages/cli", "build"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
});
if ((await build.exited) !== 0) process.exit(1);

// Use the real command for every bundled plugin, including future providers.
for (const plugin of BUNDLED_PLUGINS) {
  const child = Bun.spawn(["node", "packages/cli/dist/armada.js", "plugin", "test", `packages/plugins/${plugin.id}`], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) process.exit(1);
}
