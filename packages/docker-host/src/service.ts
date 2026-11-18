import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stableDockerHostVersion } from "../../core/src/docker-host-upgrade.ts";
import { VERSION } from "../../core/src/version.ts";
import { type State, type Store, serverOrigin } from "./daemon.ts";
import { dockerCli } from "./native.ts";
import { downloadOfficialHost } from "./official-release.ts";

export function instanceName(instance?: string) {
  if (instance !== undefined && !/^[a-f0-9]{64}$/.test(instance)) throw new Error("Invalid Docker host instance.");
  return instance ? `armada-docker-host@${instance}` : "armada-docker-host";
}
export const stateDirectory = (home = homedir(), instance?: string) =>
  join(home, ".local/state", instanceName(instance));
const serviceName = (instance?: string) => `${instanceName(instance)}.service`;
const updateUnit = (instance?: string) => `${instanceName(instance)}-update.service`;
function paths(home = homedir(), instance?: string) {
  return {
    binary: join(home, ".local/bin", instanceName(instance)),
    units: join(home, ".config/systemd/user"),
    unit: join(home, ".config/systemd/user", serviceName(instance)),
  };
}
async function command(args: string[]) {
  const child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0)
    throw new Error("User service command failed; check systemd user services and linger permissions.");
  return output.trim();
}
export async function servicePreflight(instance?: string) {
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
  const p = paths(homedir(), instance);
  if (process.execPath !== p.binary)
    throw new Error("Run the downloaded binary from its selected ~/.local/bin installation path.");
  for (const file of [p.unit, join(stateDirectory(homedir(), instance), "managed.json")]) {
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
export async function installService(state: State, instance?: string) {
  const p = paths(homedir(), instance);
  const unit = `[Unit]\nDescription=Armada Docker host\nAfter=network-online.target\n\n[Service]\nExecStart=${quoted(p.binary)} run --state-dir ${quoted(stateDirectory(homedir(), instance))}\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=90\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  await mkdir(p.units, { recursive: true, mode: 0o700 });
  await writeFile(p.unit, unit, { flag: "wx", mode: 0o600 });
  await writeFile(
    join(stateDirectory(homedir(), instance), "managed.json"),
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
  await command(["systemctl", "--user", "enable", "--now", serviceName(instance)]);
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
/** Daemon-owned, re-creatable public artifact caches (runtime binary; #2562 shared and private archives). */
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

/** Refuse all unknown files and preserve shared Docker images and linger settings. */
export async function validateInstallation(
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
      !["state.json", "daemon.lock", "managed.json", "update.json", "update-candidate", ...CACHE_DIRECTORIES].includes(
        entry,
      ) &&
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
  instance?: string,
) {
  const origin = serverOrigin(server);
  const initial = await store.load();
  if (origin !== initial.server)
    throw new Error("Upgrade server does not match the registered host; registration preserved.");
  const initialMarker = await validateInstallation(initial, io.home, instance);
  await refuseActiveUpdate(io.home, instance);
  const bytes = await ownedFile(io.executable, io.home, true);
  const digest = sha256(bytes);
  if (initialMarker.binarySha256 === digest && initialMarker.pendingBinarySha256 === undefined) return;
  // Do not disable the service or touch work. Stop must complete before taking
  // the daemon's exclusive lock; restart even if stop/lock/update fails.
  try {
    await io.service(["systemctl", "--user", "stop", serviceName(instance)]);
    const unlock = await store.lock();
    try {
      const state = await store.load();
      if (state.server !== origin || state.installationId !== initial.installationId || state.hostId !== initial.hostId)
        throw new Error("Installation identity changed; registration preserved.");
      const marker = await validateInstallation(state, io.home, instance);
      const p = paths(io.home, instance);
      await refuseActiveUpdate(io.home, instance);
      const directory = stateDirectory(io.home, instance);
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
    await io.service(["systemctl", "--user", "start", serviceName(instance)]);
  }
}
export async function uninstallPreflight(state: State, instance?: string) {
  await validateInstallation(state, homedir(), instance);
  await refuseActiveUpdate(homedir(), instance);
  if (!(await inventory(state)).empty)
    throw new Error("Host resources remain after drain; preserve registration files and inspect through Armada.");
}
export async function stopService(instance?: string) {
  await command(["systemctl", "--user", "disable", "--now", serviceName(instance)]);
}
export async function removeInstallation(instance?: string) {
  const p = paths(homedir(), instance);
  const directory = stateDirectory(homedir(), instance);
  // Preserve registration/ownership proof until the final binary unlink succeeds.
  const update = await readUpdate(homedir(), instance);
  const recovery = update?.previousDigest ? await existingRecovery(homedir(), instance) : undefined;
  const extra = ["update.json", "update-candidate"].map((name) => join(directory, name));
  if (update?.previousDigest) extra.push(`${p.binary}.previous`);
  const saved = await Promise.all(
    [p.unit, join(directory, "state.json"), join(directory, "managed.json"), ...(recovery ? [recovery.path] : [])].map(
      async (path) => ({
        path,
        bytes: await readFile(path),
      }),
    ),
  );
  try {
    await unlink(p.unit);
    if (recovery) await unlink(recovery.path);
    await command(["systemctl", "--user", "daemon-reload"]);
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
    if (update?.previousDigest) await verifyBackup(homedir(), instance, update.previousDigest);
    for (const file of extra) await rm(file, { force: true });
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

type Update = {
  version: string;
  phase: "failed" | "staged" | "starting" | "updated";
  previousDigest?: string;
  candidateDigest?: string;
  reported?: true;
};
type ManagedStore = Pick<Store, "load"> & { lock(): Promise<() => Promise<void>> };

async function readUpdate(home: string, instance?: string): Promise<Update | undefined> {
  try {
    const update: Update = JSON.parse(
      await ownedFile(join(stateDirectory(home, instance), "update.json"), home).then((bytes) =>
        bytes.toString("utf8"),
      ),
    );
    if (
      !stableDockerHostVersion(update.version) ||
      !["failed", "staged", "starting", "updated"].includes(update.phase) ||
      (update.previousDigest !== undefined && !digestPattern.test(update.previousDigest)) ||
      (update.candidateDigest !== undefined && !digestPattern.test(update.candidateDigest))
    )
      throw new Error("Invalid Docker host update record");
    return update;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function saveUpdate(home: string, instance: string | undefined, update: Update) {
  const directory = stateDirectory(home, instance);
  return atomicReplace(join(directory, "update.json"), Buffer.from(JSON.stringify(update)), 0o600, dirname(directory));
}

async function refuseActiveUpdate(home: string, instance?: string) {
  const phase = (await readUpdate(home, instance))?.phase;
  if (phase === "starting" || phase === "staged")
    throw new Error("Automatic Docker host update in progress. Retry after the service has recovered.");
}

async function verifyBackup(home: string, instance: string | undefined, digest: string) {
  const bytes = await ownedFile(`${paths(home, instance).binary}.previous`, home, true);
  if (sha256(bytes) !== digest) throw new Error("Docker host rollback copy changed");
  return bytes;
}

function newer(target: string, current: string) {
  const parts = current.split(".").map(Number);
  for (const [index, value] of target.split(".").map(Number).entries()) {
    const previous = parts[index]!;
    if (value !== previous) return value > previous;
  }
  return false;
}

/** The generated service owns both its executable and its private state directory. */
export function managedUpdateInstance(directory: string): { instance?: string } | undefined {
  if (process.platform !== "linux" || !process.env.INVOCATION_ID) return;
  const match = /\/armada-docker-host(?:@([a-f0-9]{64}))?$/.exec(directory);
  if (!match) return;
  const instance = match[1];
  if (directory === stateDirectory(homedir(), instance) && process.execPath === paths(homedir(), instance).binary)
    return instance ? { instance } : {};
}

export function automaticUpdate(state: State, instance?: string) {
  const home = homedir();
  const p = paths(home, instance);
  let staged = false;
  let nextManifestCheck = 0;
  return {
    get staged() {
      return staged;
    },
    async beforeAdmission(target: unknown) {
      const last = await readUpdate(home, instance);
      // The new service reconciles and polls, but waits for the supervisor's
      // decision before admitting work. This makes a failing trial reversible.
      if (last?.phase === "starting") {
        // A supervisor stopped while the trial is alive still needs to be
        // replaced. The replacement sees "starting" and can only roll back.
        const supervisor = await command([
          "systemctl",
          "--user",
          "show",
          "-p",
          "ActiveState",
          "--value",
          updateUnit(instance),
        ]).catch(() => undefined);
        if (supervisor === "inactive" || supervisor === "failed")
          staged = (await readUpdate(home, instance))?.phase === "starting";
        return true;
      }
      if (last?.phase === "staged") {
        if (process.env.ARMADA_DOCKER_HOST_AUTO_UPDATE === "0") {
          await saveUpdate(home, instance, { ...last, phase: "failed" });
          return false;
        }
        staged = true;
        return true;
      }
      if (
        process.env.ARMADA_DOCKER_HOST_AUTO_UPDATE === "0" ||
        !stableDockerHostVersion(VERSION) ||
        !stableDockerHostVersion(target) ||
        !newer(target, VERSION) ||
        (last && !newer(target, last.version)) ||
        Date.now() < nextManifestCheck
      )
        return false;
      try {
        if (
          (await command(["systemctl", "--user", "show", "-p", "MainPID", "--value", serviceName(instance)])) !==
          String(process.pid)
        )
          return false;
        await validateInstallation(state, home, instance);
        const attempt: Update = {
          version: target,
          phase: "failed",
          ...(last?.previousDigest ? { previousDigest: last.previousDigest } : {}),
        };
        // Staging can advertise a version before its artifact arrives. Throttle
        // manifest checks, and fence the attempt only once the official
        // manifest confirms that the requested version exists.
        nextManifestCheck = Date.now() + 5 * 60_000;
        const bytes = await downloadOfficialHost(target, process.arch, () => saveUpdate(home, instance, attempt));
        await atomicReplace(
          join(stateDirectory(home, instance), "update-candidate"),
          bytes,
          0o600,
          dirname(stateDirectory(home, instance)),
        );
        const previous = await ownedFile(p.binary, home, true);
        const previousDigest = sha256(previous);
        const backup = `${p.binary}.previous`;
        try {
          const existing = sha256(await ownedFile(backup, home, true));
          if (existing !== last?.previousDigest && existing !== previousDigest)
            throw new Error("Docker host rollback copy changed");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await atomicReplace(backup, previous, 0o700);
        await saveUpdate(home, instance, {
          ...attempt,
          phase: "staged",
          previousDigest,
          candidateDigest: sha256(bytes),
        });
        staged = true;
        return true;
      } catch {
        console.error("Automatic Docker host update could not be staged.");
        return false;
      }
    },
    async restart() {
      try {
        // Type=exec confirms that systemd exec'd the old daemon's helper before
        // the original exits. The separate unit survives the service stop.
        const args = [
          "systemd-run",
          "--user",
          "--collect",
          "--unit",
          updateUnit(instance),
          "--property=Type=exec",
          "--property=Restart=on-failure",
          "--property=RestartSec=10s",
          "--",
          `${p.binary}.previous`,
          "supervise-update",
        ];
        if (instance) args.push("--instance", instance);
        await command(args);
      } catch {
        const update = await readUpdate(home, instance);
        if (update?.phase === "staged") await saveUpdate(home, instance, { ...update, phase: "failed" });
        throw new Error("Docker host update supervisor could not start.");
      }
    },
    async failure() {
      const update = await readUpdate(home, instance);
      return update?.phase === "failed" && !update.reported ? update.version : undefined;
    },
    async acknowledge(version: string) {
      const update = await readUpdate(home, instance);
      if (update?.phase === "failed" && update.version === version)
        await saveUpdate(home, instance, { ...update, reported: true });
    },
  };
}

function recoveryDropIn(home: string, instance?: string) {
  const p = paths(home, instance);
  return {
    path: join(`${p.unit}.d`, "90-armada-update.conf"),
    contents: `[Service]\nExecStartPre=${quoted(`${p.binary}.previous`)} recover-update${instance ? ` --instance ${instance}` : ""}\n`,
  };
}

async function existingRecovery(home: string, instance?: string) {
  const recovery = recoveryDropIn(home, instance);
  try {
    if ((await ownedFile(recovery.path, home)).toString("utf8") !== recovery.contents)
      throw new Error("Docker host update recovery configuration changed");
    return recovery;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function armRecovery(home: string, instance?: string) {
  if (await existingRecovery(home, instance)) return;
  const recovery = recoveryDropIn(home, instance);
  await mkdir(dirname(recovery.path), { recursive: true, mode: 0o700 });
  await safeAncestors(recovery.path, home);
  await atomicReplace(recovery.path, Buffer.from(recovery.contents), 0o600);
}

function saveManagedMarker(home: string, instance: string | undefined, marker: ManagedInstallation) {
  const directory = stateDirectory(home, instance);
  return atomicReplace(join(directory, "managed.json"), Buffer.from(JSON.stringify(marker)), 0o600, dirname(directory));
}

async function restorePrevious(store: ManagedStore, home: string, instance: string | undefined, update: Update) {
  const unlock = await store.lock();
  try {
    if (update.phase === "starting" && update.previousDigest) {
      const marker = await validateInstallation(await store.load(), home, instance);
      const previous = await verifyBackup(home, instance, update.previousDigest);
      const binary = paths(home, instance).binary;
      const currentDigest = sha256(await ownedFile(binary, home, true));
      await saveManagedMarker(home, instance, {
        ...marker,
        binarySha256: currentDigest,
        pendingBinarySha256: update.previousDigest,
      });
      await atomicReplace(binary, previous, 0o700);
      await saveManagedMarker(home, instance, {
        installationId: marker.installationId,
        unit: marker.unit,
        binarySha256: update.previousDigest,
      });
    }
    await saveUpdate(home, instance, { ...update, phase: "failed" });
  } finally {
    await unlock();
  }
}

/** The managed unit runs this before ExecStart so a reboot cannot strand a bad candidate. */
export async function recoverUpdate(
  store: ManagedStore,
  instance?: string,
  io: Pick<UpgradeServiceIo, "home" | "service"> = { home: homedir(), service: command },
) {
  const update = await readUpdate(io.home, instance);
  if (update?.phase !== "starting") return;
  try {
    await io.service(["systemctl", "--user", "is-active", updateUnit(instance)]);
    return; // The live supervisor owns the trial.
  } catch {
    await restorePrevious(store, io.home, instance, update);
  }
}

export async function superviseUpdate(
  store: ManagedStore,
  instance?: string,
  io: Pick<UpgradeServiceIo, "home" | "service"> = { home: homedir(), service: command },
) {
  const { home } = io;
  const p = paths(home, instance);
  const directory = stateDirectory(home, instance);
  const candidateFile = join(directory, "update-candidate");
  const service = (verb: string) => io.service(["systemctl", "--user", verb, serviceName(instance)]);
  const writeMarker = (marker: ManagedInstallation) => saveManagedMarker(home, instance, marker);
  let update = await readUpdate(home, instance);
  if (update?.phase === "failed") {
    await service("reset-failed").catch(() => {});
    await service("start");
    return;
  }
  if (update?.phase !== "staged" && update?.phase !== "starting") return;
  let previousHealth: string | undefined;
  let trialMarker: ManagedInstallation | undefined;
  try {
    if (update.phase !== "staged") throw new Error("Interrupted Docker host update");
    await service("stop");
    const unlock = await store.lock();
    try {
      const state = await store.load();
      // The original daemon may finish a held poll while systemd stops it.
      // Capture that final heartbeat before starting the candidate.
      previousHealth = state.lastPollAt;
      const marker = await validateInstallation(state, home, instance);
      if (marker.pendingBinarySha256) throw new Error("An earlier Docker host upgrade is incomplete");
      const candidate = await ownedFile(candidateFile, home);
      if (sha256(candidate) !== update.candidateDigest) throw new Error("Staged Docker host release changed");
      if (update.previousDigest !== marker.binarySha256) throw new Error("Managed Docker host executable changed");
      await verifyBackup(home, instance, update.previousDigest);
      await armRecovery(home, instance);
      await io.service(["systemctl", "--user", "daemon-reload"]);
      update = { ...update, phase: "starting" };
      await saveUpdate(home, instance, update);
      trialMarker = { ...marker, pendingBinarySha256: sha256(candidate) };
      await writeMarker(trialMarker);
      await atomicReplace(p.binary, candidate, 0o700);
    } finally {
      await unlock();
    }
    await service("start");
    const timeout = Date.now() + 90_000;
    for (;;) {
      // Only a fresh successful poll from the trial may confirm health.
      const polled = (await store.load()).lastPollAt;
      if (polled !== undefined && polled !== previousHealth) {
        await service("is-active");
        break;
      }
      if (Date.now() >= timeout) throw new Error("Docker host update did not reconnect");
      await Bun.sleep(1000);
    }
    if (!trialMarker?.pendingBinarySha256) throw new Error("Missing Docker host trial marker");
    await writeMarker({
      installationId: trialMarker.installationId,
      unit: trialMarker.unit,
      binarySha256: trialMarker.pendingBinarySha256,
    });
    await saveUpdate(home, instance, { ...update, phase: "updated" });
  } catch {
    await service("stop");
    await restorePrevious(store, home, instance, update);
    await service("reset-failed").catch(() => {});
    // Retry a transient service-manager failure inside the supervisor. The
    // old release is already restored, so this cannot retry the update.
    await service("start");
  }
}
