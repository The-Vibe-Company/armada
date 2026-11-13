import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { GitHubBroker } from "../src/github-broker.ts";

// Use Git's installed executable, not a PATH launcher that can inject a real
// credential helper. The fixture must exercise only its private offline broker.
function installedGit(): string {
  const result = Bun.spawnSync(["git", "--exec-path"]);
  if (result.exitCode !== 0) throw Error("Cannot locate the installed Git executable");
  return join(result.stdout.toString().trim(), "git");
}

// Owning process boundary: an already-running shell, actual gh executable and Git credential IPC.
// No network, user HOME, fixed sleeps, test-only production hooks or token-bearing argv.
test("existing native children use new GitHub material and register it before gh/git consumption", async () => {
  const root = await mkdtemp(join(tmpdir(), "gh692-"));
  const current = `offline-${crypto.randomUUID()}`,
    next = `offline-${crypto.randomUUID()}`;
  let token = current;
  const registered = new Set<string>();
  const broker = new GitHubBroker(
    (values) => {
      for (const value of values) registered.add(value);
    },
    (async () => Response.json({ token })) as unknown as typeof fetch,
  );
  broker.configure({
    version: 1,
    revision: "1",
    generation: "1",
    url: "https://armada.example/api/internal/github/credentials",
    capability: `armada_gh_${"a".repeat(64)}`,
    expiresAt: Date.now() + 60000,
  });
  const socket = await broker.listen(join(root, "private"));
  let child: Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let releaseReader: (() => Promise<void>) | undefined;
  let cleanupFailure: unknown;
  try {
    const home = join(root, "home"),
      bin = join(root, "bin");
    await mkdir(home);
    await mkdir(bin);
    const gh = Bun.which("gh");
    const git = installedGit();
    if (!gh || !git) throw Error("Actual gh and git executables required for credential-boundary verification");
    const observer = join(root, "observe-gh");
    // A consumer may read stdin: it must see EOF, never the shell control pipe.
    await writeFile(observer, `#!/bin/sh\ncat >/dev/null\n${gh} "$@" | sha256sum\n`, { mode: 0o700 });
    const gitObserver = join(root, "observe-git");
    await writeFile(gitObserver, `#!/bin/sh\nexec "${git}" "$@"\n`, { mode: 0o700 });
    const tools = {
      root: join(root, "private"),
      activation: socket.activation,
      socket: socket.socket,
      gh: observer,
      git: gitObserver,
      ghWrapper: join(bin, "gh"),
      gitWrapper: join(bin, "git"),
      homes: [home],
      identity: { name: "Runtime Owner", email: "123+owner@users.noreply.github.com" },
    };
    const installer = Bun.spawn(
      ["sudo", "-n", process.execPath, join(import.meta.dir, "../dist/main.js"), "github-install"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    installer.stdin.write(JSON.stringify(tools));
    installer.stdin.end();
    expect(await installer.exited).toBe(0);
    expect(await new Response(installer.stdout).text()).toBe("github_tools_installed\n");
    const identity = Bun.spawnSync([
      git,
      "config",
      "--file",
      join(home, ".gitconfig"),
      "--get-regexp",
      "^user\\.(name|email)$",
    ]);
    expect(identity.exitCode).toBe(0);
    expect(identity.stdout.toString()).toBe("user.name Runtime Owner\nuser.email 123+owner@users.noreply.github.com\n");
    // Default native UID cannot dump raw credentials or retired leaves from either channel.
    await expect(
      fetch("http://private/", {
        unix: socket.socket,
        method: "POST",
        body: '{"repository":"acme/repo","operation":"gh"}',
      }),
    ).rejects.toThrow();
    expect((await fetch("http://private/registry", { unix: socket.redactSocket })).status).toBe(403);

    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      GH_REPO: "acme/repo",
      GH_TOKEN: "inherited-stale",
      GITHUB_TOKEN: "inherited-stale",
      GH_NO_UPDATE_NOTIFIER: "1",
      GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "armada.probe",
      GIT_CONFIG_VALUE_0: "preserved",
    };
    const commands = `
exec 3<&0 </dev/null
while IFS= read -r phase <&3; do
  case "$phase" in
    consume)
      # Independent read-only consumers share a token epoch, not output pipes.
      exec 4< <(gh auth token --hostname github.com 3<&-)
      gh_pid=$!
      exec 5< <(printf 'protocol=https\nhost=github.com\npath=acme/repo.git\n\n' | git credential fill 3<&-)
      git_pid=$!
      exec 6< <(git -c alias.creds=credential creds fill 3<&- <<'CREDENTIAL_INPUT'
protocol=https
host=github.com
path=acme/repo.git

CREDENTIAL_INPUT
      )
      alias_pid=$!
      cat <&4 3<&-
      cat <&5 3<&-
      cat <&6 3<&-
      exec 4<&- 5<&- 6<&-
      wait "$gh_pid" "$git_pid" "$alias_pid"
      git config --get armada.probe 3<&-
      ;;
    denied)
      gh pr view https://github.com/foreign/repo/pull/1 3<&-; echo URL_STATUS:$?
      gh repo view foreign/repo 3<&-; echo REPO_STATUS:$?
      ;;
    *) exit 64 ;;
  esac
  printf 'PHASE_DONE\n'
done
`;
    const shell = Bun.spawn(["bash", "-c", commands], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    child = shell;
    const output = shell.stdout.getReader();
    releaseReader = async () => {
      await output.cancel().catch(() => {});
      output.releaseLock();
    };
    // Drain immediately so diagnostics cannot backpressure a native command.
    const errors = new Response(shell.stderr).text().catch(() => undefined);
    async function errorText() {
      const text = await errors;
      if (text === undefined) throw Error("fixture stderr failed");
      return text;
    }
    let pending = "";
    async function phase(name: "consume" | "denied" = "consume") {
      shell.stdin.write(`${name}\n`);
      await shell.stdin.flush();
      while (!pending.includes("PHASE_DONE\n")) {
        const item = await output.read();
        if (item.done) throw Error(`fixture exited before ${name} completed`);
        pending += new TextDecoder().decode(item.value);
      }
      const at = pending.indexOf("PHASE_DONE\n"),
        result = pending.slice(0, at);
      pending = pending.slice(at + 11);
      return result;
    }
    const first = await phase();
    if (!first.includes("password=***") || !first.includes("preserved")) {
      shell.stdin.end();
      await shell.exited;
      let diagnostic = await errorText();
      for (const secret of [current, next, "inherited-stale"]) diagnostic = diagnostic.replaceAll(secret, "***");
      throw Error(diagnostic);
    }
    expect(registered.has(current)).toBe(true);
    expect(first.match(/password=\*\*\*/g)).toHaveLength(2);
    expect(first).not.toContain(current);
    expect(first).toContain("preserved");
    expect(first.split("\n")[0]).toBe(`${createHash("sha256").update(`${current}\n`).digest("hex")}  -`);
    token = next;
    const second = await phase();
    expect(registered.has(next)).toBe(true);
    expect(registered.has(current)).toBe(true);
    expect(second.match(/password=\*\*\*/g)).toHaveLength(2);
    expect(second).not.toContain(next);
    expect(second.split("\n")[0]).toBe(`${createHash("sha256").update(`${next}\n`).digest("hex")}  -`);
    expect(second).not.toContain("inherited-stale");
    expect(second).not.toContain(current);
    const denied = await phase("denied");
    expect(denied).toContain("URL_STATUS:1");
    expect(denied).toContain("REPO_STATUS:1");
    shell.stdin.end();
    await shell.exited;
    expect(await errorText()).toBe(
      "Managed GitHub credentials unavailable (request: invalid_response).\nManaged GitHub credentials unavailable (request: invalid_response).\n",
    );
  } finally {
    if (child) {
      child.stdin.end();
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupFailure = error;
        }
      }
      await child.exited;
    }
    await releaseReader?.();
    socket.close();
    await rm(root, { recursive: true, force: true });
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
});

test("late acquisition cannot publish across replacement/scrub and retired values stay registered", async () => {
  let deliver!: (value: Response) => void;
  const response = new Promise<Response>((resolve) => {
    deliver = resolve;
  });
  const values = new Set<string>();
  const broker = new GitHubBroker(
    (items) => {
      for (const item of items) values.add(item);
    },
    (() => response) as unknown as typeof fetch,
    () => 100,
  );
  broker.configure({
    version: 1,
    revision: "1",
    generation: "one",
    url: "https://armada.example/api/internal/github/credentials",
    capability: `armada_gh_${"a".repeat(64)}`,
    expiresAt: 200,
  });
  const pending = broker.acquire("acme/repo", "git");
  broker.configure(null);
  const token = `offline-${crypto.randomUUID()}`;
  deliver(Response.json({ token }));
  await expect(pending).rejects.toThrow("github_credentials_denied");
  expect(values.has(token)).toBe(true);
  await expect(broker.acquire("acme/repo", "git")).rejects.toThrow("github_credentials_denied");
});

// Installed wrapper, counting broker and offline downstream: authorization must
// use only the positional REST endpoint, even when GH_REPO or flag values decoy it.
test.each(["canonical", "denied-endpoint", "denied-prefix"] as const)(
  "managed REST binds acquisition before executing gh (%s)",
  async (group) => {
    const root = await mkdtemp(join(tmpdir(), "gh1066-"));
    const acquired: string[] = [];
    const broker = new GitHubBroker(() => {}, (async (_url, init) => {
      acquired.push(JSON.parse(String(init?.body)).repository);
      return Response.json({ token: "offline-rest-fixture" });
    }) as typeof fetch);
    broker.configure({
      version: 1,
      revision: "1",
      generation: "1",
      url: "https://armada.example/api/internal/github/credentials",
      capability: `armada_gh_${"a".repeat(64)}`,
      expiresAt: Date.now() + 60000,
    });
    const socket = await broker.listen(join(root, "private"));
    try {
      const home = join(root, "home"),
        bin = join(root, "bin");
      await mkdir(home);
      await mkdir(bin);
      const gh = join(root, "offline-gh"),
        git = join(root, "offline-git");
      await writeFile(gh, '#!/bin/sh\nprintf "DOWNSTREAM\\n"\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      await writeFile(git, `#!/bin/sh\nexec "${installedGit()}" "$@"\n`, { mode: 0o755 });
      const installer = Bun.spawn(
        ["sudo", "-n", process.execPath, join(import.meta.dir, "../dist/main.js"), "github-install"],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      installer.stdin.write(
        JSON.stringify({
          root: join(root, "private"),
          activation: socket.activation,
          socket: socket.socket,
          gh,
          git,
          ghWrapper: join(bin, "gh"),
          gitWrapper: join(bin, "git"),
          homes: [home],
        }),
      );
      installer.stdin.end();
      expect(await installer.exited).toBe(0);
      const run = async (args: string[], prefix = ["api"]) => {
        const child = Bun.spawn([join(bin, "gh"), ...prefix, ...args], {
          env: { PATH: process.env.PATH, HOME: home, GH_REPO: "decoy/repo" },
          stdout: "pipe",
          stderr: "pipe",
        });
        return { status: await child.exited, output: await new Response(child.stdout).text() };
      };
      if (group === "canonical") {
        for (const args of [
          ["--repo", "acme/repo", "pr", "view", "1"],
          ["-R", "acme/repo", "issue", "view", "1"],
          ["--repo=acme/repo", "repo", "view"],
        ]) {
          acquired.length = 0;
          const result = await run(args, []);
          expect(result.status).toBe(0);
          expect(result.output).toBe(`DOWNSTREAM\n${args.join("\n")}\n`);
          expect(acquired).toEqual(["acme/repo"]);
        }
        for (const args of [["--help"], ["-h"], ["--version"]]) {
          acquired.length = 0;
          const result = await run(args, []);
          expect(result.status).toBe(0);
          expect(result.output).toBe(`DOWNSTREAM\n${args.join("\n")}\n`);
          expect(acquired).toEqual(["decoy/repo"]);
        }
        const allowed = [
          ["repos/acme/repo/pulls"],
          ["--method", "POST", "/repos/acme/repo/issues", "--field", "title=example"],
          ["repos/acme/repo/pulls/1/reviews", "-X", "POST", "--raw-field=body=example"],
          ["--header", "repos/decoy/repo", "repos/acme/repo/issues", "--hostname=github.com"],
          ["repos/acme/repo", "--jq", ".name", "--include"],
        ];
        for (const args of allowed) {
          acquired.length = 0;
          const result = await run(args);
          expect(result.status).toBe(0);
          expect(result.output).toBe(`DOWNSTREAM\napi\n${args.join("\n")}\n`);
          expect(acquired).toEqual(["acme/repo"]);
        }
      }
      const denied = [
        ["user"],
        ["repositories/123/issues"],
        ["graphql"],
        ["https://api.github.com/repos/acme/repo/issues"],
        ["repos/{owner}/{repo}/issues"],
        ["//repos/acme/repo/issues"],
        ["repos/acme/repo/../other"],
        ["repos/acme/repo/%2e%2e/other"],
        ["repos/acme%2frepo/issues"],
        ["repos/acme/repo?path=other"],
        ["repos/../repo/issues"],
        ["repos/acme/repo/"],
        ["user", "--field", "repos/acme/repo"],
        ["--header", "repos/acme/repo", "user"],
        ["--field=repos/acme/repo", "repositories/123"],
        ["repos/acme/repo", "user"],
        ["user", "repos/acme/repo"],
        ["--unknown", "repos/acme/repo"],
        ["repos/acme/repo", "--field"],
        ["--hostname=elsewhere.example", "repos/acme/repo"],
        ["--", "repos/acme/repo"],
        ["-XPOST", "repos/acme/repo"],
      ];
      for (const args of group === "denied-endpoint" ? denied : []) {
        acquired.length = 0;
        const result = await run(args);
        expect(result.status).toBe(1);
        expect(result.output).toBe("");
        expect(acquired).toEqual([]);
      }
      if (group === "denied-prefix") {
        for (const args of [
          ["--repo", "acme/repo", "api", "user"],
          ["--repo=acme/repo", "api", "repositories/123/issues"],
          ["--repo", "acme/repo", "repo", "delete"],
          ["--method", "GET", "api", "user"],
          ["--hostname", "github.com", "api", "repositories/123/issues"],
          ["--method=GET", "api", "graphql"],
          ["-X", "GET", "api", "user"],
          ["--header", "repos/acme/repo", "api", "user"],
        ]) {
          acquired.length = 0;
          const result = await run(args, []);
          expect(result.status).toBe(1);
          expect(result.output).toBe("");
          expect(acquired).toEqual([]);
        }
      }
    } finally {
      socket.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
