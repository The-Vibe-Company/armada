import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Image, ModalClient, Sandbox } from "modal";
import {
  captureProcessBaseline,
  createSshPreparation,
  type Machine,
  MODAL_IMAGE_LOCK,
  type ModalProvider,
  modalImage,
  prepareFilesystemSnapshot,
  probeModalSsh,
} from "../src/index.ts";

if (import.meta.main) {
  const ref = process.argv[2];
  if (!ref) throw Error("Provide isolated production core src reference directory");
  const { baselineSetup } = await import(join(ref, "golden-create-service.ts"));
  const { scanGoldenSandbox } = await import(join(ref, "golden-scan.ts"));
  const scanCommands: string[] = [];
  await scanGoldenSandbox(
    {
      exec: async (r: { command: string }) => {
        scanCommands.push(r.command);
        return { detached: false, exitCode: 0 };
      },
    },
    "fixture",
  );
  const scanCommand = scanCommands[0];
  if (!scanCommand) throw Error("Production scanner did not supply an exec command");
  const baseline = baselineSetup([{ owner: "fixture", repo: "fixture", id: 1, installationId: 1, dir: "os-fixture" }]);
  const temp = await mkdtemp(join(tmpdir(), "armada-os-build-"));
  const imageName = `armada-os-${crypto.randomUUID()}`;
  let container = "";
  const restoredImage = `${imageName}-restore`;
  const run = async (argv: string[], input?: string) => {
    const child = Bun.spawn(argv, { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    if (input !== undefined && child.stdin && typeof child.stdin !== "number") {
      child.stdin.write(input);
      child.stdin.end();
    }
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exit !== 0) {
      await Bun.write("/tmp/modal-os-build-failure.log", stderr);
      throw Error(`OS conformance command failed; sanitized fixture log at /tmp/modal-os-build-failure.log`);
    }
    return stdout;
  };
  try {
    let commands: string[] = [];
    const handle = {
      dockerfileCommands(value: string[]) {
        commands = value;
        return this;
      },
    } as unknown as Image;
    const machine: Machine = {
      info: { id: "os-fixture", name: "fixture", state: "starting", providerState: "booting", labels: {} },
      phase: "booting",
      generation: 1,
      golden: true,
      ttlSeconds: 3600,
      physicalName: "fixture",
    };
    await modalImage(MODAL_IMAGE_LOCK)({ images: { fromRegistry: () => handle } } as unknown as ModalClient);
    await Bun.write(join(temp, "Dockerfile"), `FROM ${MODAL_IMAGE_LOCK.base}\n${commands.join("\n")}\n`);
    await run(["docker", "build", "-t", imageName, temp]);
    container = (
      await run(["docker", "run", "-d", "--rm", "-p", "127.0.0.1::2222", imageName, "/bin/sleep", "infinity"])
    ).trim();
    const address = async (port: number) => {
      const value = (await run(["docker", "port", container, String(port)])).trim().split("\n")[0];
      if (!value) throw Error("Missing OS fixture port");
      const match = /:(\d+)$/.exec(value);
      if (!match) throw Error("Invalid fixture port");
      return Number(match[1]);
    };
    const sshPort = await address(2222);
    const sandbox = {
      exec: async (argv: string[], options?: { workdir?: string }) => {
        const child = Bun.spawn(["docker", "exec", "-i", "-w", options?.workdir ?? "/home/user", container, ...argv], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });
        return {
          stdin: {
            writeText: async (value: string) => {
              child.stdin.write(value);
            },
            close: async () => {
              child.stdin.end();
            },
          },
          stdout: { readText: () => new Response(child.stdout).text() },
          wait: () => child.exited,
        };
      },
      tunnels: async () => ({ 2222: { tcpSocket: ["127.0.0.1", sshPort] } }),
    } as unknown as Sandbox;
    machine.physicalId = container;
    machine.processBaseline = await captureProcessBaseline(sandbox, machine);
    const ssh = createSshPreparation();
    const provider = {
      sshKey: async (r: { key: string }) => {
        const result = await ssh.prepare(sandbox, machine, r.key);
        return { sshEndpoint: result.endpoint, hostKey: result.hostPublicKey, username: result.username };
      },
    } as unknown as ModalProvider;
    await run(
      ["docker", "exec", "-i", "-u", "user", container, "bash", "-s"],
      `set -eu\nmkdir -p /home/user/os-fixture\nprintf '%s' '{"packageManager":"bun@1.3.14","devDependencies":{"@playwright/test":"1.49.1"}}' > /home/user/os-fixture/package.json\n`,
    );
    await probeModalSsh(provider, machine.info.id, {
      script: `set -euo pipefail\narmada_phase=setup\ntrap 'status=$?; printf "ARMADA_BUILD_FAILURE %s %s\\n" "$armada_phase" "$status" >&2' ERR\n${baseline}\narmada_phase=project_bun\ntest "$(bun --version)" = 1.3.14\narmada_phase=private_bun\ntest "$(/opt/armada/runtime-bun/bun --version)" = 1.4.2\narmada_phase=ownership\ntest "$(stat -c %U /home/user/os-fixture/package.json)" = user\narmada_phase=sudo_access\nsudo -n -- bash -c 'test "$(id -u)" = 0; test -d /root'\n`,
      timeoutMs: 600_000,
    });
    await probeModalSsh(provider, machine.info.id, { script: scanCommand, timeoutMs: 600_000 });
    const bare = Bun.spawn(
      ["docker", "exec", container, "env", "-i", "HOME=/tmp/codex-noauth", "/usr/local/bin/codex", "--version"],
      { stdout: "ignore", stderr: "ignore" },
    );
    if ((await bare.exited) !== 127) throw Error("No-PATH npm Codex witness did not reproduce exit127");
    const modelPath = "/usr/local/bin:/usr/bin:/bin";
    const launchVersion = await run([
      "docker",
      "exec",
      container,
      "env",
      "-i",
      "HOME=/tmp/codex-noauth",
      `PATH=${modelPath}`,
      "/usr/local/bin/codex",
      "--version",
    ]);
    if (!launchVersion.includes("0.167.0")) throw Error("Global npm Codex did not launch with composed PATH");
    await run([
      "docker",
      "exec",
      container,
      "env",
      "-i",
      "HOME=/tmp/tool-proof",
      `PATH=${modelPath}`,
      "sh",
      "-c",
      "command -v node && command -v git && command -v gh && command -v claude && command -v codex",
    ]);
    machine.phase = "checkpoint";
    await prepareFilesystemSnapshot(sandbox, machine);
    await run(["docker", "commit", container, restoredImage]);
    await run(["docker", "rm", "-f", container]);
    container = (await run(["docker", "run", "-d", "--rm", restoredImage, "/bin/sleep", "infinity"])).trim();
    if ((await run(["docker", "exec", container, "/opt/armada/runtime-bun/bun", "--version"])).trim() !== "1.4.2")
      throw Error("Restored control Bun pin changed");
    if ((await run(["docker", "exec", "-u", "user", container, "/usr/local/bin/bun", "--version"])).trim() !== "1.3.14")
      throw Error("Project Bun pin was not retained");
    console.log(
      JSON.stringify({
        checks: [
          "production image RUNs built",
          "real user SSH production baseline including Playwright --with-deps",
          "noninteractive privileged scanner",
          "user file ownership",
          "project Bun1.3.14 with independent control Bun1.4.2 across filesystem restore",
        ],
      }),
    );
  } finally {
    if (container) await run(["docker", "rm", "-f", container]).catch(() => {});
    await run(["docker", "image", "rm", "-f", restoredImage]).catch(() => {});
    await run(["docker", "image", "rm", "-f", imageName]).catch(() => {});
    await rm(temp, { recursive: true, force: true });
  }
}
