import { fileURLToPath } from "node:url";
import { generateOpenApi } from "../packages/mcp-server/src/openapi.ts";

const target = fileURLToPath(new URL("../docs/openapi.json", import.meta.url));
await Bun.write(target, `${JSON.stringify(await generateOpenApi(), null, 2)}\n`);

// Emit the file in the repository's Biome format so `bun run lint` accepts the regenerated artifact as-is.
const format = Bun.spawnSync(["bun", "x", "biome", "format", "--write", target], {
  stdout: "inherit",
  stderr: "inherit",
});
if (format.exitCode !== 0) process.exit(format.exitCode ?? 1);
