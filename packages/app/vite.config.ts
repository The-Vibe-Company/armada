import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8"));

export default defineConfig({
  // About's app version (src/settings/About.tsx).
  define: { __ARMADA_APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  server: { port: 4823 },
});
