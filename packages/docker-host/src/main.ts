#!/usr/bin/env bun
import { join } from "node:path";
import { createDockerMachineExecutor } from "../../core/src/docker-machine.ts";
import { VERSION } from "../../core/src/version.ts";
import { register, tick } from "./daemon.ts";
import { dockerCli, fileStore, httpApi } from "./native.ts";
import { dockerRuntimeStarter } from "./runtime-install.ts";
import {
  installService,
  inventory,
  removeInstallation,
  servicePreflight,
  stateDirectory,
  stopService,
  uninstallPreflight,
  validateInstallation,
} from "./service.ts";

const usage = `Usage:
  armada-docker-host register --server https://ARMADA_ORIGIN --state-dir /absolute/private/directory
  armada-docker-host run --state-dir /absolute/private/directory
  armada-docker-host install --server https://ARMADA_ORIGIN
  armada-docker-host status
  armada-docker-host uninstall
  armada-docker-host --help

Machine-only Docker host agent. Registration reads a one-use token from stdin;
never pass a token as an argument. State is private; Docker access is required.
Install needs Linux, Docker access, systemd user services and permission to enable linger.
Uninstall drains host sandboxes through Armada before revoking and removing its own files.
Use --help or -h after any command for this usage. Stop the daemon with SIGTERM.`;

async function main(args: string[]) {
  if (
    args.length === 0 ||
    (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) ||
    (args.length === 2 &&
      ["register", "run", "install", "status", "uninstall"].includes(args[0] ?? "") &&
      ["--help", "-h"].includes(args[1] ?? ""))
  ) {
    console.log(usage);
    return;
  }
  if (args.length === 1 && args[0] === "--version") {
    console.log(VERSION);
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
  if (!command || !["register", "run", "install", "status", "uninstall"].includes(command))
    throw new Error("Invalid arguments");
  const managed = ["install", "status", "uninstall"].includes(command);
  if (
    (managed && options.has("--state-dir")) ||
    (!managed && !options.has("--state-dir")) ||
    ["register", "install"].includes(command) !== options.has("--server")
  )
    throw new Error("Invalid arguments");
  const directory = managed ? stateDirectory() : (options.get("--state-dir") ?? "");
  const store = await fileStore(directory);
  if (command === "status") {
    if (!(await store.exists())) {
      console.log(JSON.stringify({ registered: false, connected: false, version: VERSION }));
      return;
    }
    const state = await store.load();
    const local = await inventory(state);
    const elapsed = state.lastPollAt ? Date.now() - Date.parse(state.lastPollAt) : Number.POSITIVE_INFINITY;
    console.log(
      JSON.stringify({
        registered: true,
        connected: elapsed >= 0 && elapsed < 60_000,
        hostId: state.hostId,
        version: VERSION,
        lastPollAt: state.lastPollAt ?? null,
        runningSandboxes: local.running,
      }),
    );
    return;
  }
  if (command === "install") await servicePreflight();
  if (command === "uninstall") {
    const state = await store.load();
    await validateInstallation(state);
    const deadline = Date.now() + 10 * 60_000;
    const api = httpApi();
    // Keep the service alive to execute ordinary bound stop/delete jobs. The
    // server fences new allocations as soon as draining begins; retries retain
    // the original cleanup requests. No local resource deletion bypasses ACKs.
    while (!(await api.unregister(state))) {
      if (Date.now() >= deadline)
        throw new Error(
          "Host drain remains pending; service and private state preserved. Retry uninstall to reconcile.",
        );
      await Bun.sleep(Math.min(20_000, Math.max(1, deadline - Date.now())));
    }
    await uninstallPreflight(await store.load());
    await stopService();
    const unlock = await store.lock();
    try {
      await uninstallPreflight(await store.load());
    } finally {
      await unlock();
    }
    await removeInstallation();
    console.log("Uninstalled Armada Docker host. Shared images, other workloads and linger settings preserved.");
    return;
  }
  const unlock = await store.lock();
  let released = false;
  const release = async () => {
    if (!released) {
      await unlock();
      released = true;
    }
  };
  try {
    const api = httpApi();
    if (command === "register" || command === "install") {
      if (await store.exists()) throw new Error("Host already registered");
      const token = (await Bun.stdin.text()).trim();
      await register(store, api, options.get("--server") ?? "", token);
      if (command === "install") {
        // Registration is durable before systemd starts the separate lock owner.
        await release();
        await installService(await store.load());
      }
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
        cacheDir: join(directory, "runtime-cache"),
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
  main(process.argv.slice(2)).catch((error: unknown) => {
    // Parser and transport diagnostics may include private response/state bytes.
    const safe =
      error instanceof Error && !(error instanceof SyntaxError) && !(error instanceof TypeError) && !("code" in error);
    console.error(
      safe
        ? error.message
        : "Docker host command failed. Inspect service permissions and registration without printing private state.",
    );
    process.exitCode = 1;
  });
