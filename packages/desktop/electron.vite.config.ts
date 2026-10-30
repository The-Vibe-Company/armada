import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    define: {
      __ARMADA_COORDINATOR_PROMPT__: JSON.stringify(
        readFileSync(new URL("../daemon/coordinator/system.md", import.meta.url), "utf8"),
      ),
    },
    build: {
      externalizeDeps: false,
      rollupOptions: {
        // Preserve Node's native-addon loading and CommonJS named exports.
        external: ["@napi-rs/keyring"],
        input: {
          index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
          armadad: fileURLToPath(new URL("../daemon/src/server/main.ts", import.meta.url)),
        },
        output: { format: "es", entryFileNames: "[name].js" },
      },
    },
  },
  // The window's preload: CommonJS, as a sandboxed renderer requires (THE-2055).
  preload: {
    build: {
      rollupOptions: {
        input: { preload: fileURLToPath(new URL("./src/preload.ts", import.meta.url)) },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
});
