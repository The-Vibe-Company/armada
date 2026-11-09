/** Opt-in Linux/Docker OS regression. Only public artifact/source and synthetic fixture data enter
 * this disposable container. Execute with --core-reference pointing at current production core src
 * whose unmodified baselineSetup function is exported by the isolated reference harness. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Image, ModalClient, Sandbox } from "modal";
import {
  captureProcessBaseline,
  createRunnerDistribution,
  createSshPreparation,
  loadRunnerArtifact,
  type Machine,
  MODAL_IMAGE_LOCK,
  type ModalProvider,
  prepareFilesystemSnapshot,
  probeModalSsh,
  withTrustedHarnessPath,
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
    const artifact = await loadRunnerArtifact(join(import.meta.dir, "../../agent-runtime/dist"));
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
    const grant = {
      token: "synthetic-os-runner-grant",
      sandboxId: machine.info.id,
      generation: "1",
      expiresAt: Date.now() + 3600_000,
    };
    const distribution = createRunnerDistribution({
      ...MODAL_IMAGE_LOCK,
      ...artifact,
      capabilities: {} as never,
      bootstrap: async () => ({
        root: "/home/user/.armada-runtime",
        cwd: "/home/user",
        port: 8765,
        grant,
        credentialFreeBuilder: true,
        execEnv: { HOME: "/home/user", PATH: "/usr/local/bin:/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0" },
        claudeEnv: {},
        codexEnv: {},
        claudeExecutable: "/usr/local/bin/claude",
        codexExecutable: "/usr/local/bin/codex",
        ingestUrl: "https://unused.example",
      }),
      restoreEnv: async () => ({}),
      prepareSnapshot: async () => {},
    });
    await distribution.image({ images: { fromRegistry: () => handle } } as unknown as ModalClient);
    await Bun.write(join(temp, "Dockerfile"), `FROM ${MODAL_IMAGE_LOCK.base}\n${commands.join("\n")}\n`);
    await run(["docker", "build", "-t", imageName, temp]);
    container = (
      await run([
        "docker",
        "run",
        "-d",
        "--rm",
        "-p",
        "127.0.0.1::2222",
        "-p",
        "127.0.0.1::8765",
        imageName,
        "/bin/sleep",
        "infinity",
      ])
    ).trim();
    const address = async (port: number) => {
      const value = (await run(["docker", "port", container, String(port)])).trim().split("\n")[0];
      if (!value) throw Error("Missing OS fixture port");
      const match = /:(\d+)$/.exec(value);
      if (!match) throw Error("Invalid fixture port");
      return Number(match[1]);
    };
    const sshPort = await address(2222);
    let httpPort = await address(8765);
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
    // Real production npm launcher, not dist/codex: preserve the observed no-PATH red witness.
    const bare = Bun.spawn(
      ["docker", "exec", container, "env", "-i", "HOME=/tmp/codex-noauth", "/usr/local/bin/codex", "--version"],
      { stdout: "ignore", stderr: "ignore" },
    );
    if ((await bare.exited) !== 127) throw Error("No-PATH npm Codex witness did not reproduce exit127");
    const modelPath = withTrustedHarnessPath({}).PATH;
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
    await distribution.start(sandbox, machine, {});
    let healthy = false;
    for (let i = 0; i < 200; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${httpPort}`, {
          method: "POST",
          headers: { "x-armada-runner-grant": grant.token },
          body: JSON.stringify({ version: 1, requestId: "health", sandboxId: machine.info.id, op: "health" }),
        });
        if (response.ok) {
          healthy = true;
          break;
        }
      } catch {}
      await Bun.sleep(25);
    }
    if (!healthy) throw Error("Private pinned runtime did not boot after project Bun rewire");
    const checkpoint = await fetch(`http://127.0.0.1:${httpPort}`, {
      method: "POST",
      headers: { "x-armada-runner-grant": grant.token },
      body: JSON.stringify({ version: 1, requestId: "checkpoint", sandboxId: machine.info.id, op: "checkpoint" }),
    });
    if (!checkpoint.ok) throw Error("OS fixture checkpoint failed");
    machine.phase = "checkpoint";
    await prepareFilesystemSnapshot(sandbox, machine);
    await run(["docker", "commit", container, restoredImage]);
    await run(["docker", "rm", "-f", container]);
    container = (
      await run(["docker", "run", "-d", "--rm", "-p", "127.0.0.1::8765", restoredImage, "/bin/sleep", "infinity"])
    ).trim();
    httpPort = await address(8765);
    machine.generation = 2;
    machine.phase = "booting";
    machine.physicalId = container;
    machine.processBaseline = await captureProcessBaseline(sandbox, machine);
    grant.generation = "2";
    await distribution.start(sandbox, machine, {});
    let resumed = false;
    for (let i = 0; i < 200; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${httpPort}`, {
          method: "POST",
          headers: { "x-armada-runner-grant": grant.token },
          body: JSON.stringify({ version: 1, requestId: "health-restored", sandboxId: machine.info.id, op: "health" }),
        });
        const body = (await response.json()) as { result?: { generation: string; ready: boolean } };
        if (response.ok && body.result?.generation === "2" && body.result.ready) {
          resumed = true;
          break;
        }
      } catch {}
      await Bun.sleep(25);
    }
    if (!resumed) throw Error("Private runtime did not boot after filesystem restore");
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
          "project Bun1.3.14 with independent runner Bun1.4.2 startup and filesystem restore",
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
