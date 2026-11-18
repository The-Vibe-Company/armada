import { expect, test } from "bun:test";
import { chmod, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeCwdCommand, nativeCwdInstallScript } from "../src/native-cwd.ts";

// Linux VM installer contract: two actual installer processes, deterministic mv
// barriers, no mutation/elevation outside the owned temporary directory.
test.skipIf(process.platform !== "linux")(
  "parallel initial native installs preserve the real executable instead of a recursive wrapper",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "armada-install-race-"));
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const run = async (args: string[]) => {
      const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      expect(await p.exited).toBe(0);
    };
    try {
      const path = join(home, "codex"),
        native = join(home, "native");
      await writeFile(native, "#!/bin/sh\nprintf '%s\\n' real-native\n", { mode: 0o755 });
      await symlink(native, path);
      await run(["mkfifo", join(home, "A.release"), join(home, "B.release")]);
      await writeFile(join(home, "sudo"), '#!/bin/sh\n[ "$1" = -n ] || exit 97\nshift\nexec "$@"\n', { mode: 0o755 });
      await writeFile(join(home, "flock"), '#!/bin/sh\nprintf "%s:lock\\n" "$LABEL"\nexec /usr/bin/flock "$@"\n', {
        mode: 0o755,
      });
      await writeFile(
        join(home, "mv"),
        `#!/bin/sh
for arg do destination="$arg"; done
case "$destination" in *.armada-original)
  printf '%s:preserve\\n' "$LABEL"
  read -r release < "$FIXTURE_ROOT/$LABEL.release"
;; esac
exec /usr/bin/mv "$@"
`,
        { mode: 0o755 },
      );
      // chmod explicitly also works with umask-restricted hosts.
      for (const name of ["native", "sudo", "flock", "mv"]) await chmod(join(home, name), 0o755);
      const command = nativeCwdInstallScript(path, nativeCwdCommand(path, "codex"));
      const start = (label: string) => {
        const p = Bun.spawn(["bash", "-c", command], {
          stdout: "pipe",
          stderr: "pipe",
          env: { PATH: `${home}:/usr/bin:/bin`, HOME: home, LABEL: label, FIXTURE_ROOT: home },
        });
        children.push(p);
        const reader = p.stdout.getReader();
        let buffer = "";
        return {
          p,
          line: async () => {
            while (!buffer.includes("\n")) {
              const next = await reader.read();
              if (next.done) throw Error("installer exited before barrier");
              buffer += new TextDecoder().decode(next.value);
            }
            const index = buffer.indexOf("\n"),
              line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            return line;
          },
        };
      };
      const a = start("A");
      let event = await a.line();
      if (event === "A:lock") event = await a.line();
      expect(event).toBe("A:preserve");
      const b = start("B");
      const bEvent = await b.line();
      // Old installer: B passed the absent-original check and reached mv.
      // Fixed installer: B announced flock and is blocked BEFORE that check.
      expect(["B:lock", "B:preserve"]).toContain(bEvent);
      await run(["bash", "-c", 'printf "go\\n" > "$1"', "--", join(home, "A.release")]);
      expect(await a.p.exited).toBe(0);
      if (bEvent === "B:preserve") await run(["bash", "-c", 'printf "go\\n" > "$1"', "--", join(home, "B.release")]);
      expect(await b.p.exited).toBe(0);
      expect(await new Response(a.p.stderr).text()).toBe("");
      expect(await new Response(b.p.stderr).text()).toBe("");
      expect(await readlink(`${path}.armada-original`)).toBe(native);
      const probe = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "pipe" });
      children.push(probe);
      expect(await probe.exited).toBe(0);
      expect(await new Response(probe.stdout).text()).toBe("real-native\n");
    } finally {
      for (const child of children) child.kill();
      await rm(home, { recursive: true, force: true });
    }
  },
  10000,
);
