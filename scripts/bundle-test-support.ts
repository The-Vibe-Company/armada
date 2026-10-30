// Native Node tests consume the same fake API without relying on removed
// TypeScript transformation flags. Bun's preload finishes before tests import it.
import { fileURLToPath } from "node:url";

const built = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../packages/core/test/support.ts", import.meta.url))],
  target: "node",
  packages: "external",
});
const [output] = built.outputs;
if (!built.success || !output) throw new AggregateError(built.logs, "Could not build native Node test support");
await Bun.write(new URL("../packages/core/test/support.node.js", import.meta.url), output);
