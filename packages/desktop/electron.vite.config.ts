import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
          armadad: fileURLToPath(new URL("../daemon/src/server/main.ts", import.meta.url)),
        },
        output: { format: "es", entryFileNames: "[name].js" },
      },
    },
  },
});
