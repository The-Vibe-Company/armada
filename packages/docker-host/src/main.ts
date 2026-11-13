#!/usr/bin/env bun
import { join } from "node:path";
import { createDockerMachineExecutor } from "../../core/src/docker-machine.ts";
import { register, tick } from "./daemon.ts";
import { dockerCli, fileStore, httpApi } from "./native.ts";
import { dockerRuntimeStarter } from "./runtime-install.ts";

const usage = `Usage:
  armada-docker-host register --server https://ARMADA_ORIGIN --state-dir /absolute/private/directory
  armada-docker-host run --state-dir /absolute/private/directory
  armada-docker-host --help

Machine-only Docker host agent. Registration reads a one-use token from stdin;
never pass a token as an argument. State is private; Docker access is required.
Use --help or -h after register/run for this usage. Stop the daemon with SIGTERM.`;

async function main(args: string[]) {
  if (
    args.length === 0 ||
    (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) ||
    (args.length === 2 && ["register", "run"].includes(args[0] ?? "") && ["--help", "-h"].includes(args[1] ?? ""))
  ) {
    console.log(usage);
    return;
  }
  const [command, ...flags] = args;
  const options = new Map<string, string>();
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i];
    const value = flags[i + 1];
    if (!key || !value || !["--server", "--state-dir"].includes(key) || options.has(key))
      throw new Error("Invalid arguments");
    options.set(key, value);
  }
  if (
    !options.has("--state-dir") ||
    (command !== "register" && command !== "run") ||
    (command === "register" ? !options.has("--server") : options.has("--server"))
  )
    throw new Error("Invalid arguments");
  const store = await fileStore(options.get("--state-dir") ?? "");
  const release = await store.lock();
  try {
    const api = httpApi();
    if (command === "register") {
      if (await store.exists()) throw new Error("Host already registered");
      const token = (await Bun.stdin.text()).trim();
      await register(store, api, options.get("--server") ?? "", token);
      return;
    }
    const state = await store.load();
    const executor = createDockerMachineExecutor({
      installationId: state.installationId,
      hostId: state.hostId,
      cli: dockerCli,
      now: Date.now,
    });
    const runtime = {
      ...executor,
      startRuntime: dockerRuntimeStarter(executor, {
        serverUrl: state.server,
        cacheDir: join(options.get("--state-dir") ?? "", "runtime-cache"),
      }),
    };
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    while (!stopping) {
      try {
        await tick(store, api, runtime);
      } catch {
        console.error("Docker host iteration failed; local TTL sweep continues.");
      }
      if (!stopping) await Bun.sleep(20_000);
    }
  } finally {
    await release();
  }
}
if (import.meta.main)
  main(process.argv.slice(2)).catch(() => {
    console.error("Docker host command failed. Check arguments, private state permissions and registration.");
    process.exitCode = 1;
  });
