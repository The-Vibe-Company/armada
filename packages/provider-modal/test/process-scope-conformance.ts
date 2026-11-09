/** Opt-in actual Linux process regression in an isolated Docker PID/mount namespace. Runs the
 * production pidfd scope code; never run the quiescer against the coding worker/host namespace. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Image, ModalClient, Sandbox } from "modal";
import {
  captureProcessBaseline,
  createRunnerDistribution,
  loadRunnerArtifact,
  type Machine,
  MODAL_IMAGE_LOCK,
  prepareFilesystemSnapshot,
  quiesceSandboxProcesses,
} from "../src/index.ts";

if (import.meta.main) {
  const root = await mkdtemp(join(tmpdir(), "armada-process-scope-"));
  const imageName = `armada-process-${crypto.randomUUID()}`;
  let container = "";
  const run = async (args: string[], input?: string) => {
    const child = Bun.spawn(args, { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    if (input !== undefined && child.stdin && typeof child.stdin !== "number") {
      child.stdin.write(input);
      child.stdin.end();
    }
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) {
      await Bun.write("/tmp/armada-process-scope-failure.log", err);
      throw Error("Process-scope OS fixture command failed; isolated log in /tmp/armada-process-scope-failure.log");
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
    const distribution = createRunnerDistribution({
      ...MODAL_IMAGE_LOCK,
      ...artifact,
      capabilities: {} as never,
      bootstrap: async () => ({}),
      restoreEnv: async () => ({}),
      prepareSnapshot: async () => {},
    });
    await distribution.image({ images: { fromRegistry: () => handle } } as unknown as ModalClient);
    await Bun.write(join(root, "Dockerfile"), `FROM ${MODAL_IMAGE_LOCK.base}\n${commands.join("\n")}\n`);
    await run(["docker", "build", "-t", imageName, root]);
    container = (await run(["docker", "run", "-d", "--rm", imageName, "/bin/sleep", "infinity"])).trim();
    const sdk = {
      exec: async (argv: string[], opts?: { workdir?: string }) => {
        const child = Bun.spawn(["docker", "exec", "-i", "-w", opts?.workdir ?? "/home/user", container, ...argv], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
        });
        return {
          stdin: {
            writeText: async (text: string) => {
              child.stdin.write(text);
            },
            close: async () => {
              child.stdin.end();
            },
          },
          stdout: { readText: () => new Response(child.stdout).text() },
          wait: () => child.exited,
        };
      },
    } as unknown as Sandbox;
    const machine: Machine = {
      info: { id: "fixture", name: "fixture", state: "starting", providerState: "booting", labels: {} },
      phase: "booting",
      generation: 1,
      golden: false,
      physicalName: "fixture",
      physicalId: container,
      ttlSeconds: 3600,
    };
    machine.processBaseline = await captureProcessBaseline(sdk, machine);
    const baselineInit = machine.processBaseline.processes.find((p) => p.pid === 1);
    if (!baselineInit) throw Error("Missing actual trusted PID1");
    for (const golden of [false, true]) {
      const writer = `import {writeFileSync,existsSync,readFileSync,mkdirSync} from "node:fs";
const raw=readFileSync('/proc/self/stat','utf8'),parts=raw.slice(raw.lastIndexOf(')')+2).split(' ');
writeFileSync('/tmp/daemon-ready.json',JSON.stringify({pid:process.pid,start:parts[19],uid:process.geteuid(),parent:process.ppid}));
await Bun.sleep(100);while(!existsSync('/tmp/reopen-trigger'))await Bun.sleep(10);
await Bun.sleep(50);mkdirSync('/home/user/.armada-runtime',{recursive:true});writeFileSync('/home/user/.armada-runtime/recreated-auth','synthetic delayed writer');setInterval(()=>{},1000);`;
      await run(
        ["docker", "exec", "-i", "-u", "user", container, "bash", "-s"],
        `set -eu
sudo -n rm -f /tmp/daemon-ready.json /tmp/reopen-trigger /home/user/.armada-runtime/recreated-auth
sudo -n /opt/armada/runtime-bun/bun -e 'const input=JSON.parse(await Bun.stdin.text());Bun.spawn(["setsid","/opt/armada/runtime-bun/bun","-e",input.script],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});process.exit(0);' <<'DAEMON_JSON'
${JSON.stringify({ script: writer })}
DAEMON_JSON
`,
      );
      let identity: { pid: number; start: string; uid: number; parent: number } | undefined;
      for (let i = 0; i < 100; i++) {
        try {
          identity = JSON.parse(await run(["docker", "exec", container, "cat", "/tmp/daemon-ready.json"]));
          if (identity) break;
        } catch {}
        await Bun.sleep(10);
      }
      if (identity?.uid !== 0) throw Error("sudo detached root writer did not start");
      await run([
        "docker",
        "exec",
        container,
        "/opt/armada/runtime-bun/bun",
        "-e",
        `import {readFileSync} from 'node:fs';const s=readFileSync('/proc/${identity.pid}/stat','utf8'),p=s.slice(s.lastIndexOf(')')+2).split(' ');if(p[1]!=='1')process.exit(4);`,
      ]);
      const target = { ...machine, phase: "checkpoint" as const, golden };
      let mismatch = false;
      try {
        await quiesceSandboxProcesses(sdk, {
          ...target,
          processBaseline: {
            ...machine.processBaseline,
            namespace: { ...machine.processBaseline.namespace, mount: "foreign-mount" },
          },
        });
      } catch {
        mismatch = true;
      }
      if (!mismatch) throw Error("Foreign process namespace was accepted");
      await prepareFilesystemSnapshot(sdk, target);
      // Trigger after the exact production quiescence/removal boundary. No managed FD was held
      // while sleeping; FD-only or PPid=user checks would let this recreate during snapshot.
      await run([
        "docker",
        "exec",
        container,
        "/opt/armada/runtime-bun/bun",
        "-e",
        `import {writeFileSync,existsSync,readFileSync} from 'node:fs';writeFileSync('/tmp/reopen-trigger','go');await Bun.sleep(200);if(existsSync('/home/user/.armada-runtime/recreated-auth'))process.exit(2);try{const raw=readFileSync('/proc/${identity.pid}/stat','utf8'),p=raw.slice(raw.lastIndexOf(')')+2).split(' ');if(p[19]===${JSON.stringify(identity.start)}&&!['Z','X'].includes(p[0]))process.exit(3);}catch{}`,
      ]);
      await run([
        "docker",
        "exec",
        container,
        "sh",
        "-c",
        `test "$(awk '{print $22}' /proc/1/stat)" = '${baselineInit.start}'`,
      ]);
    }
    let refused = false;
    try {
      await quiesceSandboxProcesses(sdk, { ...machine, physicalId: "other-physical" });
    } catch {
      refused = true;
    }
    if (!refused) throw Error("Mismatched physical baseline accepted");
    console.log(
      JSON.stringify({
        checks: [
          "real sudo+setsid orphan root writer fenced by production pidfds",
          "sleep/reopen cannot recreate state after golden or recovery quiescence",
          "trusted PID1 survives",
          "foreign physical baseline refused",
        ],
      }),
    );
  } finally {
    if (container) await run(["docker", "rm", "-f", container]).catch(() => {});
    await run(["docker", "image", "rm", "-f", imageName]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
