import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// Owning process boundary: one persistent native parent, actual gh executable and Git credential IPC.
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
  let child: Subprocess<"ignore", "ignore", "pipe"> | undefined;
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
    // A consumer may read stdin: it must see EOF, never the fixture control channel.
    await writeFile(
      observer,
      `#!/usr/bin/env bun
import { createHash } from "node:crypto";
await Bun.stdin.text();
const child = Bun.spawn([${JSON.stringify(gh)}, ...process.argv.slice(2)], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
const output = await new Response(child.stdout).arrayBuffer();
if (await child.exited) process.exit(1);
console.log(createHash("sha256").update(Buffer.from(output)).digest("hex") + "  -");
`,
      { mode: 0o700 },
    );
    const gitObserver = join(root, "observe-git");
    await copyFile(git, gitObserver);
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
    const dispatcher = join(root, "dispatch.mjs");
    await writeFile(
      dispatcher,
      `
const env = Object.fromEntries(${JSON.stringify(Object.keys(env))}.map(key => [key, process.env[key]]));
const active = new Set();
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of active) if (child.exitCode === null) child.kill();
  await Promise.allSettled([...active].map(child => child.exited));
  process.exit(0);
}
function reply(value) {
  if (stopping) return;
  try { process.send(value); } catch { void stop(); }
}
process.on("SIGTERM", () => { void stop(); });
process.on("disconnect", () => { void stop(); });
async function run(consumer, args, input) {
  const child = Bun.spawn(args, { env, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  active.add(child);
  if (input !== undefined) { child.stdin.write(input); child.stdin.end(); }
  try {
    const [output, errors, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    process.stderr.write(errors);
    return { consumer, output, status };
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    active.delete(child);
  }
}
process.on("message", async ({ id, phase }) => {
  if (stopping) return;
  try {
    let output;
    if (phase === "consume") {
      const input = "protocol=https\\nhost=github.com\\npath=acme/repo.git\\n\\n";
      const values = await Promise.all([
        run("gh", ["gh", "auth", "token", "--hostname", "github.com"]),
        id === 1
          ? run("git", ["git", "credential", "fill"], input)
          : run("alias", ["git", "-c", "alias.creds=credential", "creds", "fill"], input),
      ]);
      if (id === 1) values.push(await run("config", ["git", "config", "--get", "armada.probe"]));
      const failed = values.find(value => value.status !== 0);
      if (failed) { reply({ id, consumer: failed.consumer }); return; }
      output = values.map(value => value.output).join("");
    } else if (phase === "denied") {
      const [url, repo] = await Promise.all([
        run("denied-url", ["gh", "pr", "view", "https://github.com/foreign/repo/pull/1"]),
        run("denied-repo", ["gh", "repo", "view", "foreign/repo"]),
      ]);
      output = url.output + "URL_STATUS:" + url.status + "\\n" + repo.output + "REPO_STATUS:" + repo.status + "\\n";
    } else { reply({ id, consumer: "phase" }); return; }
    reply({ id, output });
  } catch { reply({ id, consumer: "spawn" }); }
});
reply({ ready: true });
`,
    );
    const ready = Promise.withResolvers<void>();
    let waiting: { id: number; resolve(value: string): void; reject(error: Error): void } | undefined;
    let nextPhase = 0;
    const native = Bun.spawn([process.execPath, dispatcher], {
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      detached: true,
      ipc(message) {
        const reply = message as { ready?: boolean; id?: number; output?: unknown; consumer?: string };
        if (reply.ready) {
          ready.resolve();
          return;
        }
        const pending = waiting;
        waiting = undefined;
        if (!pending) return;
        if (reply.id !== pending.id || typeof reply.output !== "string") {
          pending.reject(Error(`native fixture consumer failed (${reply.consumer ?? "protocol"})`));
        } else pending.resolve(reply.output);
      },
    });
    child = native;
    void native.exited.then(() => {
      const error = Error("native fixture exited before completing its IPC reply");
      ready.reject(error);
      waiting?.reject(error);
      waiting = undefined;
    });
    const errors = new Response(native.stderr).text().catch(() => undefined);
    async function errorText() {
      const text = await errors;
      if (text === undefined) throw Error("fixture stderr failed");
      return text;
    }
    await ready.promise;
    async function phase(name: "consume" | "denied" = "consume") {
      const id = ++nextPhase;
      const response = new Promise<string>((resolve, reject) => {
        waiting = { id, resolve, reject };
        native.send({ id, phase: name });
      });
      return response;
    }
    // Exercise direct Git before rotation and alias expansion after it; both use
    // the same credential helper. Only gh needs two receipts to prove token rotation.
    const first = await phase();
    if (!first.includes("password=***") || !first.includes("preserved")) {
      native.disconnect();
      await native.exited;
      let diagnostic = await errorText();
      for (const secret of [current, next, "inherited-stale"]) diagnostic = diagnostic.replaceAll(secret, "***");
      throw Error(diagnostic);
    }
    expect(registered.has(current)).toBe(true);
    expect(first.match(/password=\*\*\*/g)).toHaveLength(1);
    expect(first).not.toContain(current);
    expect(first).toContain("preserved");
    expect(first.split("\n")[0]).toBe(`${createHash("sha256").update(`${current}\n`).digest("hex")}  -`);
    token = next;
    const second = await phase();
    expect(registered.has(next)).toBe(true);
    expect(registered.has(current)).toBe(true);
    expect(second.match(/password=\*\*\*/g)).toHaveLength(1);
    expect(second).not.toContain(next);
    expect(second.split("\n")[0]).toBe(`${createHash("sha256").update(`${next}\n`).digest("hex")}  -`);
    expect(second).not.toContain("inherited-stale");
    expect(second).not.toContain(current);
    const denied = await phase("denied");
    expect(denied).toContain("URL_STATUS:1");
    expect(denied).toContain("REPO_STATUS:1");
    native.disconnect();
    await native.exited;
    expect(await errorText()).toBe(
      "Managed GitHub credentials unavailable (request: invalid_response).\nManaged GitHub credentials unavailable (request: invalid_response).\n",
    );
  } finally {
    if (child) {
      child.disconnect();
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupFailure = error;
        }
      }
      await child.exited;
    }
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
