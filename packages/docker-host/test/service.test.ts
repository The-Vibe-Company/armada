import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../src/daemon.ts";
import {
  createManagedUpdater,
  installService,
  instanceName,
  removeInstallation,
  type ServicePreflightIo,
  servicePreflight,
  stateDirectory,
  type UpgradeServiceIo,
  upgradeService,
  validateInstallation,
} from "../src/service.ts";

test("servicePreflight checks docker, flock, systemctl, and linger in order and succeeds when ready", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-preflight-"));
  try {
    const calls: string[][] = [];
    await servicePreflight(undefined, {
      home,
      platform: "linux",
      execPath: join(home, ".local/bin/armada-docker-host"),
      uid: 1000,
      docker: async (args) => {
        calls.push(["docker", ...args]);
        return { exitCode: 0 };
      },
      service: async (args) => {
        calls.push(args);
        return args[1] === "show-user" ? "yes\n" : "";
      },
    });
    expect(calls).toEqual([
      ["docker", "info"],
      ["flock", "--version"],
      ["systemctl", "--user", "show-environment"],
      ["loginctl", "enable-linger"],
      ["loginctl", "show-user", "1000", "--property=Linger", "--value"],
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.each([
  ["docker exit", /Docker preflight failed.*Docker daemon is running/, /flock|systemd|linger/i, { dockerExit: 1 }],
  ["docker error", /Docker preflight failed.*Docker daemon is running/, /flock|systemd|linger/i, { dockerThrow: true }],
  ["flock", /Missing required tool 'flock': install util-linux \(flock\)/, /systemd|linger|docker/i, { fail: "flock" }],
  ["systemctl", /Systemd user session unavailable.*systemctl/, /flock|linger|docker/i, { fail: "systemctl" }],
  [
    "enable-linger",
    /Failed to enable systemd user lingering.*loginctl enable-linger/,
    /flock|docker/i,
    { fail: "enable-linger" },
  ],
  [
    "show-user",
    /Failed to verify systemd user lingering.*loginctl enable-linger/,
    /flock|docker/i,
    { fail: "show-user" },
  ],
  [
    "linger disabled",
    /Systemd user lingering is not enabled.*loginctl enable-linger/,
    /flock|docker/i,
    { linger: "no raw-stderr" },
  ],
] as const)(
  "servicePreflight surfaces a distinct secret-safe error for %s",
  async (_name, expected, forbidden, cfg) => {
    const leak = () => Object.assign(new Error("raw-stderr-sentinel"), { code: "ENOENT" });
    const io: ServicePreflightIo = {
      home: "/nonexistent-home",
      platform: "linux",
      execPath: "/nonexistent-home/.local/bin/armada-docker-host",
      uid: 1000,
      docker: async () => {
        if ("dockerThrow" in cfg) throw leak();
        return { exitCode: "dockerExit" in cfg ? cfg.dockerExit : 0 };
      },
      service: async (args) => {
        if ("fail" in cfg && args.includes(cfg.fail)) throw leak();
        return args[1] === "show-user" ? ("linger" in cfg ? cfg.linger : "yes") : "";
      },
    };
    const caught = await servicePreflight(undefined, io).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(expected);
    expect((caught as Error).message).not.toMatch(forbidden);
    expect((caught as Error).message).not.toContain("raw-stderr");
    expect("code" in (caught as Error)).toBe(false);
  },
);

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
    const orphan = join(directory, `.state-${crypto.randomUUID()}`);
    await writeFile(orphan, "{", { mode: 0o600 });
    const recovery = createManagedUpdater(directory, true, `${binary}.previous`, {
      ...io,
      fetch,
      version: "",
      now: Date.now,
    });
    await recovery?.beforeStart(state);
    await rm(orphan);

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
      "Host artifact SHA-256 mismatch. Check the server and retry: run a fresh installer command",
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

function selfUpdateFixture() {
  const home = "/owner";
  const directory = stateDirectory(home);
  const binary = join(home, ".local/bin/armada-docker-host");
  const unit = join(home, ".config/systemd/user/armada-docker-host.service");
  const hook = join(`${unit}.d`, "armada-update.conf");
  const previous = `${binary}.previous`;
  const marker = join(directory, "managed.json");
  const old = Buffer.from("installed executable");
  const candidate = Buffer.from("new release executable");
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const state: State = {
    server: "https://armada.example",
    installationId: "installation",
    hostId: "host",
    hostToken: "fixture-token",
    receipts: [],
  };
  const files = new Map<string, Buffer>([
    [binary, old],
    [marker, Buffer.from(JSON.stringify({ installationId: state.installationId, binarySha256: hash(old), unit }))],
  ]);
  const requests: string[] = [];
  const target = "2.0.0";
  const config = {
    now: 0,
    version: target,
    bytes: candidate,
    artifactStatus: 200,
    interruptedSwap: false,
    managed: true,
    systemd: 252,
  };
  const ownedFile = async (path: string) => {
    const bytes = files.get(path);
    if (!bytes) throw new Error("File missing");
    return bytes;
  };
  const io = {
    home,
    version: "1.0.0",
    now: () => config.now,
    service: async (args: string[]) => {
      if (args[0] === "systemd-notify") return `systemd ${config.systemd} (${config.systemd}.1)`;
      if (args.includes("--value")) return files.has(hook) ? hook : "";
      if (args.includes("show"))
        return [
          `MainPID=${config.managed ? process.pid : 0}`,
          `FragmentPath=${unit}`,
          `DropInPaths=${files.has(hook) ? hook : ""}`,
          "NeedDaemonReload=no",
          "Restart=on-failure",
        ].join("\n");
    },
    fetch: async (url: string) => {
      requests.push(url);
      return url.endsWith("/install.json")
        ? Response.json({ version: config.version, [process.arch]: hash(candidate) })
        : new Response(config.bytes, { status: config.artifactStatus });
    },
    files: {
      ownedFile,
      async readManagedInstallation() {
        return JSON.parse((await ownedFile(marker)).toString());
      },
      async atomicReplace(path: string, bytes: Uint8Array) {
        if (config.interruptedSwap && path === binary) throw new Error("Interrupted atomic swap");
        files.set(path, Buffer.from(bytes));
      },
      mkdir: async () => undefined,
      syncDirectory: async () => {},
      safeAncestors: async () => {},
    },
  };
  const daemon = (version = io.version) => createManagedUpdater(directory, false, binary, { ...io, version })!;
  const recovery = () => createManagedUpdater(directory, true, previous, io)!;
  return { binary, previous, files, old, candidate, state, config, target, requests, hash, daemon, recovery };
}

test.skipIf(process.platform !== "linux")(
  "self-update uses verified platform bytes and commits after startup health",
  async () => {
    const f = selfUpdateFixture();
    const daemon = f.daemon();
    expect(await daemon.stage(f.state, f.target)).toBe(true);
    expect(f.requests).toEqual([
      `${f.state.server}/api/docker-host/install.json`,
      `${f.state.server}/api/runtime/artifacts/${f.hash(f.candidate)}`,
    ]);
    expect(f.files.get(f.binary)).toEqual(f.old);
    expect(await daemon.swap()).toBe(true);
    expect(f.files.get(f.previous)).toEqual(f.old);
    await f.recovery().beforeStart(f.state);
    const candidate = f.daemon(f.target);
    await candidate.checkStartup(f.state, async () => expect(candidate.result()).toBeUndefined());
    expect(candidate.result()).toBe(`${f.target};updated;${f.config.now}`);
    await f.recovery().beforeStart(f.state);
    expect(f.files.get(f.binary)).toEqual(f.candidate);
  },
);

test.skipIf(process.platform !== "linux").each(["swap", "start", "health"])(
  "self-update recovers from a failed %s and retries only different versions after cooldown",
  async (phase) => {
    const f = selfUpdateFixture();
    const daemon = f.daemon();
    expect(await daemon.stage(f.state, f.target)).toBe(true);
    if (phase === "swap") {
      f.config.interruptedSwap = true;
      await expect(daemon.swap()).rejects.toThrow("Interrupted atomic swap");
      f.config.interruptedSwap = false;
    } else {
      await daemon.swap();
      await f.recovery().beforeStart(f.state);
      if (phase === "health") {
        await expect(
          f.daemon(f.target).checkStartup(f.state, async () => {
            throw new Error("Offline");
          }),
        ).rejects.toThrow("Offline");
      }
    }
    await f.recovery().beforeStart(f.state);
    expect(f.files.get(f.binary)).toEqual(f.old);
    const restored = f.daemon();
    await restored.checkStartup(f.state, async () => {
      throw new Error("Unexpected candidate health check");
    });
    expect(restored.result()).toBe(`${f.target};failed;${f.config.now};startup_failed`);
    const next = "2.0.1";
    expect(await restored.stage(f.state, next)).toBe(false);
    f.config.now = 60 * 60_000;
    expect(await restored.stage(f.state, f.target)).toBe(false);
    expect(f.requests).toHaveLength(2);
    f.config.version = next;
    expect(await restored.stage(f.state, next)).toBe(true);
  },
);

test
  .skipIf(process.platform !== "linux")
  .each(["version", "unavailable artifact", "digest", "unmanaged", "older systemd"])(
  "self-update leaves the active binary alone on %s refusal",
  async (refusal) => {
    const f = selfUpdateFixture();
    const daemon = f.daemon();
    if (refusal === "version") {
      f.config.version = "3.0.0";
      expect(await daemon.stage(f.state, f.target)).toBe(false);
      expect(f.requests).toHaveLength(1);
    } else if (refusal === "unavailable artifact") {
      f.config.artifactStatus = 404;
      expect(await daemon.stage(f.state, f.target)).toBe(false);
      expect(f.requests).toHaveLength(2);
    } else if (refusal === "digest") {
      f.config.bytes = Buffer.from("wrong artifact");
      await expect(daemon.stage(f.state, f.target)).rejects.toThrow("SHA-256 mismatch");
    } else {
      f.config.managed = refusal !== "unmanaged";
      if (refusal === "older systemd") f.config.systemd = 245;
      expect(await daemon.stage(f.state, f.target)).toBe(false);
      expect(f.requests).toEqual([]);
    }
    expect(await daemon.swap()).toBe(false);
    expect(f.files.get(f.binary)).toEqual(f.old);
    expect(f.files.has(f.previous)).toBe(false);
    if (refusal === "version" || refusal === "unavailable artifact") {
      expect(daemon.result()).toBeUndefined();
      f.config.version = f.target;
      f.config.artifactStatus = 200;
      expect(await f.daemon().stage(f.state, f.target)).toBe(true);
    }
  },
);
