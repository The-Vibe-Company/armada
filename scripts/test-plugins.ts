import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGINS } from "../packages/daemon/src/plugins/catalog.ts";

// Use the real command for every bundled plugin, including future providers.
for (const plugin of BUNDLED_PLUGINS) {
  const child = Bun.spawn(
    [process.execPath, "packages/cli/src/main.ts", "plugin", "test", `packages/plugins/${plugin.id}`],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if ((await child.exited) !== 0) process.exit(1);
}
