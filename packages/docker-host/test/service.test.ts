import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../../core/src/version.ts";
import { type Job, runJobs, type State, tick } from "../src/daemon.ts";
import { httpApi } from "../src/native.ts";
import {
  automaticUpdate,
  instanceName,
  prepareUninstall,
  recoverUpdate,
  stateDirectory,
  superviseUpdate,
  type UpgradeServiceIo,
  upgradeService,
  validateInstallation,
} from "../src/service.ts";

// Real service-management boundary with recorded local executables: no systemd,
// Docker daemon, network or sleeps. Protect service persistence and cleanup refusal.
test("managed service persists registration and refuses cleanup of unknown files", async () => {
  const home = await mkdtemp(join(tmpdir(), "armada-service-"));
  const original = { HOME: process.env.HOME, PATH: process.env.PATH };
  try {
    process.env.HOME = home;
    process.env.PATH = `${home}/.local/bin:${original.PATH}`;
    const bin = join(home, ".local/bin");
    const directory = stateDirectory(home);
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
    // Daemon-owned artifact caches (#2562) are neither unknown files nor left behind.
    for (const cache of ["runtime-cache", "artifact-cache", "artifact-cache-private"]) {
      await mkdir(join(directory, cache), { mode: cache === "artifact-cache" ? 0o755 : 0o700 });
      await writeFile(join(directory, cache, "a".repeat(64)), "public bytes", { mode: 0o444 });
    }
    expect(run("await uninstallPreflight(state)").stderr.toString()).not.toContain("Unknown files");
    await writeFile(join(directory, "state.json"), JSON.stringify(state), { mode: 0o600 });
    // The new rollback copy was renamed before the staging record could be finalized.
    const backup = join(bin, "armada-docker-host.previous");
    await writeFile(backup, "verified host bytes", { mode: 0o700 });
    await writeFile(
      join(directory, "update.json"),
      JSON.stringify({
        version: "9.0.0",
        phase: "failed",
        previousDigest: createHash("sha256").update("older binary").digest("hex"),
        pendingPreviousDigest: createHash("sha256").update("verified host bytes").digest("hex"),
      }),
      { mode: 0o600 },
    );
    const intent = join(directory, "uninstall-pending");
    const journal = join(directory, "update.json");
    const contents = await readFile(journal, "utf8");
    await writeFile(intent, "", { mode: 0o600 });
    // Insert a non-owned file at daemon-reload so the final rmdir fails
    // after the owned update files have already been removed.
    const unrelated = join(directory, "late-unrelated");
    await writeFile(join(bin, "systemctl"), `#!/bin/sh\ntouch '${unrelated}'\n`, { mode: 0o700 });
    const failedRemoval = run("await removeInstallation()");
    expect(failedRemoval.exitCode).not.toBe(0);
    expect(await readFile(journal, "utf8")).toBe(contents);
    expect(await readFile(backup, "utf8")).toBe("verified host bytes");
    expect((await lstat(backup)).mode & 0o777).toBe(0o700);
    expect(await Bun.file(intent).exists()).toBe(true);
    expect(await readFile(join(directory, "state.json"), "utf8")).toBe(JSON.stringify(state));
    expect(await readFile(join(home, ".config/systemd/user/armada-docker-host.service"), "utf8")).toBe(unit);
    await writeFile(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await rm(unrelated);
    expect(run("await removeInstallation()").exitCode).toBe(0);
    expect(await Bun.file(join(bin, "armada-docker-host")).exists()).toBe(false);
    expect(await Bun.file(backup).exists()).toBe(false);
  } finally {
    process.env.HOME = original.HOME;
    process.env.PATH = original.PATH;
    await rm(home, { recursive: true, force: true });
  }
});

// Real filesystem boundary; service/lock recording needs no child or wall-clock wait.
async function upgradeFixture(instance?: string) {
  const home = await mkdtemp(join(tmpdir(), "armada-upgrade-"));
  const binary = join(home, ".local/bin", instanceName(instance));
  const directory = stateDirectory(home, instance);
  const markerFile = join(directory, "managed.json");
  const unitFile = join(home, ".config/systemd/user", `${instanceName(instance)}.service`);
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

test("managed uninstall reaches unregister after a legacy server rejects the cleanup probe", async () => {
  const f = await upgradeFixture();
  try {
    const preload = join(f.home, "legacy-server.ts");
    await writeFile(
      preload,
      `globalThis.fetch = async (url, options) => {
        const path = new URL(url).pathname;
        const body = JSON.parse(options.body);
        console.log(JSON.stringify({ path, body }));
        if (path.endsWith("/poll")) return new Response(null, { status: 400 });
        // End at unregister before invoking Docker or systemd.
        return new Response(null, { status: 503 });
      };`,
    );
    const result = Bun.spawnSync(
      [process.execPath, "--preload", preload, join(import.meta.dir, "../src/main.ts"), "uninstall"],
      { env: { ...process.env, HOME: f.home } },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Host request denied");
    expect(
      result.stdout
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        path: "/api/docker-host/poll",
        body: expect.objectContaining({ heartbeatOnly: true, cleanupOnly: true }),
      },
      { path: "/api/docker-host/unregister", body: { installationId: f.state.installationId } },
    ]);
    expect(await readFile(join(f.directory, "uninstall-pending"), "utf8")).toBe("legacy");
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

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

test("namespaced upgrade changes only its own binary and service, preserving legacy installation", async () => {
  const instance = createHash("sha256").update("https://second.example").digest("hex");
  const f = await upgradeFixture(instance);
  try {
    const legacy = join(f.home, ".local/bin/armada-docker-host");
    await writeFile(legacy, "legacy untouched", { mode: 0o700 });
    await upgradeService(f.store, f.state.server, f.io, instance);
    expect(await readFile(f.binary, "utf8")).toBe(f.newBytes);
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

test.each(["healthy", "failed start", "crashes immediately", "crashes after first write", "crash-loops under systemd"])(
  "automatic update commits or restores the managed binary after %s",
  async (outcome) => {
    const f = await upgradeFixture();
    try {
      const journal = join(f.directory, "update.json");
      await writeFile(`${f.binary}.previous`, f.oldBytes, { mode: 0o700 });
      await writeFile(join(f.directory, "update-candidate"), f.newBytes, { mode: 0o600 });
      await writeFile(
        journal,
        JSON.stringify({
          version: VERSION,
          phase: "staged",
          previousDigest: f.hash(f.oldBytes),
          candidateDigest: f.hash(f.newBytes),
        }),
        { mode: 0o600 },
      );
      const starts: string[] = [];
      const firstInvocation = "1".repeat(32);
      const replacement = "2".repeat(32);
      await superviseUpdate(f.store, undefined, {
        home: f.home,
        async service(args) {
          if (args.includes("start")) {
            const binary = await readFile(f.binary, "utf8");
            starts.push(binary);
            if (binary === f.oldBytes) return;
            if (outcome === "failed start") throw new Error("exec failed");
            if (outcome !== "crashes immediately") {
              const invocation = process.env.INVOCATION_ID;
              const unexpected = async () => {
                throw new Error("Trial must not admit work");
              };
              try {
                process.env.INVOCATION_ID = firstInvocation;
                const updater = automaticUpdate(f.state, { home: f.home });
                await tick(
                  {
                    load: f.store.load,
                    async save(state) {
                      await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
                    },
                  },
                  {
                    poll: async () => ({ job: null, updateVersion: VERSION }),
                    register: unexpected,
                    result: unexpected,
                  },
                  { create: unexpected, stop: unexpected, delete: unexpected, stopIfExpired: unexpected },
                  false,
                  Date.now,
                  { trialPoll: updater.trialPoll, reconcileOnly: true },
                );
              } finally {
                if (invocation === undefined) delete process.env.INVOCATION_ID;
                else process.env.INVOCATION_ID = invocation;
              }
              const { trialId } = JSON.parse(await readFile(journal, "utf8"));
              expect((await f.store.load()).trialPoll).toEqual({
                version: VERSION,
                trialId,
                invocationId: firstInvocation,
              });
            }
          }
          if (args.includes("InvocationID")) {
            const active = outcome !== "crashes immediately";
            const restarted = outcome === "crashes after first write" || outcome === "crash-loops under systemd";
            return [
              `ActiveState=${active ? "active" : "activating"}`,
              `MainPID=${active ? (restarted ? "1002" : "1001") : "0"}`,
              `InvocationID=${restarted ? replacement : firstInvocation}`,
              `NRestarts=${outcome === "crash-loops under systemd" ? "3" : restarted ? "1" : "0"}`,
            ].join("\n");
          }
        },
      });
      const expected = outcome === "healthy" ? f.newBytes : f.oldBytes;
      expect(await readFile(f.binary, "utf8")).toBe(expected);
      expect(starts).toEqual(outcome === "healthy" ? [f.newBytes] : [f.newBytes, f.oldBytes]);
      expect(await readFile(`${f.binary}.previous`, "utf8")).toBe(f.oldBytes);
      expect(JSON.parse(await readFile(journal, "utf8")).phase).toBe(outcome === "healthy" ? "updated" : "failed");
      expect((await validateInstallation(f.state, f.home)).binarySha256).toBe(f.hash(expected));
      expect((await f.store.load()).hostToken).toBe(f.state.hostToken);
      expect(await readFile(f.unitFile, "utf8")).toBe(f.unit);
    } finally {
      await rm(f.home, { recursive: true, force: true });
    }
  },
);

async function writeUpdateFixture(
  f: Awaited<ReturnType<typeof upgradeFixture>>,
  phase: "staged" | "starting" | "cancelled" | "failed" | "updated",
  preparing = false,
) {
  const journal = join(f.directory, "update.json");
  await writeFile(`${f.binary}.previous`, f.oldBytes, { mode: 0o700 });
  await writeFile(
    journal,
    JSON.stringify({
      version: "9.0.0",
      phase,
      ...(preparing ? { preparing: true } : {}),
      previousDigest: f.hash(f.oldBytes),
      candidateDigest: f.hash(f.newBytes),
    }),
    { mode: 0o600 },
  );
  return journal;
}

async function interruptedTrial(f: Awaited<ReturnType<typeof upgradeFixture>>) {
  await writeFile(f.binary, f.newBytes);
  await writeFile(f.markerFile, JSON.stringify({ ...f.marker, pendingBinarySha256: f.hash(f.newBytes) }));
  return writeUpdateFixture(f, "starting");
}

test.each([
  "artifact unavailable",
  "backup rename interrupted",
  "offer withdrawn",
  "poll failed",
  "supervisor unavailable",
  "reboot before swap",
  "reboot after swap",
  "reboot before commit",
  "reboot after commit",
  "commit directory sync interrupted",
] as const)("update recovers job admission and future eligibility after %s", async (failure) => {
  const f = await upgradeFixture();
  try {
    let now = Date.now();
    let offer = "9.0.0";
    let releaseUnavailable = failure === "artifact unavailable";
    let supervisorRestarting = failure === "commit directory sync interrupted";
    const io = {
      now: () => now,
      async service(args: string[]) {
        if (args.includes("MainPID")) return String(process.pid);
        if (args[0] === "systemd-run") throw new Error("systemd could not start helper");
        if (args.includes("list-units") && supervisorRestarting)
          return "armada-docker-host-update.service loaded activating auto-restart Update";
        return ""; // No transient supervisor survived.
      },
      request: (async (url: string) => {
        if (url.endsWith("/install.json")) {
          const digest = f.hash(f.newBytes);
          return Response.json({ version: offer, x64: digest, arm64: digest });
        }
        return releaseUnavailable ? new Response(null, { status: 503 }) : new Response(f.newBytes);
      }) as typeof fetch,
    };
    const updater = automaticUpdate(f.state, { home: f.home }, io);
    const interruptedCommit = failure === "commit directory sync interrupted";
    const trial = failure.startsWith("reboot") || interruptedCommit;
    const committed = failure === "reboot after commit" || interruptedCommit;
    if (trial) {
      // Build each crash prefix with the files that made it to disk.
      const journal = await writeUpdateFixture(f, "starting");
      if (failure !== "reboot before swap") {
        await writeFile(f.binary, f.newBytes);
        const marker =
          failure === "reboot after swap"
            ? { ...f.marker, pendingBinarySha256: f.hash(f.newBytes) }
            : { ...f.marker, binarySha256: f.hash(f.newBytes) };
        await writeFile(f.markerFile, JSON.stringify(marker));
      }
      if (committed) {
        const record = JSON.parse(await readFile(journal, "utf8"));
        await writeFile(journal, JSON.stringify({ ...record, phase: "updated" }));
      }
      if (interruptedCommit) {
        const service = async () => {
          throw new Error("A committed trial must keep the service running");
        };
        await chmod(f.directory, 0o300);
        try {
          await expect(superviseUpdate(f.store, undefined, { home: f.home, service })).rejects.toThrow();
          await expect(updater.pollMode()).rejects.toThrow();
        } finally {
          await chmod(f.directory, 0o700);
        }
        await superviseUpdate(f.store, undefined, { home: f.home, service });
      } else {
        await recoverUpdate(f.store, undefined, { home: f.home, service: io.service });
      }
      expect(await readFile(f.binary, "utf8")).toBe(committed ? f.newBytes : f.oldBytes);
    } else if (failure === "artifact unavailable") {
      expect(await updater.prepare(offer)).toBe(false);
      releaseUnavailable = false;
    } else if (failure === "backup rename interrupted") {
      await writeFile(
        join(f.directory, "update.json"),
        JSON.stringify({
          version: offer,
          phase: "cancelled",
          preparing: true,
          retryAfter: now + 300_000,
          pendingPreviousDigest: f.hash(f.oldBytes),
        }),
        { mode: 0o600 },
      );
    } else {
      expect(await updater.prepare(offer)).toBe(true);
      if (failure === "supervisor unavailable") {
        expect(await updater.confirm({ type: "offer", version: offer })).toBe(true);
        expect(await updater.restart()).toBe(false);
      } else {
        const event =
          failure === "poll failed"
            ? ({ type: "poll-failed" } as const)
            : ({ type: "offer", version: undefined } as const);
        expect(await updater.confirm(event)).toBe(false);
      }
    }

    // Drive ordinary job admission through the same gate used after a restart.
    const restarted = automaticUpdate(f.state, { home: f.home }, io);
    const job: Job = {
      requestId: crypto.randomUUID(),
      operation: "create",
      request: {
        sandboxId: crypto.randomUUID(),
        generation: crypto.randomUUID(),
        image: `debian@sha256:${"a".repeat(64)}`,
        ttlSeconds: 60,
      },
    };
    const store = {
      load: f.store.load,
      async save(state: State) {
        await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
      },
    };
    const unexpected = async () => {
      throw new Error("Unexpected machine operation");
    };
    let accepted = false;
    await runJobs(
      store,
      {
        register: unexpected,
        async poll() {
          return { job };
        },
        async result(_state, receipt) {
          expect(receipt.outcome).toBe("completed");
        },
      },
      {
        startRuntime: unexpected,
        stopIfExpired: unexpected,
        stop: unexpected,
        delete: unexpected,
        async create(request) {
          accepted = request.sandboxId === job.request.sandboxId;
        },
      },
      { stopping: () => accepted, sleep: async () => {}, now: () => now, update: restarted },
    );
    expect(accepted).toBe(true);
    await validateInstallation(f.state, f.home);
    const expected = committed ? f.newBytes : f.oldBytes;
    expect(await readFile(f.binary, "utf8")).toBe(expected);

    expect(await restarted.prepare(offer)).toBe(false);
    now += 300_000;
    if (trial) {
      // An actual attempt stays fenced even when a newer stage overwrites its journal.
      expect(await restarted.prepare(offer)).toBe(false);
      offer = "9.0.1";
      if (interruptedCommit) {
        expect(await restarted.prepare(offer)).toBe(false);
        supervisorRestarting = false;
      }
      expect(await restarted.prepare(offer)).toBe(true);
      expect(await restarted.confirm({ type: "poll-failed" })).toBe(false);
      now += 300_000;
      offer = "9.0.0";
      expect(await restarted.prepare(offer)).toBe(false);
      offer = "9.0.1";
    }
    expect(await restarted.prepare(offer)).toBe(true);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test.each([
  ["idle", "normal"],
  ["idle with a group-writable state parent", "normal"],
  ["preparing", "normal"],
  ["cancelled", "normal"],
  ["failed", "normal"],
  ["updated", "normal"],
  ["staged", "heartbeat"],
  ["starting", "heartbeat"],
  ["uninstall intent", "cleanup"],
  ["legacy uninstall intent", "normal"],
  ["uninstall negotiation interrupted", "heartbeat"],
  ["cleanup-only intent after server rollback", "cleanup"],
] as const)("first poll after reboot in %s uses %s dispatch", async (phase, expected) => {
  const f = await upgradeFixture();
  try {
    const io = {
      async service() {
        return "armada-docker-host-update.service loaded active running";
      },
      now: Date.now,
      request: fetch,
    };
    const cleanup = { ...io, home: f.home };
    if (phase === "cleanup-only intent after server rollback") {
      await prepareUninstall(f.state, async () => true, undefined, cleanup);
      await expect(prepareUninstall(f.state, async () => false, undefined, cleanup)).rejects.toThrow(
        "Restore a server that supports cleanup-only Docker host polls",
      );
    } else if (phase === "uninstall negotiation interrupted") {
      await prepareUninstall(f.state, async () => undefined, undefined, cleanup);
    } else if (phase === "uninstall intent" || phase === "legacy uninstall intent") {
      await prepareUninstall(f.state, async () => phase === "uninstall intent", undefined, cleanup);
    } else if (phase === "idle with a group-writable state parent") {
      await chmod(join(f.home, ".local/state"), 0o775);
    } else if (phase !== "idle") {
      await writeUpdateFixture(f, phase === "preparing" ? "cancelled" : phase, phase === "preparing");
    }
    const updater = automaticUpdate(f.state, { home: f.home }, io);
    const job: Job = {
      requestId: crypto.randomUUID(),
      operation: expected === "cleanup" || phase === "legacy uninstall intent" ? "stop" : "create",
      request: {
        sandboxId: crypto.randomUUID(),
        generation: crypto.randomUUID(),
        image: `debian@sha256:${"a".repeat(64)}`,
        ttlSeconds: 60,
      },
    };
    if (expected === "cleanup") {
      await writeFile(
        join(f.directory, "state.json"),
        JSON.stringify({
          ...f.state,
          resumeClaims: [
            {
              requestId: crypto.randomUUID(),
              sandboxId: job.request.sandboxId,
              generation: job.request.generation,
              accepted: true,
              active: true,
            },
          ],
        }),
      );
    }
    const modes: string[] = [];
    const executed: string[] = [];
    const run = async () => {
      executed.push(job.operation);
    };
    const unexpected = async () => {
      throw new Error("Unexpected machine operation");
    };
    await runJobs(
      {
        load: f.store.load,
        async save(state) {
          await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
        },
      },
      httpApi(
        (async (url, init) => {
          if (new URL(String(url)).pathname.endsWith("/results")) return new Response(null, { status: 204 });
          const body = JSON.parse(String(init?.body));
          const mode = body.heartbeatOnly ? "heartbeat" : body.cleanupOnly ? "cleanup" : "normal";
          modes.push(mode);
          return Response.json({ job: mode === "heartbeat" ? null : job, updateVersion: "9.0.0" });
        }) as typeof fetch,
        undefined,
        undefined,
        undefined,
        updater,
      ),
      { create: run, stop: run, delete: unexpected, stopIfExpired: unexpected },
      { stopping: () => modes.length > 0, sleep: async () => {}, update: updater },
    );
    expect(modes).toEqual([expected]);
    expect(executed).toEqual(expected === "heartbeat" ? [] : [job.operation]);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("uninstall cancels a staged release even without a successful poll", async () => {
  const f = await upgradeFixture();
  try {
    const journal = await writeUpdateFixture(f, "staged");
    const updater = automaticUpdate(f.state, { home: f.home });
    expect(await updater.pollMode()).toBe("staged");

    const io = {
      home: f.home,
      async service() {
        return "";
      },
    };
    await prepareUninstall(f.state, async () => undefined, undefined, io);
    expect(await updater.pollMode()).toBe("pending");
    // An iteration that already selected ordinary dispatch must still recheck
    // the persisted intent at the wire boundary.
    const requests: unknown[] = [];
    const api = httpApi(
      (async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ job: null });
      }) as typeof fetch,
      undefined,
      undefined,
      undefined,
      updater,
    );
    await expect(api.poll(f.state, { waitSeconds: 20 })).rejects.toThrow("uninstall pending");
    expect(requests).toEqual([]);
    await prepareUninstall(f.state, async () => true, undefined, io);
    await api.poll(f.state, { cleanupOnly: true });
    expect(requests).toEqual([expect.objectContaining({ cleanupOnly: true })]);
    // A daemon that was already draining must not schedule the cancelled candidate.
    expect(await updater.restart()).toBe(false);
    expect(JSON.parse(await readFile(journal, "utf8")).phase).toBe("cancelled");
    // Retry after revocation and reboot, with the original durable state.
    await prepareUninstall(f.state, async () => true, undefined, io);
    expect(await readFile(f.binary, "utf8")).toBe(f.oldBytes);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("restarted supervisor restores the previous binary after an interruption before the rollback rename", async () => {
  const f = await upgradeFixture();
  const bin = join(f.home, ".local/bin");
  try {
    const journal = await interruptedTrial(f);
    // Prevent the executable rename after allowing the rollback marker write.
    await chmod(bin, 0o500);
    await expect(superviseUpdate(f.store, undefined, f.io)).rejects.toThrow();
    expect(await readFile(f.binary, "utf8")).toBe(f.newBytes);
    expect(await validateInstallation(f.state, f.home)).toEqual({
      ...f.marker,
      binarySha256: f.hash(f.newBytes),
      pendingBinarySha256: f.hash(f.oldBytes),
    });

    await chmod(bin, 0o700);
    const starts: string[] = [];
    await superviseUpdate(f.store, undefined, {
      home: f.home,
      async service(args) {
        if (args.includes("start")) starts.push(await readFile(f.binary, "utf8"));
      },
    });
    expect(starts).toEqual([f.oldBytes]);
    expect(JSON.parse(await readFile(journal, "utf8")).phase).toBe("failed");
    expect(await validateInstallation(f.state, f.home)).toEqual(f.marker);
  } finally {
    await chmod(bin, 0o700);
    await rm(f.home, { recursive: true, force: true });
  }
});

test("rollback keeps both digests until the restored executable directory is synced", async () => {
  const f = await upgradeFixture();
  const bin = join(f.home, ".local/bin");
  try {
    const journal = await interruptedTrial(f);
    // Simulate an interruption after the rename, with both digests still valid.
    const marker = { ...f.marker, binarySha256: f.hash(f.newBytes), pendingBinarySha256: f.hash(f.oldBytes) };
    await writeFile(f.markerFile, JSON.stringify(marker));
    await writeFile(f.binary, f.oldBytes);
    await chmod(bin, 0o300);
    const io = {
      home: f.home,
      async service() {
        return "";
      },
    };
    await expect(recoverUpdate(f.store, undefined, io)).rejects.toThrow();
    expect(await validateInstallation(f.state, f.home)).toEqual(marker);
    expect(JSON.parse(await readFile(journal, "utf8")).phase).toBe("starting");

    await chmod(bin, 0o700);
    await recoverUpdate(f.store, undefined, io);
    expect(await validateInstallation(f.state, f.home)).toEqual(f.marker);
    expect(JSON.parse(await readFile(journal, "utf8")).phase).toBe("failed");
  } finally {
    await chmod(bin, 0o700);
    await rm(f.home, { recursive: true, force: true });
  }
});

test("startup recovers a persisted trial after reboot removes its transient supervisor", async () => {
  const f = await upgradeFixture();
  try {
    const journal = await interruptedTrial(f);
    await recoverUpdate(f.store, undefined, {
      home: f.home,
      async service() {
        return "armada-docker-host-update.service loaded activating auto-restart Update";
      },
    });
    expect(await readFile(f.binary, "utf8")).toBe(f.newBytes);

    // The interrupted daemon never renamed this partial write to state.json.
    const tornWrite = join(f.directory, ".state-6c4ed834-a4f5-46d6-8e7c-fdc00dc1f9d3");
    await writeFile(tornWrite, "{", { mode: 0o600 });
    const queries: string[][] = [];
    await recoverUpdate(f.store, undefined, {
      home: f.home,
      async service(args) {
        queries.push(args);
        return ""; // A fresh user manager has no transient supervisor to list.
      },
    });
    expect(await readFile(f.binary, "utf8")).toBe(f.oldBytes);
    expect(queries[0]).toContain("list-units");
    expect(queries[0]?.at(-1)).toBe("armada-docker-host-update.service");
    expect(JSON.parse(await readFile(journal, "utf8")).phase).toBe("failed");
    expect(await validateInstallation(f.state, f.home)).toEqual(f.marker);
    expect(await f.store.load()).toEqual(f.state);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});
