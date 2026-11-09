/** Actual approved-image SSH behavior with NNP inherited by sshd. No account credentials or model
 * calls: root is selected solely from trusted golden metadata; workers remain user-only. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Image, ModalClient, Sandbox } from "modal";
import {
  createRunnerDistribution,
  createSshPreparation,
  executeGoldenCommand,
  loadRunnerArtifact,
  type Machine,
  MODAL_IMAGE_LOCK,
  type ModalProvider,
  probeModalSsh,
} from "../src/index.ts";

if (import.meta.main) {
  const reference = process.argv[2];
  if (!reference) throw Error("Provide isolated production core src reference");
  const { scanGoldenSandbox } = await import(join(reference, "golden-scan.ts"));
  let scan = "";
  await scanGoldenSandbox(
    {
      exec: async (r: { command: string }) => {
        scan = r.command;
        return { detached: false, exitCode: 0 };
      },
    },
    "fixture",
  );
  const root = await mkdtemp(join(tmpdir(), "armada-nnp-ssh-")),
    imageName = `armada-nnp-${crypto.randomUUID()}`;
  let container = "";
  const run = async (args: string[]) => {
    const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    if (code) {
      await Bun.write("/tmp/armada-nnp-fixture-failure.log", err);
      throw Error("NNP OS fixture failed; sanitized log /tmp/armada-nnp-fixture-failure.log");
    }
    return out;
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
    await createRunnerDistribution({
      ...MODAL_IMAGE_LOCK,
      ...artifact,
      capabilities: {} as never,
      bootstrap: async () => ({}),
      restoreEnv: async () => ({}),
      prepareSnapshot: async () => {},
    }).image({ images: { fromRegistry: () => handle } } as unknown as ModalClient);
    await Bun.write(join(root, "Dockerfile"), `FROM ${MODAL_IMAGE_LOCK.base}\n${commands.join("\n")}\n`);
    await run(["docker", "build", "-t", imageName, root]);
    for (const golden of [false, true]) {
      container = (
        await run(["docker", "run", "-d", "--rm", "-p", "127.0.0.1::2222", imageName, "/bin/sleep", "infinity"])
      ).trim();
      const port = Number(/:(\d+)/.exec((await run(["docker", "port", container, "2222"])).trim())?.[1]);
      if (!port) throw Error("Missing SSH port");
      const sdk = {
        exec: async (argv: string[]) => {
          const p = Bun.spawn(["docker", "exec", "-i", container, "setpriv", "--no-new-privs", ...argv], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "ignore",
          });
          return {
            stdin: {
              writeText: async (text: string) => {
                p.stdin.write(text);
              },
              close: async () => {
                p.stdin.end();
              },
            },
            stdout: { readText: () => new Response(p.stdout).text() },
            wait: () => p.exited,
          };
        },
        tunnels: async () => ({ 2222: { tcpSocket: ["127.0.0.1", port] } }),
      } as unknown as Sandbox;
      const machine: Machine = {
        info: {
          id: "fixture",
          name: "fixture",
          state: "ready",
          providerState: "active",
          labels: { username: golden ? "user" : "root" },
        },
        phase: "active",
        generation: 1,
        golden,
        physicalName: "fixture",
        ttlSeconds: 3600,
      };
      const ssh = createSshPreparation();
      const provider = {
        sshKey: async (r: { key: string }) => {
          const c = await ssh.prepare(sdk, machine, r.key);
          if (c.username !== (golden ? "root" : "user")) throw Error("SSH identity did not follow trusted metadata");
          return { sshEndpoint: c.endpoint, hostKey: c.hostPublicKey, username: c.username };
        },
      } as unknown as ModalProvider;
      const identityProof = `set -eu\ntest "$(id -u)" ${golden ? "= 0" : "!= 0"}\ntest "$HOME" = /home/user\ngrep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status\n`;
      const script = golden
        ? `${identityProof}apt-get update >/dev/null\n${scan}\n`
        : `${identityProof}if sudo -n true 2>/dev/null; then exit 1; fi\n`;
      await probeModalSsh(provider, machine.info.id, { script, timeoutMs: 600_000 });
      if (golden) {
        const scanned = await executeGoldenCommand(sdk, {
          sandboxId: machine.info.id,
          command: scan,
          cwd: "/home/user",
          timeoutSeconds: 600,
        });
        if (scanned.detached || scanned.exitCode !== 0) throw Error("NNP golden SDK root scanner failed");
        const marker = await executeGoldenCommand(sdk, {
          sandboxId: machine.info.id,
          command: "printf sdk-root; id -u; printf failure >&2; exit 97",
          timeoutSeconds: 5,
        });
        if (
          marker.detached ||
          marker.exitCode !== 97 ||
          !marker.stdout.includes("sdk-root0") ||
          marker.stderr !== "failure"
        )
          throw Error("SDK root command did not preserve real status/output");
        const timed = await executeGoldenCommand(sdk, {
          sandboxId: machine.info.id,
          command: "sleep 5",
          timeoutSeconds: 1,
        });
        if (timed.detached || !timed.timedOut) throw Error("Golden root timeout was not enforced");
        const bounded = await executeGoldenCommand(sdk, {
          sandboxId: machine.info.id,
          command: "head -c 100000 /dev/zero",
          timeoutSeconds: 5,
        });
        if (bounded.detached || !bounded.truncated || bounded.stdout.length !== 65536)
          throw Error("Golden output was not bounded");
      }
      await run(["docker", "rm", "-f", container]);
      container = "";
    }
    console.log(
      JSON.stringify({
        checks: [
          "actual sshd inherited NNP",
          "worker user identity cannot sudo under NNP",
          "golden root key-only identity remains root under NNP",
          "explicit HOME=/home/user",
          "root apt and production scanner succeed via SSH and golden SDK root exec",
        ],
      }),
    );
  } finally {
    if (container) await run(["docker", "rm", "-f", container]).catch(() => {});
    await run(["docker", "image", "rm", "-f", imageName]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
