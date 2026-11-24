import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../src/daemon.ts";
import {
  installService,
  instanceName,
  removeInstallation,
  stateDirectory,
  type UpgradeServiceIo,
  upgradeService,
  validateInstallation,
} from "../src/service.ts";

test("managed service persists registration and refuses cleanup of unknown files", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-service-"));
  try {
    const bin = join(home, ".local/bin");
    const binary = join(bin, "armada-docker-host");
    const directory = stateDirectory(home);
    const unitFile = join(home, ".config/systemd/user/armada-docker-host.service");
    const stateFile = join(directory, "state.json");
    const markerFile = join(directory, "managed.json");
    await mkdir(bin, { recursive: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(binary, "verified host bytes", { mode: 0o700 });
    const state: State = {
      server: "https://armada.example",
      installationId: crypto.randomUUID(),
      hostId: crypto.randomUUID(),
      hostToken: "fixture-token",
      receipts: [],
    };
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
    const commands: string[][] = [];
    const io = {
      home,
      service: async (args: string[]) => {
        commands.push(args);
      },
    };
    await installService(state, undefined, io);
    const unit = await readFile(unitFile, "utf8");
    const marker = await readFile(markerFile, "utf8");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain(`run --state-dir "${directory}"`);
    expect(unit).not.toContain(state.hostToken);
    expect(commands).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "armada-docker-host.service"],
    ]);

    const unrelated = join(directory, "unrelated.txt");
    await writeFile(unrelated, "keep");
    await expect(validateInstallation(state, home)).rejects.toThrow("Unknown files");
    expect(await readFile(unrelated, "utf8")).toBe("keep");
    await rm(unrelated);

    for (const cache of ["runtime-cache", "artifact-cache", "artifact-cache-private"]) {
      await mkdir(join(directory, cache), { mode: cache === "artifact-cache" ? 0o755 : 0o700 });
      await writeFile(join(directory, cache, "a".repeat(64)), "public bytes", { mode: 0o444 });
    }
    await validateInstallation(state, home);
    const reloadFailure = new Error("systemd reload failed");
    await expect(
      removeInstallation(undefined, {
        home,
        service: async () => {
          throw reloadFailure;
        },
      }),
    ).rejects.toBe(reloadFailure);
    expect(await readFile(stateFile, "utf8")).toBe(JSON.stringify(state));
    expect(await readFile(unitFile, "utf8")).toBe(unit);
    expect(await readFile(markerFile, "utf8")).toBe(marker);

    await removeInstallation(undefined, io);
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(binary)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function upgradeFixture(instance?: string) {
  const fixtureDirectory =
    process.platform === "linux"
      ? await access("/dev/shm", constants.W_OK | constants.X_OK).then(
          () => "/dev/shm",
          () => tmpdir(),
        )
      : tmpdir();
  const home = await mkdtemp(join(fixtureDirectory, "armada-upgrade-"));
  const binary = join(home, ".local/bin", instanceName(instance));
  const directory = stateDirectory(home, instance);
  const markerFile = join(directory, "managed.json");
  const unitFile = join(home, ".config/systemd/user", `${instanceName(instance)}.service`);
  const oldBytes = "previous verified binary",
    newBytes = "new verified binary";
  const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const state: State = {
    server: "https://armada.example",
    installationId: crypto.randomUUID(),
    hostId: crypto.randomUUID(),
    hostToken: "a".repeat(64),
    receipts: [],
    lastPollAt: "2026-11-13T00:00:00.000Z",
  };
  const unit = "[Service]\nExecStart=registered service command\n";
  const marker = { installationId: state.installationId, binarySha256: hash(oldBytes), unit };
  for (const path of [join(home, ".local/bin"), directory, join(home, ".config/systemd/user")])
    await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(binary, oldBytes, { mode: 0o700 });

  await writeFile(unitFile, unit, { mode: 0o600 });
  await writeFile(markerFile, JSON.stringify(marker), { mode: 0o600 });
  await writeFile(join(directory, "state.json"), JSON.stringify(state), { mode: 0o600 });
  const events: string[] = [];
  const store = {
    load: async (): Promise<State> => JSON.parse(await readFile(join(directory, "state.json"), "utf8")),
    lock: async () => {
      events.push("lock");
      return async () => {
        events.push("unlock");
      };
    },
  };
  const requests: string[] = [];
  const download = { pin: newBytes, artifact: newBytes };
  const io: UpgradeServiceIo = {
    home,
    fetch: async (url) => {
      requests.push(url);
      if (url === `${state.server}/api/docker-host/install.json`)
        return Response.json({ [process.arch]: hash(download.pin) });
      if (url === `${state.server}/api/runtime/artifacts/${hash(download.pin)}`) return new Response(download.artifact);
      throw new Error("Unexpected upgrade URL");
    },
    service: async (args) => {
      events.push(args.join(" "));
    },
  };
  return {
    home,
    binary,
    directory,
    markerFile,
    unitFile,
    oldBytes,
    newBytes,
    hash,
    state,
    unit,
    marker,
    events,
    requests,
    download,
    store,
    io,
  };
}

test.each(["before swap", "after swap"])(
  "an interrupted upgrade %s accepts the old/pending digest and can finalize a later verified upgrade",
  async (phase) => {
    const f = await upgradeFixture();
    try {
      await writeFile(f.markerFile, JSON.stringify({ ...f.marker, pendingBinarySha256: f.hash(f.newBytes) }));
      if (phase === "after swap") await writeFile(f.binary, f.newBytes);
      await validateInstallation(f.state, f.home);
      f.download.pin = f.download.artifact = "later verified binary";
      await upgradeService(f.store, f.state.server, f.io);
      expect(await readFile(f.binary, "utf8")).toBe("later verified binary");
      expect(JSON.parse(await readFile(f.markerFile, "utf8"))).toEqual({
        ...f.marker,
        binarySha256: f.hash("later verified binary"),
      });
      await validateInstallation(f.state, f.home);
    } finally {
      await rm(f.home, { recursive: true, force: true });
    }
  },
);

test("failed binary swap keeps the pending marker recoverable and restarts the service without changing registration", async () => {
  const f = await upgradeFixture();
  try {
    f.io.service = async (args) => {
      f.events.push(args.join(" "));
      if (args.includes("stop")) await chmod(join(f.home, ".local/bin"), 0o500);
    };
    await expect(upgradeService(f.store, f.state.server, f.io)).rejects.toThrow();
    expect(f.events).toEqual([
      "systemctl --user stop armada-docker-host.service",
      "lock",
      "unlock",
      "systemctl --user start armada-docker-host.service",
    ]);
    expect(await readFile(f.binary, "utf8")).toBe(f.oldBytes);
    expect(JSON.parse(await readFile(f.markerFile, "utf8"))).toEqual({
      ...f.marker,
      pendingBinarySha256: f.hash(f.newBytes),
    });
    expect(await f.store.load()).toEqual(f.state);
    await validateInstallation(f.state, f.home);
  } finally {
    await chmod(join(f.home, ".local/bin"), 0o700);
    await rm(f.home, { recursive: true, force: true });
  }
});

test.each([
  "server",
  "binary",
  "unit",
  "marker",
  "pending digest",
  "binary symlink",
  "unit symlink",
  "marker symlink",
  "parent symlink",
  "permissions",
])("upgrade refuses changed or unsafe %s before stopping the service", async (change) => {
  const f = await upgradeFixture();
  try {
    let server = f.state.server;
    if (change === "server") server = "https://different.example";
    if (change === "binary") await writeFile(f.binary, "unexpected bytes");
    if (change === "unit") await writeFile(f.unitFile, "unexpected service");
    if (change === "marker")
      await writeFile(f.markerFile, JSON.stringify({ ...f.marker, installationId: crypto.randomUUID() }));
    if (change === "pending digest")
      await writeFile(f.markerFile, JSON.stringify({ ...f.marker, pendingBinarySha256: "not-a-digest" }));
    if (change === "permissions") await chmod(f.markerFile, 0o644);
    for (const [name, path] of [
      ["binary symlink", f.binary],
      ["unit symlink", f.unitFile],
      ["marker symlink", f.markerFile],
    ] as const) {
      if (change === name) {
        await rm(path);
        await symlink(f.directory, path);
      }
    }
    if (change === "parent symlink") {
      const parent = join(f.home, ".config/systemd/user"),
        elsewhere = join(f.home, "elsewhere");
      await mkdir(elsewhere, { mode: 0o700 });
      await writeFile(join(elsewhere, "armada-docker-host.service"), f.unit, { mode: 0o600 });
      await rm(parent, { recursive: true });
      await symlink(elsewhere, parent);
    }
    await expect(upgradeService(f.store, server, f.io)).rejects.toThrow();
    expect(f.events).toEqual([]);
    expect(await f.store.load()).toEqual(f.state);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("a matching server pin starts the service without replacing the binary", async () => {
  const f = await upgradeFixture();
  try {
    f.download.pin = f.oldBytes;
    const inode = (await lstat(f.binary)).ino;
    const marker = await readFile(f.markerFile, "utf8");
    await upgradeService(f.store, f.state.server, f.io);
    expect(f.events).toEqual(["systemctl --user start armada-docker-host.service"]);
    expect(f.requests).toEqual([`${f.state.server}/api/docker-host/install.json`]);
    expect((await lstat(f.binary)).ino).toBe(inode);
    expect(await readFile(f.markerFile, "utf8")).toBe(marker);
    expect(await f.store.load()).toEqual(f.state);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("an artifact that fails SHA-256 verification leaves the installation running", async () => {
  const f = await upgradeFixture();
  try {
    f.download.artifact = "unexpected artifact";
    await expect(upgradeService(f.store, f.state.server, f.io)).rejects.toThrow(
      "Host artifact SHA-256 mismatch. Check the server and retry:",
    );
    expect(f.events).toEqual([]);
    expect(await readFile(f.binary, "utf8")).toBe(f.oldBytes);
    await validateInstallation(f.state, f.home);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("upgrade refuses success if the binary differs from the server pin after service start", async () => {
  const f = await upgradeFixture();
  try {
    f.io.service = async (args) => {
      if (args.includes("start")) await writeFile(f.binary, f.oldBytes);
    };
    await expect(upgradeService(f.store, f.state.server, f.io)).rejects.toThrow(
      "Installed Docker host SHA-256 differs from the server pin.",
    );
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("verified namespaced upgrade atomically replaces its own binary and preserves its registration and the default binary", async () => {
  const instance = createHash("sha256").update("https://second.example").digest("hex");
  const f = await upgradeFixture(instance);
  try {
    const legacy = join(f.home, ".local/bin/armada-docker-host");
    await writeFile(legacy, "legacy untouched", { mode: 0o700 });
    const oldInode = (await lstat(f.binary)).ino;
    const stateFile = join(f.directory, "state.json");
    const stateBytes = await readFile(stateFile, "utf8");
    await upgradeService(f.store, f.state.server, f.io, instance);
    expect(await readFile(f.binary, "utf8")).toBe(f.newBytes);
    expect((await lstat(f.binary)).ino).not.toBe(oldInode);
    expect(f.requests).toEqual([
      `${f.state.server}/api/docker-host/install.json`,
      `${f.state.server}/api/runtime/artifacts/${f.hash(f.newBytes)}`,
    ]);
    expect(JSON.parse(await readFile(f.markerFile, "utf8"))).toEqual({ ...f.marker, binarySha256: f.hash(f.newBytes) });
    expect(await readFile(stateFile, "utf8")).toBe(stateBytes);
    expect(await readFile(f.unitFile, "utf8")).toBe(f.unit);
    expect(await readFile(legacy, "utf8")).toBe("legacy untouched");
    expect(f.events).toEqual([
      `systemctl --user stop armada-docker-host@${instance}.service`,
      "lock",
      "unlock",
      `systemctl --user start armada-docker-host@${instance}.service`,
    ]);
    await validateInstallation(f.state, f.home, instance);
    expect(() => stateDirectory(f.home, "../escape")).toThrow("Invalid Docker host instance");
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});
