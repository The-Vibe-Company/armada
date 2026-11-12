import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubBroker } from "../src/github-broker.ts";

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
  try {
    const home = join(root, "home"),
      bin = join(root, "bin");
    await mkdir(home);
    await mkdir(bin);
    const gh = Bun.which("gh");
    const git = Bun.which("git");
    if (!gh || !git) throw Error("Actual gh and git executables required for credential-boundary verification");
    const observer = join(root, "observe-gh");
    await writeFile(observer, `#!/bin/sh\n${gh} "$@" | sha256sum\n`, { mode: 0o700 });
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
    };
    const installer = Bun.spawn(
      ["sudo", "-n", process.execPath, join(import.meta.dir, "../dist/main.js"), "github-install"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    installer.stdin.write(JSON.stringify(tools));
    installer.stdin.end();
    expect(await installer.exited).toBe(0);
    expect(await new Response(installer.stdout).text()).toBe("github_tools_installed\n");
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
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "armada.probe",
      GIT_CONFIG_VALUE_0: "preserved",
    };
    const child = Bun.spawn(["bash"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    let pending = "";
    async function phase() {
      child.stdin.write(
        "gh auth token --hostname github.com\nprintf 'protocol=https\\nhost=github.com\\npath=acme/repo.git\\n\\n' | git credential fill\ngit -c alias.creds=credential creds fill <<'CREDENTIAL_INPUT'\nprotocol=https\nhost=github.com\npath=acme/repo.git\n\nCREDENTIAL_INPUT\ngit config --get armada.probe\necho PHASE_DONE\n",
      );
      while (!pending.includes("PHASE_DONE\n")) {
        const item = await reader.read();
        if (item.done) throw Error("fixture exited");
        pending += new TextDecoder().decode(item.value);
      }
      const at = pending.indexOf("PHASE_DONE\n"),
        result = pending.slice(0, at);
      pending = pending.slice(at + 11);
      return result;
    }
    const first = await phase();
    if (!first.includes("password=***") || !first.includes("preserved")) {
      child.stdin.end();
      await child.exited;
      let diagnostic = await new Response(child.stderr).text();
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
    child.stdin.write(
      "gh pr view https://github.com/foreign/repo/pull/1; echo URL_STATUS:$?; gh repo view foreign/repo; echo REPO_STATUS:$?; echo PHASE_DONE\n",
    );
    while (!pending.includes("PHASE_DONE\n")) {
      const item = await reader.read();
      if (item.done) throw Error("fixture exited");
      pending += new TextDecoder().decode(item.value);
    }
    expect(pending).toContain("URL_STATUS:1");
    expect(pending).toContain("REPO_STATUS:1");
    child.stdin.end();
    await child.exited;
    expect(await new Response(child.stderr).text()).toBe(
      "Managed GitHub credentials unavailable (request: invalid_response).\nManaged GitHub credentials unavailable (request: invalid_response).\n",
    );
  } finally {
    socket.close();
    await rm(root, { recursive: true, force: true });
  }
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
test("managed REST binds acquisition to one canonical endpoint before executing gh", async () => {
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
    await writeFile(git, `#!/bin/sh\nexec "${Bun.which("git")}" "$@"\n`, { mode: 0o755 });
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
    for (const args of denied) {
      acquired.length = 0;
      const result = await run(args);
      expect(result.status).toBe(1);
      expect(result.output).toBe("");
      expect(acquired).toEqual([]);
    }
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
  } finally {
    socket.close();
    await rm(root, { recursive: true, force: true });
  }
});
