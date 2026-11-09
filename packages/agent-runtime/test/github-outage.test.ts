import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeCwdCommand } from "../../provider-boat/src/native-cwd.ts";
import { GitHubBroker } from "../src/github-broker.ts";

// Real executable/socket boundary: a healthy command-only test misses the outage
// that previously failed local Git and terminated the enclosing native process.
test("local Git survives broker outage; native turn output resumes after broker restart", async () => {
  const base = await mkdtemp(join(tmpdir(), "gh-outage-"));
  const home = join(base, "home"),
    root = join(home, ".armada/github-offline");
  await mkdir(home);
  await mkdir(join(home, ".armada"), { mode: 0o700 });
  let token = "offline-first",
    revision = 0;
  const issued = new Set<string>();
  const broker = new GitHubBroker(
    (values) => {
      for (const value of values) issued.add(value);
    },
    (async () => Response.json({ token })) as unknown as typeof fetch,
  );
  function configure() {
    broker.configure({
      version: 1,
      revision: String(++revision),
      generation: "offline",
      url: "https://armada.example/api/internal/github/credentials",
      capability: `armada_gh_${"a".repeat(64)}`,
      expiresAt: Date.now() + 60000,
    });
  }
  configure();
  let listener = await broker.listen(root);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const env = { HOME: home, PATH: `${base}:/usr/bin:/bin`, GH_TOKEN: "offline-inherited" };
  async function run(args: string[]) {
    const child = Bun.spawn(args, { env, cwd: base, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text(),
      stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    return { stdout, stderr };
  }
  try {
    await copyFile("/usr/bin/git", join(base, "original"));
    async function install() {
      const installer = Bun.spawn(
        ["sudo", "-n", process.execPath, join(import.meta.dir, "../dist/main.js"), "github-install"],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      installer.stdin.write(
        JSON.stringify({
          root,
          socket: listener.socket,
          activation: listener.activation,
          gh: join(base, "absent-gh"),
          git: join(base, "original"),
          ghWrapper: join(base, "gh"),
          gitWrapper: join(base, "git"),
          homes: [home],
        }),
      );
      installer.stdin.end();
      expect(await installer.exited).toBe(0);
    }
    await install();
    const git = join(base, "git");
    await run([git, "init", "--bare", join(base, "remote.git")]);
    await run([git, "init", join(base, "work")]);
    await run([
      git,
      "-C",
      join(base, "work"),
      "-c",
      "user.name=Offline",
      "-c",
      "user.email=offline@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ]);
    await run([git, "-C", join(base, "work"), "remote", "add", "origin", join(base, "remote.git")]);
    const program = `#!/usr/bin/python3
import sys,json,subprocess
for line in sys.stdin:
 message=json.loads(line)
 results=[]
 for args in [['status','-sb'],['ls-remote','origin','HEAD'],['push','origin','HEAD:refs/heads/scratch'],['credential','fill']]:
  result=subprocess.run(['git','-C',${JSON.stringify(join(base, "work"))}]+args,input="protocol=https\\nhost=github.com\\npath=acme/repo.git\\n\\n" if args[0]=='credential' else None,capture_output=True,text=True)
  results.append(result.returncode)
 print(json.dumps({'id':message['id'],'result':results}),flush=True)
`;
    for (const harness of ["claude", "codex"] as const) {
      const path = join(base, harness);
      await writeFile(`${path}.armada-original`, program, { mode: 0o755 });
      const child = Bun.spawn(
        ["bash", "-c", nativeCwdCommand(path, harness, home), "--", ...(harness === "codex" ? ["app-server"] : [])],
        { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      children.push(child);
      const output = child.stdout.getReader(),
        errors = child.stderr.getReader();
      child.stdin.write('{"id":"first"}\n');
      const first = await output.read();
      expect(JSON.parse(new TextDecoder().decode(first.value))).toEqual({ id: "first", result: [0, 0, 0, 0] });
      listener.close();
      expect((await run([git, "-C", join(base, "work"), "status", "-sb"])).stdout).toContain("##");
      const credential = Bun.spawn([git, "credential", "fill"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      credential.stdin.write("protocol=https\nhost=github.com\npath=acme/repo.git\n\n");
      credential.stdin.end();
      expect(await credential.exited).toBe(1);
      expect(await new Response(credential.stdout).text()).toBe("");
      expect(await new Response(credential.stderr).text()).toBe(
        "Managed GitHub credentials unavailable (registration: socket_missing).\n",
      );
      child.stdin.write('{"id":"second"}\n');
      // The fixed diagnostic is a deterministic handshake: the redaction outage
      // has been reached, not a sleep hoping a child is still running.
      const paused = await errors.read();
      expect(new TextDecoder().decode(paused.value)).toContain("Managed GitHub");
      expect(child.exitCode).toBeNull();
      token = `offline-renewed-${harness}`;
      configure();
      listener = await broker.listen(root);
      await install();
      const second = await output.read();
      expect(JSON.parse(new TextDecoder().decode(second.value))).toEqual({ id: "second", result: [0, 0, 0, 1] });
      child.stdin.write('{"id":"renewed"}\n');
      const renewed = await output.read();
      expect(JSON.parse(new TextDecoder().decode(renewed.value))).toEqual({ id: "renewed", result: [0, 0, 0, 0] });
      expect(issued.has(token)).toBe(true);
      child.stdin.end();
      expect(await child.exited).toBe(0);
      output.releaseLock();
      errors.releaseLock();
    }
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
    listener.close();
    await rm(base, { recursive: true, force: true });
  }
}, 15000);
