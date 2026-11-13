import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type State, type Store, serverOrigin } from "./daemon.ts";
import { dockerCli } from "./native.ts";

export const stateDirectory = (home = homedir()) => join(home, ".local/state/armada-docker-host");
const serviceName = "armada-docker-host.service";
function paths(home = homedir()) {
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

type ManagedInstallation = {
  installationId: string;
  binarySha256: string;
  unit: string;
  pendingBinarySha256?: string;
};
const digestPattern = /^[a-f0-9]{64}$/;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function safeAncestors(path: string, home: string) {
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ((directory === home || directory.startsWith(`${home}/`)) &&
        (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0))
    )
      throw new Error("Unsafe installation directory; registration preserved.");
    if (directory === dirname(directory)) break;
  }
}
async function ownedFile(path: string, home: string, executable = false): Promise<Buffer> {
  await safeAncestors(path, home);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (executable ? (info.mode & 0o022) !== 0 || (info.mode & 0o100) === 0 : (info.mode & 0o777) !== 0o600)
    )
      throw new Error("Installation ownership is unknown; registration preserved.");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

/** Refuse all unknown files and preserve shared Docker images and linger settings. */
export async function validateInstallation(state: State, home = homedir()): Promise<ManagedInstallation> {
  const p = paths(home);
  const directory = stateDirectory(home);
  const marker = JSON.parse((await ownedFile(join(directory, "managed.json"), home)).toString("utf8"));
  const actualDigest = sha256(await ownedFile(p.binary, home, true));
  if (
    !marker ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    Object.keys(marker).some(
      (key) => !["installationId", "binarySha256", "pendingBinarySha256", "unit"].includes(key),
    ) ||
    marker.installationId !== state.installationId ||
    typeof marker.binarySha256 !== "string" ||
    !digestPattern.test(marker.binarySha256) ||
    ("pendingBinarySha256" in marker &&
      (typeof marker.pendingBinarySha256 !== "string" || !digestPattern.test(marker.pendingBinarySha256))) ||
    (marker.binarySha256 !== actualDigest && marker.pendingBinarySha256 !== actualDigest) ||
    typeof marker.unit !== "string" ||
    marker.unit !== (await ownedFile(p.unit, home)).toString("utf8")
  )
    throw new Error("Installation files changed; inspect them before uninstalling or upgrading.");
  for (const entry of await readdir(directory)) {
    if (
      !["state.json", "daemon.lock", "managed.json", "runtime-cache"].includes(entry) &&
      !/^daemon-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.lock$/.test(entry)
    )
      throw new Error("Unknown files in installation directory; preserve and inspect before uninstalling.");
    const entryStat = await lstat(join(directory, entry));
    if (
      entryStat.isSymbolicLink() ||
      entryStat.uid !== process.getuid?.() ||
      (entry !== "runtime-cache" &&
        (!entryStat.isFile() || entryStat.nlink !== 1 || (entryStat.mode & 0o777) !== 0o600))
    )
      throw new Error("Unsafe installation file.");
  }
  return marker;
}

export interface UpgradeServiceIo {
  home: string;
  executable: string;
  service(args: string[]): Promise<unknown>;
}

/** Durable rename: pending marker is synced before the executable can be replaced. */
async function atomicReplace(path: string, bytes: Uint8Array, mode: number, temporaryDirectory = dirname(path)) {
  const temporary = join(temporaryDirectory, `.armada-host-upgrade-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", mode);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Invoked only from the caller's verified downloaded executable; never reads stdin or rewrites credentials. */
export async function upgradeService(
  store: Pick<Store, "load"> & { lock(): Promise<() => Promise<void>> },
  server: string,
  io: UpgradeServiceIo = { home: homedir(), executable: process.execPath, service: command },
) {
  const origin = serverOrigin(server);
  const initial = await store.load();
  if (origin !== initial.server)
    throw new Error("Upgrade server does not match the registered host; registration preserved.");
  const initialMarker = await validateInstallation(initial, io.home);
  const bytes = await ownedFile(io.executable, io.home, true);
  const digest = sha256(bytes);
  if (initialMarker.binarySha256 === digest && initialMarker.pendingBinarySha256 === undefined) return;
  // Do not disable the service or touch work. Stop must complete before taking
  // the daemon's exclusive lock; restart even if stop/lock/update fails.
  try {
    await io.service(["systemctl", "--user", "stop", serviceName]);
    const unlock = await store.lock();
    try {
      const state = await store.load();
      if (state.server !== origin || state.installationId !== initial.installationId || state.hostId !== initial.hostId)
        throw new Error("Installation identity changed; registration preserved.");
      const marker = await validateInstallation(state, io.home);
      const p = paths(io.home);
      const directory = stateDirectory(io.home);
      const markerFile = join(directory, "managed.json");
      const currentDigest = sha256(await ownedFile(p.binary, io.home, true));
      const stable = { installationId: marker.installationId, binarySha256: currentDigest, unit: marker.unit };
      // Sibling temporary marker files cannot make the private state directory
      // fail its unknown-file check after an interrupted write.
      await atomicReplace(
        markerFile,
        Buffer.from(JSON.stringify({ ...stable, pendingBinarySha256: digest })),
        0o600,
        dirname(directory),
      );
      await atomicReplace(p.binary, bytes, 0o700);
      await atomicReplace(
        markerFile,
        Buffer.from(JSON.stringify({ ...stable, binarySha256: digest })),
        0o600,
        dirname(directory),
      );
    } finally {
      await unlock();
    }
  } finally {
    await io.service(["systemctl", "--user", "start", serviceName]);
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
