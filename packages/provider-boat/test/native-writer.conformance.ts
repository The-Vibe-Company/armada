import { expect, test } from "bun:test";
import { type SpawnOptions, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Provider, sshNativeAuthAdmission } from "@armada/core/server";
import { nativeCwdCommand } from "../src/native-cwd.ts";

// Real OS lock and native bridge process lifecycle, not a mock admission receipt.
test.skipIf(process.platform !== "linux")(
  "managed Boat native writers serialize, pause quiesces before capture, and resume keeps exec available",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "armada-native-writer-"));
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const ownedGroups: { pid: number; start: string }[] = [];
    try {
      mkdirSync(join(root, ".codex"), { mode: 0o700 });
      const marker = join(root, ".codex/.armada-managed-native");
      writeFileSync(marker, "active", { mode: 0o600 });
      const path = join(root, "codex");
      writeFileSync(
        `${path}.armada-original`,
        `#!/usr/bin/python3
import json,os,sys,time
revision=0
old="unavailable"
for line in sys.stdin:
 message=json.loads(line)
 if message.get("method")=="private-rotate":
  revision+=1
  current="synthetic-native-refresh-"+str(revision)
  auth={"tokens":{"access_token":"synthetic-native-access-"+str(revision),"refresh_token":current,"account_id":"synthetic-native-account"}}
  fd=os.open(os.path.join(os.environ["HOME"],".codex/auth.json"),os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
  with os.fdopen(fd,"w") as output: json.dump(auth,output)
  print(json.dumps({"id":message["id"],"result":{"old":old,"new":current}}),flush=True)
  old=current
 else: print(line.strip(),flush=True)
if os.environ.get("ARMADA_ORPHAN_PROOF"):
 while True: time.sleep(1)
`,
        { mode: 0o755 },
      );
      writeFileSync(path, `#!/bin/sh\n${nativeCwdCommand(path, "codex")}\n`, { mode: 0o755 });
      const start = (orphanProof = false) => {
        const child = Bun.spawn(["setsid", path, "app-server"], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: { HOME: root, PATH: "/usr/bin:/bin", ...(orphanProof ? { ARMADA_ORPHAN_PROOF: "1" } : {}) },
        });
        children.push(child);
        return child;
      };
      const first = start();
      first.stdin.write('{"id":1,"method":"ping"}\n');
      const firstReader = first.stdout.getReader();
      const answer = await firstReader.read();
      expect(JSON.parse(new TextDecoder().decode(answer.value))).toMatchObject({ id: 1 });
      for (const id of [8, 9]) {
        first.stdin.write(`${JSON.stringify({ id, method: "private-rotate" })}\n`);
        const reply = new TextDecoder().decode((await firstReader.read()).value);
        expect(reply).not.toContain("synthetic-native-refresh-");
        expect(JSON.parse(reply)).toMatchObject({ id, result: { new: "***" } });
        if (id === 9) expect(JSON.parse(reply)).toMatchObject({ result: { old: "***" } });
      }
      const second = start();
      second.stdin.write('{"id":99,"method":"ping"}\n');
      const admission = await Promise.race([
        second.exited.then(() => "refused"),
        second.stdout
          .getReader()
          .read()
          // biome-ignore lint/complexity/noCommaOperator: Await process exit before reporting refused admission.
          .then(async (read) => (read.done ? (await second.exited, "refused") : "admitted")),
      ]);
      expect(admission).toBe("refused");
      expect(second.exitCode).not.toBe(0);
      expect(await new Response(second.stderr).text()).toContain("native_auth_writer_busy");
      // A stopped/retrying publication cannot admit another writer until the
      // trusted server explicitly reopens this native account, without disabling shell exec.
      writeFileSync(marker, "paused");
      expect(await first.exited).not.toBe(0);
      expect(spawnSync("flock", ["-n", join(root, ".codex/.armada-native-writer.lock"), "true"]).status).toBe(0);
      const paused = start();
      expect(await paused.exited).not.toBe(0);
      expect(await new Response(paused.stderr).text()).toContain("native_auth_state_sync_pending");
      expect(spawnSync("bash", ["-c", "printf inspect"], { encoding: "utf8", cwd: root }).stdout).toBe("inspect");
      writeFileSync(marker, "active");
      const resumed = start();
      resumed.stdin.write('{"id":2,"method":"ping"}\n');
      resumed.stdin.end();
      const output = await new Response(resumed.stdout).text();
      expect(await new Response(resumed.stderr).text()).toBe("");
      expect(JSON.parse(output)).toMatchObject({ id: 2 });
      expect(await resumed.exited).toBe(0);
      const orphanBridge = start(true);
      orphanBridge.stdin.write('{"id":3,"method":"ping"}\n');
      await orphanBridge.stdout.getReader().read();
      ownedGroups.push(JSON.parse(readFileSync(join(root, ".codex/.armada-native-writer.json"), "utf8")));
      orphanBridge.kill("SIGKILL");
      await orphanBridge.exited;
      // The native process survives EOF, so only an inherited lock (not the dead
      // bridge's lock) can prevent a second refresh writer after this crash.
      const competing = start();
      competing.stdin.write('{"id":4,"method":"ping"}\n');
      const competed = await Promise.race([
        competing.exited.then(() => "refused"),
        competing.stdout
          .getReader()
          .read()
          // biome-ignore lint/complexity/noCommaOperator: Await process exit before reporting refused admission.
          .then(async (read) => (read.done ? (await competing.exited, "refused") : "admitted")),
      ]);
      expect(competed).toBe("refused");
      const preload = join(root, "private-fs.cjs");
      writeFileSync(
        preload,
        `const fs=require('node:fs');for(const name of ['lstatSync','statSync','openSync','readFileSync','writeFileSync']){const original=fs[name];fs[name]=function(p,...args){if(typeof p==='string'){for(const home of ['/home/user','/root'])if(p===home||p.startsWith(home+'/')){p=${JSON.stringify(root)}+p.slice(home.length);break;}}return original.call(fs,p,...args);}}`,
        { mode: 0o600 },
      );
      const privateSpawn = ((file: string, args: string[], options: SpawnOptions) => {
        if (file !== "ssh") return spawn(file, args, options);
        const destination = args.indexOf("user@private.test");
        return spawn("bash", ["-c", args.slice(destination + 1).join(" ")], {
          ...options,
          env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
        });
      }) as typeof spawn;
      const privateProvider: Pick<Provider, "id" | "sshKey"> = {
        id: "boat",
        sshKey: async () => ({ sshEndpoint: "private.test:2222", hostKey: "ssh-ed25519 AAAAPINNED" }),
      };
      // Execute the actual fixed-path pinned-SSH admission program against our
      // owned temporary home; it validates physical PID identity and inherited fd.
      await sshNativeAuthAdmission(privateProvider, "private-native", false, { spawn: privateSpawn });
      const captureLock = Bun.spawn(["flock", "-w", "5", join(root, ".codex/.armada-native-writer.lock"), "true"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await captureLock.exited).toBe(0);
      await sshNativeAuthAdmission(privateProvider, "private-native", true, { spawn: privateSpawn });
      const afterCrash = start();
      afterCrash.stdin.write('{"id":5,"method":"ping"}\n');
      afterCrash.stdin.end();
      expect(JSON.parse(await new Response(afterCrash.stdout).text())).toMatchObject({ id: 5 });
      expect(await afterCrash.exited).toBe(0);
    } finally {
      try {
        ownedGroups.push(JSON.parse(readFileSync(join(root, ".codex/.armada-native-writer.json"), "utf8")));
      } catch {}
      for (const group of ownedGroups) {
        try {
          const stat = readFileSync(`/proc/${group.pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          if (
            fields[19] === group.start &&
            Number(fields[2]) === group.pid &&
            readFileSync(`/proc/${group.pid}/environ`, "utf8").split("\0").includes(`HOME=${root}`)
          )
            process.kill(-group.pid, "SIGKILL");
        } catch {}
      }
      for (const child of children) {
        try {
          child.kill();
        } catch {}
      }
      await Promise.all(children.map((child) => child.exited));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
