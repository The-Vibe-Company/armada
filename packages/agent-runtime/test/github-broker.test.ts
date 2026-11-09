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
    if (!gh) throw Error("Actual gh executable required for credential-boundary verification");
    const observer = join(root, "observe-gh");
    await writeFile(observer, `#!/bin/sh\n${gh} "$@" | sha256sum\n`, { mode: 0o700 });
    const gitObserver = join(root, "observe-git");
    await writeFile(gitObserver, `#!/bin/sh\nexec /usr/bin/git "$@"\n`, { mode: 0o700 });
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
        "gh auth token --hostname github.com\nprintf 'protocol=https\\nhost=github.com\\npath=acme/repo.git\\n\\n' | git credential fill\ngit config --get armada.probe\necho PHASE_DONE\n",
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
    expect(registered.has(current)).toBe(true);
    expect(first).toContain("password=***");
    expect(first).toContain("preserved");
    expect(first.split("\n")[0]).toBe(`${createHash("sha256").update(`${current}\n`).digest("hex")}  -`);
    token = next;
    const second = await phase();
    expect(registered.has(next)).toBe(true);
    expect(registered.has(current)).toBe(true);
    expect(second).toContain("password=***");
    expect(second.split("\n")[0]).toBe(`${createHash("sha256").update(`${next}\n`).digest("hex")}  -`);
    expect(second).not.toContain("inherited-stale");
    expect(second).not.toContain(current);
    child.stdin.write("gh pr view https://github.com/foreign/repo/pull/1; echo URL_STATUS:$?; echo PHASE_DONE\n");
    while (!pending.includes("PHASE_DONE\n")) {
      const item = await reader.read();
      if (item.done) throw Error("fixture exited");
      pending += new TextDecoder().decode(item.value);
    }
    expect(pending).toContain("URL_STATUS:1");
    child.stdin.end();
    await child.exited;
    expect(await new Response(child.stderr).text()).toBe("Managed GitHub credentials unavailable.\n");
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
