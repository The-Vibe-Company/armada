import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type DockerHostUpdateResult,
  dockerHostReleasePattern as releasePattern,
} from "../../core/src/contract/docker-host.ts";
import { VERSION } from "../../core/src/version.ts";
import { machineLabelFilters } from "./container-inventory.ts";
import { type State, type Store, serverOrigin } from "./daemon.ts";
import { dockerCli } from "./host.ts";

export function instanceName(instance?: string) {
  if (instance !== undefined && !/^[a-f0-9]{64}$/.test(instance)) throw new Error("Invalid Docker host instance.");
  return instance ? `armada-docker-host@${instance}` : "armada-docker-host";
}
export const stateDirectory = (home = homedir(), instance?: string) =>
  join(home, ".local/state", instanceName(instance));
const serviceName = (instance?: string) => `${instanceName(instance)}.service`;
function paths(home = homedir(), instance?: string) {
  return {
    binary: join(home, ".local/bin", instanceName(instance)),
    units: join(home, ".config/systemd/user"),
    unit: join(home, ".config/systemd/user", serviceName(instance)),
  };
}
const USER_SERVICE_ERROR = "User service command failed; check systemd user services and linger permissions.";
const LINGER_ACTION = "enable systemd user lingering with 'loginctl enable-linger' or ask an administrator.";

