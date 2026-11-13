import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { State } from "./daemon.ts";
import { dockerCli } from "./native.ts";

export const stateDirectory = () => join(homedir(), ".local/state/armada-docker-host");
const serviceName = "armada-docker-host.service";
function paths() {
  const home = homedir();
  return {
    binary: join(home, ".local/bin/armada-docker-host"),
    units: join(home, ".config/systemd/user"),
    unit: join(home, ".config/systemd/user", serviceName),
  };
}
async function command(args: string[]) {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0)
    throw new Error("User service command failed; check systemd user services and linger permissions.");
  return output.trim();
}
export async function servicePreflight() {
  if (process.platform !== "linux") throw new Error("Linux with systemd user services is required.");
  if ((await dockerCli.run(["info"])).exitCode !== 0)
    throw new Error(
      "Docker access required: configure rootless Docker or ask the administrator for Docker access first.",
    );
  await command(["flock", "--version"]);
  await command(["systemctl", "--user", "show-environment"]);
  // This may be permitted by logind policy; no sudo or privileged fallback.
  await command(["loginctl", "enable-linger"]);
  if ((await command(["loginctl", "show-user", String(process.getuid?.()), "--property=Linger", "--value"])) !== "yes")
    throw new Error("Linger is required for reboot persistence; ask the administrator to enable it for this account.");
  const p = paths();
  if (process.execPath !== p.binary) throw new Error("Run the downloaded binary from ~/.local/bin/armada-docker-host.");
  for (const file of [p.unit, join(stateDirectory(), "managed.json")]) {
    try {
      await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("An installation already exists; inspect it rather than overwriting it.");
  }
}
function quoted(value: string) {
  if (/[\r\n\0]/.test(value)) throw new Error("Unsupported installation path.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;
}
export async function installService(state: State) {
  const p = paths();
  const unit = `[Unit]\nDescription=Armada Docker host\nAfter=network-online.target\n\n[Service]\nExecStart=${quoted(p.binary)} run --state-dir ${quoted(stateDirectory())}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=90\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  await mkdir(p.units, { recursive: true, mode: 0o700 });
  await writeFile(p.unit, unit, { flag: "wx", mode: 0o600 });
  await writeFile(
    join(stateDirectory(), "managed.json"),
    JSON.stringify({
      installationId: state.installationId,
      binarySha256: createHash("sha256")
        .update(await readFile(p.binary))
        .digest("hex"),
      unit,
    }),
    { flag: "wx", mode: 0o600 },
  );
  await command(["systemctl", "--user", "daemon-reload"]);
  await command(["systemctl", "--user", "enable", "--now", serviceName]);
  console.log("Installed Armada Docker host user service with linger. Use armada-docker-host status.");
}

export async function inventory(state: State) {
  const filters = [
    "--filter",
    `label=dev.armada.machine.installation=${state.installationId}`,
    "--filter",
    `label=dev.armada.machine.host=${state.hostId}`,
  ];
  const running = await dockerCli.run(["container", "ls", ...filters, "--format", "{{.ID}}"]);
  const containers = await dockerCli.run(["container", "ls", "--all", ...filters, "--format", "{{.ID}}"]);
  const volumes = await dockerCli.run(["volume", "ls", ...filters, "--format", "{{.Name}}"]);
  if ([running, containers, volumes].some((r) => r.exitCode !== 0))
    throw new Error("Docker inventory unavailable; no cleanup performed.");
  return {
    running: running.stdout.trim() ? running.stdout.trim().split("\n").length : 0,
    empty: !containers.stdout.trim() && !volumes.stdout.trim(),
  };
}

/** Refuse all unknown files and preserve shared Docker images and linger settings. */
export async function validateInstallation(state: State) {
  const p = paths();
  const markerFile = join(stateDirectory(), "managed.json");
  const stat = await lstat(markerFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
    throw new Error("Installation ownership is unknown; no files removed.");
  const marker = JSON.parse(await readFile(markerFile, "utf8"));
  if (
    marker.installationId !== state.installationId ||
    marker.binarySha256 !==
      createHash("sha256")
        .update(await readFile(p.binary))
        .digest("hex") ||
    marker.unit !== (await readFile(p.unit, "utf8"))
  )
    throw new Error("Installation files changed; inspect them before uninstalling.");
  for (const entry of await readdir(stateDirectory())) {
    if (
      !["state.json", "daemon.lock", "managed.json", "runtime-cache"].includes(entry) &&
      !/^daemon-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.lock$/.test(entry)
    )
      throw new Error("Unknown files in installation directory; preserve and inspect before uninstalling.");
    const entryStat = await lstat(join(stateDirectory(), entry));
    if (
      entryStat.isSymbolicLink() ||
      entryStat.uid !== process.getuid?.() ||
      (entry !== "runtime-cache" && (!entryStat.isFile() || (entryStat.mode & 0o777) !== 0o600))
    )
      throw new Error("Unsafe installation file.");
  }
}
export async function uninstallPreflight(state: State) {
  await validateInstallation(state);
  if (!(await inventory(state)).empty)
    throw new Error("Host resources remain after drain; preserve registration files and inspect through Armada.");
}
export async function stopService() {
  await command(["systemctl", "--user", "disable", "--now", serviceName]);
}
export async function removeInstallation() {
  const p = paths();
  const directory = stateDirectory();
  // Preserve registration/ownership proof until the final binary unlink succeeds.
  const saved = await Promise.all(
    [p.unit, join(directory, "state.json"), join(directory, "managed.json")].map(async (path) => ({
      path,
      bytes: await readFile(path),
    })),
  );
  try {
    await unlink(p.unit);
    await command(["systemctl", "--user", "daemon-reload"]);
    await rm(join(directory, "runtime-cache"), { recursive: true, force: true });
    for (const entry of await readdir(directory)) {
      if (/^daemon-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.lock$/.test(entry)) {
        const file = join(directory, entry);
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
          throw new Error("Unsafe stale boot lock; preserve for inspection.");
        await unlink(file);
      }
    }
    await unlink(join(directory, "state.json"));
    await unlink(join(directory, "managed.json"));
    await rmdir(directory);
    // Last fallible operation: command remains available on any earlier failure.
    await unlink(p.binary);
  } catch (error) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const file of saved) {
      try {
        await writeFile(file.path, file.bytes, { flag: "wx", mode: 0o600 });
      } catch (restoreError) {
        if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") throw restoreError;
      }
    }
    throw error;
  }
}
