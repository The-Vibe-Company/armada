import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../src/daemon.ts";
import { type UpgradeServiceIo, upgradeService, validateInstallation } from "../src/service.ts";

// Real service-management boundary with recorded local executables: no systemd,
// Docker daemon, network or sleeps. Protect service persistence and cleanup refusal.
test("managed service persists registration and refuses cleanup of unknown files", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-service-"));
  const original = { HOME: process.env.HOME, PATH: process.env.PATH };
  try {
    process.env.HOME = home;
    process.env.PATH = `${home}/.local/bin:${original.PATH}`;
    const bin = join(home, ".local/bin");
    const directory = join(home, ".local/state/armada-docker-host");
    await mkdir(bin, { recursive: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(bin, "armada-docker-host"), "verified host bytes", { mode: 0o700 });
    await writeFile(join(bin, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${home}/commands'\n`, { mode: 0o700 });
    const state: State = {
      server: "https://armada.example",
      installationId: crypto.randomUUID(),
      hostId: crypto.randomUUID(),
      hostToken: "a".repeat(64),
      receipts: [],
    };
    const serviceModule = new URL("../src/service.ts", import.meta.url).pathname;
    const run = (code: string) =>
      Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `import {installService,uninstallPreflight,removeInstallation} from ${JSON.stringify(serviceModule)}; const state=${JSON.stringify(state)}; ${code}`,
        ],
        { env: { ...process.env, HOME: home, PATH: `${bin}:${original.PATH}` }, stdout: "pipe", stderr: "pipe" },
      );
    const installed = run("await installService(state)");
    expect(installed.exitCode).toBe(0);
    const unit = await readFile(join(home, ".config/systemd/user/armada-docker-host.service"), "utf8");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain(`run --state-dir "${directory}"`);
    expect(unit).not.toContain(state.hostToken);
    expect(await readFile(join(home, "commands"), "utf8")).toContain("--user enable --now armada-docker-host.service");
    await writeFile(join(directory, "unrelated.txt"), "keep");
    const refused = run("await uninstallPreflight(state)");
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain("Unknown files");
    expect(await readFile(join(directory, "unrelated.txt"), "utf8")).toBe("keep");
    await rm(join(directory, "unrelated.txt"));
    await writeFile(join(directory, "state.json"), JSON.stringify(state), { mode: 0o600 });
    await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const failedRemoval = run("await removeInstallation()");
    expect(failedRemoval.exitCode).not.toBe(0);
    expect(await readFile(join(directory, "state.json"), "utf8")).toBe(JSON.stringify(state));
    expect(await readFile(join(home, ".config/systemd/user/armada-docker-host.service"), "utf8")).toBe(unit);
    await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    expect(run("await removeInstallation()").exitCode).toBe(0);
    expect(await Bun.file(join(bin, "armada-docker-host")).exists()).toBe(false);
  } finally {
    process.env.HOME = original.HOME;
    process.env.PATH = original.PATH;
    await rm(home, { recursive: true, force: true });
  }
});

// Real filesystem boundary; service/lock recording needs no child or wall-clock wait.
async function upgradeFixture() {
  const home = await mkdtemp(join(tmpdir(), "armada-upgrade-"));
  const binary = join(home, ".local/bin/armada-docker-host");
  const directory = join(home, ".local/state/armada-docker-host");
  const markerFile = join(directory, "managed.json");
  const unitFile = join(home, ".config/systemd/user/armada-docker-host.service");
  const executable = join(home, "verified-download");
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
  await writeFile(executable, newBytes, { mode: 0o700 });
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
  const io: UpgradeServiceIo = {
    home,
    executable,
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
    executable,
    oldBytes,
    newBytes,
    hash,
    state,
    unit,
    marker,
    events,
    store,
    io,
  };
}

test("verified native upgrade atomically swaps the binary and preserves credentials, unit and enabled service", async () => {
  const f = await upgradeFixture();
  try {
    const oldInode = (await lstat(f.binary)).ino;
    const stateBytes = await readFile(join(f.directory, "state.json"), "utf8");
    await upgradeService(f.store, f.state.server, f.io);
    expect(await readFile(f.binary, "utf8")).toBe(f.newBytes);
    expect((await lstat(f.binary)).ino).not.toBe(oldInode);
    expect(await readFile(f.executable, "utf8")).toBe(f.newBytes);
    expect(JSON.parse(await readFile(f.markerFile, "utf8"))).toEqual({ ...f.marker, binarySha256: f.hash(f.newBytes) });
    expect(await readFile(join(f.directory, "state.json"), "utf8")).toBe(stateBytes);
    expect(await readFile(f.unitFile, "utf8")).toBe(f.unit);
    expect(f.events).toEqual([
      "systemctl --user stop armada-docker-host.service",
      "lock",
      "unlock",
      "systemctl --user start armada-docker-host.service",
    ]);
    await validateInstallation(f.state, f.home);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test.each(["before swap", "after swap"])(
  "an interrupted upgrade %s accepts the old/pending digest and can finalize a later verified upgrade",
  async (phase) => {
    const f = await upgradeFixture();
    try {
      await writeFile(f.markerFile, JSON.stringify({ ...f.marker, pendingBinarySha256: f.hash(f.newBytes) }));
      if (phase === "after swap") await writeFile(f.binary, f.newBytes);
      await validateInstallation(f.state, f.home);
      await writeFile(f.executable, "later verified binary");
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
        await symlink(f.executable, path);
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

test("same verified binary with a stable marker leaves the running service untouched", async () => {
  const f = await upgradeFixture();
  try {
    await writeFile(f.executable, f.oldBytes);
    const inode = (await lstat(f.binary)).ino;
    const marker = await readFile(f.markerFile, "utf8");
    await upgradeService(f.store, f.state.server, f.io);
    expect(f.events).toEqual([]);
    expect((await lstat(f.binary)).ino).toBe(inode);
    expect(await readFile(f.markerFile, "utf8")).toBe(marker);
    expect(await f.store.load()).toEqual(f.state);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});
