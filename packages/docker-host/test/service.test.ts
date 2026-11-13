import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State } from "../src/daemon.ts";

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
