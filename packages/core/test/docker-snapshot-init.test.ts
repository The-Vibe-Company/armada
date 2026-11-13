import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SNAPSHOT_INIT_SUPERVISOR } from "../src/docker-snapshot-init.ts";

// Actual Linux process boundary: escaped-session writer must be dead/reaped
// BEFORE trusted control can proceed to scan. No Docker, network or fixed sleeps.
test.skipIf(process.platform !== "linux")(
  "snapshot init quiesces setsid background writers with restricted privileges",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "armada-snapshot-supervisor-")),
      work = join(root, "work");
    const privileged = (args: string[]) => (process.getuid?.() === 0 ? args : ["sudo", "-n", ...args]);
    const checked = (args: string[]) => {
      const child = Bun.spawnSync(privileged(args), { stdout: "pipe", stderr: "pipe" });
      if (child.exitCode !== 0) throw Error("Private supervisor fixture setup failed.");
    };
    let writer: number | undefined, birth: string | undefined;
    try {
      await mkdir(work, { mode: 0o755 });
      const ready = join(work, "ready"),
        trigger = join(work, "trigger");
      await writeFile(join(root, "supervise.py"), SNAPSHOT_INIT_SUPERVISOR, { mode: 0o444 });
      await writeFile(
        join(root, "writer.py"),
        `import os\nos.setsid()\nwith open('/proc/self/stat') as f: birth=f.read().rsplit(')',1)[1].split()[19]\nwith open('/proc/self/status') as f: nnp=next(line.split(':')[1].strip() for line in f if line.startswith('NoNewPrivs:'))\nwith open(${JSON.stringify(ready)},'w') as f: f.write(str(os.getpid())+' '+birth+' '+str(os.getuid())+' '+nnp+'\\n')\nwith open(${JSON.stringify(trigger)},'r') as f: f.read()\nwith open(${JSON.stringify(join(work, "late-write"))},'w') as f: f.write('late')\n`,
        { mode: 0o444 },
      );
      await writeFile(
        join(root, "init.sh"),
        `python3 ${JSON.stringify(join(root, "writer.py"))} >/dev/null 2>&1 &\nread -r pid birth uid nnp < ${JSON.stringify(ready)}\nprintf '%s %s %s %s\\n' "$pid" "$birth" "$uid" "$nnp"\nexit 0\n`,
        { mode: 0o444 },
      );
      checked(["chmod", "0755", root]);
      checked(["chown", "-R", "root:root", root]);
      checked(["chown", "1000:1000", work]);
      checked(["mkfifo", "--mode=0600", ready, trigger]);
      checked(["chown", "1000:1000", ready, trigger]);
      const child = Bun.spawn(
        privileged([
          "env",
          `HOME=${work}`,
          "timeout",
          "--kill-after=1s",
          "2s",
          "python3",
          join(root, "supervise.py"),
          join(root, "init.sh"),
        ]),
        { stdout: "pipe", stderr: "pipe" },
      );
      const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      const fields = output.trim().split(" ");
      writer = Number(fields[0]);
      birth = fields[1];
      expect(status).toBe(0);
      expect(fields.slice(2)).toEqual(["1000", "1"]);
      expect(writer).toBeGreaterThan(0);
      expect(() => process.kill(writer!, 0)).toThrow();
      writer = undefined;
      await expect(readFile(join(work, "late-write"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (writer && birth) {
        try {
          const stat = await readFile(`/proc/${writer}/stat`, "utf8");
          if (
            stat
              .slice(stat.lastIndexOf(")") + 1)
              .trim()
              .split(/\s+/)[19] === birth
          )
            checked(["kill", "-KILL", String(writer)]);
        } catch {}
      }
      if (process.getuid?.() === 0) await rm(root, { recursive: true, force: true });
      else checked(["rm", "-rf", "--", root]);
    }
  },
);
