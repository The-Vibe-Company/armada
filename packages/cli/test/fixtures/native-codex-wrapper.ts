#!/usr/bin/env bun
// Models the official npm launcher's child + inherited stdio topology.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, [`${import.meta.dir}/native-codex-login.ts`, "--keep-alive"], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