async function command(args: string[]) {
  try {
    const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error(USER_SERVICE_ERROR);
    return output.trim();
  } catch {
    throw new Error(USER_SERVICE_ERROR);
  }
}
interface ServiceIo {
  home: string;
  service(args: string[]): Promise<unknown>;
}
export interface ServicePreflightIo extends ServiceIo {
  docker(args: readonly string[]): Promise<{ exitCode: number }>;
  platform: NodeJS.Platform;
  execPath: string;
  uid: number | undefined;
}
const localService: () => ServiceIo = () => ({ home: homedir(), service: command });
const localPreflight = () => ({
  ...localService(),
  docker: (args: readonly string[]) => dockerCli.run(args),
  platform: process.platform,
  execPath: process.execPath,
  uid: process.getuid?.(),
});
async function runPreflight(service: ServiceIo["service"], args: string[], failureMessage: string) {
  try {
    const output = await service(args);
    return typeof output === "string" ? output.trim() : "";
  } catch {
    throw new Error(failureMessage);
  }
}
export async function servicePreflight(instance?: string, io: ServicePreflightIo = localPreflight()) {
  if (io.platform !== "linux") throw new Error("Linux with systemd user services is required.");
  let dockerReady = false;
  try {
    dockerReady = (await io.docker(["info"])).exitCode === 0;
  } catch {}
  if (!dockerReady)
    throw new Error(
      "Docker preflight failed: ensure Docker is installed, the Docker daemon is running and accessible, or ask an administrator for Docker access.",
    );
  await runPreflight(
    io.service,
    ["flock", "--version"],
    "Missing required tool 'flock': install util-linux (flock) and retry.",
  );
  await runPreflight(
    io.service,
    ["systemctl", "--user", "show-environment"],
    "Systemd user session unavailable: ensure systemd (systemctl) is installed and run from an active systemd user session.",
  );
  await runPreflight(
    io.service,
    ["loginctl", "enable-linger"],
    `Failed to enable systemd user lingering: ensure loginctl is installed and ${LINGER_ACTION}`,
  );
  if (io.uid === undefined)
    throw new Error(`Failed to verify systemd user lingering: Linux user ID unavailable; ${LINGER_ACTION}`);
  const linger = await runPreflight(
    io.service,
    ["loginctl", "show-user", String(io.uid), "--property=Linger", "--value"],
    `Failed to verify systemd user lingering: ensure loginctl is available and ${LINGER_ACTION}`,
  );
  if (linger !== "yes") throw new Error(`Systemd user lingering is not enabled: ${LINGER_ACTION}`);
  const p = paths(io.home, instance);
  if (io.execPath !== p.binary)
    throw new Error("Run the downloaded binary from its selected ~/.local/bin installation path.");
  for (const file of [p.unit, join(stateDirectory(io.home, instance), "managed.json")]) {
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

export async function installService(state: State, instance?: string, io = localService()) {
  const p = paths(io.home, instance);
  const unit = `[Unit]\nDescription=Armada Docker host\nAfter=network-online.target\n\n[Service]\nExecStart=${quoted(p.binary)} run --state-dir ${quoted(stateDirectory(io.home, instance))}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=90\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  await mkdir(p.units, { recursive: true, mode: 0o700 });
  await writeFile(p.unit, unit, { flag: "wx", mode: 0o600 });
  await writeFile(
    join(stateDirectory(io.home, instance), "managed.json"),
    JSON.stringify({
      installationId: state.installationId,
      binarySha256: createHash("sha256")
        .update(await readFile(p.binary))
        .digest("hex"),
      unit,
    }),
    { flag: "wx", mode: 0o600 },
  );
  await io.service(["systemctl", "--user", "daemon-reload"]);
  await io.service(["systemctl", "--user", "enable", "--now", serviceName(instance)]);
  console.log("Installed Armada Docker host user service with linger. Use armada-docker-host status.");
}

export async function inventory(state: State) {
  const filters = machineLabelFilters(state);
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
  update?: {
    attempts: string[];
    version: string;
    at: number;
    status: "failed" | "updated" | "pending" | "starting";
    detail?: NonNullable<DockerHostUpdateResult["detail"]>;
  };
};
const digestPattern = /^[a-f0-9]{64}$/;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const CACHE_DIRECTORIES = ["runtime-cache", "artifact-cache", "artifact-cache-private"];

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
async function readManagedInstallation(
  state: State,
  home = homedir(),
  instance?: string,
): Promise<ManagedInstallation> {
  const p = paths(home, instance);
  const directory = stateDirectory(home, instance);
  const marker = JSON.parse((await ownedFile(join(directory, "managed.json"), home)).toString("utf8"));
  const actualDigest = sha256(await ownedFile(p.binary, home, true));
  if (
    !marker ||
    typeof marker !== "object" ||
    Array.isArray(marker) ||
    Object.keys(marker).some(
      (key) => !["installationId", "binarySha256", "pendingBinarySha256", "unit", "update"].includes(key),
    ) ||
    marker.installationId !== state.installationId ||
    typeof marker.binarySha256 !== "string" ||
    !digestPattern.test(marker.binarySha256) ||
    ("pendingBinarySha256" in marker &&
      (typeof marker.pendingBinarySha256 !== "string" || !digestPattern.test(marker.pendingBinarySha256))) ||
    (marker.binarySha256 !== actualDigest && marker.pendingBinarySha256 !== actualDigest) ||
    (marker.update !== undefined && !validUpdate(marker.update, marker.pendingBinarySha256)) ||
    typeof marker.unit !== "string" ||
    marker.unit !== (await ownedFile(p.unit, home)).toString("utf8")
  )
    throw new Error("Installation files changed; inspect them before uninstalling or upgrading.");
  return marker;
}

export async function validateInstallation(state: State, home = homedir(), instance?: string) {
  const marker = await readManagedInstallation(state, home, instance);
  const directory = stateDirectory(home, instance);
  for (const entry of await readdir(directory)) {
    if (
      !["state.json", "daemon.lock", "managed.json", ...CACHE_DIRECTORIES].includes(entry) &&
      !/^daemon-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.lock$/.test(entry)
    )
      throw new Error("Unknown files in installation directory; preserve and inspect before uninstalling.");
    const entryStat = await lstat(join(directory, entry));
    if (
      entryStat.isSymbolicLink() ||
      entryStat.uid !== process.getuid?.() ||
      (!CACHE_DIRECTORIES.includes(entry) &&
        (!entryStat.isFile() || entryStat.nlink !== 1 || (entryStat.mode & 0o777) !== 0o600))
    )
      throw new Error("Unsafe installation file.");
  }
  return marker;
}

function validUpdate(value: NonNullable<ManagedInstallation["update"]>, pending?: string) {
  return (
    value &&
    typeof value.version === "string" &&
    releasePattern.test(value.version) &&
    Number.isSafeInteger(value.at) &&
    Array.isArray(value.attempts) &&
    value.attempts.every((version) => typeof version === "string" && releasePattern.test(version)) &&
    value.attempts.includes(value.version) &&
    (value.status === "updated" ||
      value.status === "failed" ||
      (!!pending && (value.status === "pending" || value.status === "starting")))
  );
}

export interface UpgradeServiceIo extends ServiceIo {
  fetch(input: string, init: RequestInit): Promise<Response>;
}
class UpdateReleaseUnavailable extends Error {}

async function fetchUpgradeFile(io: UpgradeServiceIo, url: string, offeredArtifact = false) {
  const response = await io.fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (offeredArtifact && response.status === 404) throw new UpdateReleaseUnavailable();
  if (!response.ok) throw new Error(`Upgrade download returned HTTP ${response.status}.`);
  return response;
}

async function pinnedUpgrade(
  io: UpgradeServiceIo,
  origin: string,
  installed: ManagedInstallation,
  retry: string,
  offer?: { version: string; beforeVerify(): Promise<void> },
) {
  try {
    const arch = process.arch;
    if (arch !== "x64" && arch !== "arm64") throw new Error("Unsupported host architecture.");
    const manifest = (await (await fetchUpgradeFile(io, `${origin}/api/docker-host/install.json`)).json()) as Partial<
      Record<"version" | "x64" | "arm64", unknown>
    > | null;
    if (offer && manifest?.version !== offer.version) {
      if (typeof manifest?.version === "string" && releasePattern.test(manifest.version))
        throw new UpdateReleaseUnavailable();
      throw new Error("Invalid installer manifest release.");
    }
    const digest = manifest?.[arch];
    if (typeof digest !== "string" || !digestPattern.test(digest)) throw new Error("Invalid host artifact pin.");
    if (installed.binarySha256 === digest && installed.pendingBinarySha256 === undefined) return { digest };
    const artifact = await fetchUpgradeFile(io, `${origin}/api/runtime/artifacts/${digest}`, !!offer);
    await offer?.beforeVerify();
    const bytes = new Uint8Array(await artifact.arrayBuffer());
    if (sha256(bytes) !== digest) throw new Error("Host artifact SHA-256 mismatch.");
    return { digest, bytes };
  } catch (error) {
    if (error instanceof UpdateReleaseUnavailable) throw error;
    const reason =
      error instanceof Error && error.constructor === Error
        ? error.message
        : "Could not read the host upgrade download.";
    throw new Error(`${reason} Check the server and retry: ${retry}`);
  }
}

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

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
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
const autoUpdateCooldown = 60 * 60_000;
function isNewerRelease(target: unknown, current: string) {
  if (typeof target !== "string" || !releasePattern.test(target) || !releasePattern.test(current)) return false;
  const [major = 0, minor = 0, patch = 0] = target.split(".").map(Number);
  const [a = 0, b = 0, c = 0] = current.split(".").map(Number);
  return (major - a || minor - b || patch - c) > 0;
}

function updatePaths(home: string, instance?: string) {
  const { binary, unit } = paths(home, instance);
  const directory = stateDirectory(home, instance);
  return {
    binary,
    unit,
    directory,
    previous: `${binary}.previous`,
    hook: join(`${unit}.d`, "armada-update.conf"),
    marker: join(directory, "managed.json"),
  };
}

const managedFiles = { ownedFile, atomicReplace, mkdir, syncDirectory, readManagedInstallation, safeAncestors };
type UpdateIo = UpgradeServiceIo & { now(): number; version: string; files?: typeof managedFiles };

export function createManagedUpdater(
  directory: string,
  recovering = false,
  executable = process.execPath,
  io: UpdateIo = { ...localService(), fetch: globalThis.fetch, now: Date.now, version: VERSION },
) {
  const files = io.files ?? managedFiles;
  const leaf = directory.split("/").at(-1) ?? "";
  const instance = /^armada-docker-host@([a-f0-9]{64})$/.exec(leaf)?.[1];
  const p = updatePaths(io.home, instance);
  if (process.platform !== "linux" || directory !== p.directory || executable !== (recovering ? p.previous : p.binary))
    return;
  const expectedHook = `[Service]\nType=notify\nNotifyAccess=all\nTimeoutStartSec=120\nExecStartPre=${quoted(p.previous)} recover-update --state-dir ${quoted(directory)}\n`;
  const readBinary = (path: string) => files.ownedFile(path, io.home, true);
  const readMarker = (state: State) => files.readManagedInstallation(state, io.home, instance);
  const save = (marker: ManagedInstallation) =>
    files.atomicReplace(p.marker, Buffer.from(JSON.stringify(marker)), 0o600, dirname(directory));
  const systemd = (...args: string[]) => io.service(["systemctl", "--user", ...args]);
  let lastAttempt: ManagedInstallation["update"];
  const unit = serviceName(instance);
  const deferred = (target: string) =>
    lastAttempt && (lastAttempt.attempts.includes(target) || io.now() - lastAttempt.at < autoUpdateCooldown);
  let staged: { bytes: Uint8Array; digest: string; marker: ManagedInstallation } | undefined;
  return {
    result() {
      if (lastAttempt?.status === "updated" || lastAttempt?.status === "failed") {
        const { version, status, at, detail } = lastAttempt;
        return `${version};${status};${at}${detail ? `;${detail}` : ""}`;
      }
    },
    async checkStartup(state: State, healthy: () => Promise<void>) {
      const marker = await readMarker(state).catch(() => undefined);
      if (!marker) return;
      lastAttempt = marker.update;
      if (marker.update?.status === "pending") throw new Error("Docker host update requires systemd recovery.");
      if (marker.update?.status !== "starting") return;
      if (
        marker.update.version !== io.version ||
        !marker.pendingBinarySha256 ||
        sha256(await readBinary(p.binary)) !== marker.pendingBinarySha256
      )
        throw new Error("Pending Docker host update does not match the active binary.");
      await healthy();
      const updated = { ...marker.update, status: "updated" as const, at: io.now() };
      const { pendingBinarySha256, ...stable } = marker;
      await save({ ...stable, binarySha256: pendingBinarySha256, update: updated });
      lastAttempt = updated;
    },
    async stage(state: State, target: string | undefined) {
      if (!target || !isNewerRelease(target, io.version) || deferred(target)) return false;
      const loaded = await readMarker(state).catch(() => undefined);
      if (!loaded || loaded.pendingBinarySha256) return false;
      lastAttempt = loaded.update;
      if (deferred(target)) return false;
      const show = await systemd(
        "show",
        unit,
        "--all",
        "--property=MainPID,FragmentPath,DropInPaths,NeedDaemonReload,Restart",
      ).catch(() => undefined);

      if (typeof show !== "string") return false;
      const properties = new Map(
        show.split("\n").map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
      );
      const dropIns = properties.get("DropInPaths");
      if (
        properties.get("MainPID") !== String(process.pid) ||
        properties.get("FragmentPath") !== p.unit ||
        properties.get("NeedDaemonReload") !== "no" ||
        properties.get("Restart") !== "on-failure" ||
        (dropIns !== "" && dropIns !== p.hook)
      )
        return false;
      const notifier = await io.service(["systemd-notify", "--version"]).catch(() => undefined);
      if (typeof notifier !== "string" || Number(/^systemd (\d+) /.exec(notifier)?.[1] ?? 0) < 246) return false;
      const update = {
        attempts: [...(loaded.update?.attempts ?? []), target],
        version: target,
        at: io.now(),
        status: "failed" as const,
      };
      const marker = { ...loaded, update };
      const artifact = await pinnedUpgrade(io, state.server, marker, "inspect the installer release", {
        version: target,
        async beforeVerify() {
          await save(marker);
          lastAttempt = update;
        },
      }).catch(async (error: unknown) => {
        if (error instanceof UpdateReleaseUnavailable) return undefined;
        const failed = { ...update, detail: "download_failed" as const };
        await save({ ...marker, update: failed });
        lastAttempt = failed;
        throw error;
      });
      if (!artifact?.bytes) return false;
      staged = { bytes: artifact.bytes, digest: artifact.digest, marker };
      return true;
    },
    async swap() {
      if (!staged) return false;
      const { bytes, digest, marker } = staged;
      if (!marker.update) throw new Error("Missing Docker host update attempt.");
      const previous = await readBinary(p.binary);
      if (sha256(previous) !== marker.binarySha256) throw new Error("Active Docker host binary changed.");
      await files.atomicReplace(p.previous, previous, 0o700);
      await files.mkdir(dirname(p.hook), { mode: 0o700, recursive: true });
      await files.safeAncestors(p.hook, io.home);
      await files.atomicReplace(p.hook, Buffer.from(expectedHook), 0o600);
      await files.syncDirectory(dirname(p.unit));
      await systemd("daemon-reload");
      if ((await systemd("show", unit, "--property=DropInPaths", "--value")) !== p.hook)
        throw new Error("Systemd did not load the Docker host update hook.");
      await save({
        ...marker,
        pendingBinarySha256: digest,
        update: { ...marker.update, status: "pending" },
      });
      await files.atomicReplace(p.binary, bytes, 0o700);
      return true;
    },
    async beforeStart(state: State) {
      const marker = await readMarker(state);
      const { update, pendingBinarySha256, ...stable } = marker;
      if (!update || !pendingBinarySha256 || update.status === "failed" || update.status === "updated") return;
      const active = sha256(await readBinary(p.binary));
      if (active === pendingBinarySha256 && update.status === "pending") {
        await save({ ...marker, update: { ...update, status: "starting" } });
        return;
      }
      if (active !== stable.binarySha256) {
        const previous = await readBinary(p.previous);
        if (sha256(previous) !== stable.binarySha256)
          throw new Error("Previous Docker host binary failed verification.");
        await files.atomicReplace(p.binary, previous, 0o700);
      }
      await save({ ...stable, update: { ...update, status: "failed", at: io.now(), detail: "startup_failed" } });
    },
  };
}

export async function notifyServiceReady(required = false) {
  if (process.env.NOTIFY_SOCKET) await command(["systemd-notify", "--ready"]);
  else if (required) throw new Error("Updated Docker host must start within its systemd user service.");
}

export async function upgradeService(
  store: Pick<Store, "load"> & { lock(): Promise<() => Promise<void>> },
  server: string,
  io: UpgradeServiceIo = { ...localService(), fetch: globalThis.fetch },
  instance?: string,
) {
  const origin = serverOrigin(server);
  const initial = await store.load();
  if (origin !== initial.server)
    throw new Error("Upgrade server does not match the registered host; registration preserved.");
  const initialMarker = await validateInstallation(initial, io.home, instance);
  if (initialMarker.update?.status === "pending" || initialMarker.update?.status === "starting")
    throw new Error("Docker host self-update is pending; let its service reconcile first.");
  const p = paths(io.home, instance);
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const serverArg = shellQuote(origin);
  const retry =
    process.execPath === p.binary
      ? `${shellQuote(p.binary)} upgrade --server ${serverArg}${instance ? ` --instance ${instance}` : ""}`
      : "run a fresh installer command from armada host add or the dashboard";
  const { bytes, digest } = await pinnedUpgrade(io, origin, initialMarker, retry);
  const verifyInstalled = async () => {
    if (sha256(await ownedFile(p.binary, io.home, true)) !== digest)
      throw new Error(`Installed Docker host SHA-256 differs from the server pin. Retry: ${retry}`);
  };
  if (!bytes) {
    await io.service(["systemctl", "--user", "start", serviceName(instance)]);
    await verifyInstalled();
    return false;
  }
  try {
    await io.service(["systemctl", "--user", "stop", serviceName(instance)]);
    const unlock = await store.lock();
    try {
      const state = await store.load();
      if (state.server !== origin || state.installationId !== initial.installationId || state.hostId !== initial.hostId)
        throw new Error("Installation identity changed; registration preserved.");
      const marker = await validateInstallation(state, io.home, instance);
      if (marker.update?.status === "pending" || marker.update?.status === "starting")
        throw new Error("Docker host self-update is pending; let its service reconcile first.");
      if (marker.update) {
        const { hook } = updatePaths(io.home, instance);
        try {
          await ownedFile(hook, io.home);
          await unlink(hook);
          await syncDirectory(dirname(hook));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await io.service(["systemctl", "--user", "daemon-reload"]);
      }
      const directory = stateDirectory(io.home, instance);
      const markerFile = join(directory, "managed.json");
      const currentDigest = sha256(await ownedFile(p.binary, io.home, true));
      const { pendingBinarySha256: _pending, ...saved } = marker;
      const stable = { ...saved, binarySha256: currentDigest };
      await atomicReplace(
        markerFile,
        Buffer.from(JSON.stringify({ ...stable, pendingBinarySha256: digest })),
        0o600,
        dirname(directory),
      );
      await atomicReplace(p.binary, bytes, 0o700);
      await verifyInstalled();
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
    await io.service(["systemctl", "--user", "start", serviceName(instance)]);
  }
  await verifyInstalled();
  return true;
}
export async function uninstallPreflight(state: State, instance?: string) {
  await validateInstallation(state, homedir(), instance);
  if (!(await inventory(state)).empty)
    throw new Error("Host resources remain after drain; preserve registration files and inspect through Armada.");
}
export async function stopService(instance?: string) {
  await command(["systemctl", "--user", "disable", "--now", serviceName(instance)]);
}
export async function removeInstallation(instance?: string, io = localService()) {
  const p = paths(io.home, instance);
  const directory = stateDirectory(io.home, instance);
  const saved: { path: string; bytes: Uint8Array }[] = await Promise.all(
    [p.unit, join(directory, "state.json"), join(directory, "managed.json")].map(async (path) => ({
      path,
      bytes: await readFile(path),
    })),
  );
  const { hook, previous } = updatePaths(io.home, instance);
  try {
    saved.push({ path: hook, bytes: await ownedFile(hook, io.home) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    if (saved.some((file) => file.path === hook)) await unlink(hook);
    await unlink(p.unit);
    await io.service(["systemctl", "--user", "daemon-reload"]);
    for (const cache of CACHE_DIRECTORIES) await rm(join(directory, cache), { recursive: true, force: true });
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
    await unlink(p.binary);
    await rm(previous, { force: true });
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
