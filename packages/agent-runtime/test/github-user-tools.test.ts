import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubBroker } from "../src/github-broker.ts";

// The OS permission boundary belongs here; RPC/redaction belong to github-control.test.ts.
test("user-local Git/gh install and refreshed credentials work without privilege escalation", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-user-github-"));
  const home = join(root, "home"),
    tools = join(root, "tools");
  await mkdir(home);
  let token = "offline-first-token",
    acquisitions = 0;
  const broker = new GitHubBroker(() => {}, (async () => {
    acquisitions++;
    return Response.json({ token });
  }) as unknown as typeof fetch);
  const config = {
    version: 1 as const,
    revision: "1",
    generation: "offline",
    url: "https://armada.example/api/runtime/github/credentials",
    capability: `armada_gh_${"a".repeat(64)}`,
    expiresAt: Date.now() + 60000,
  };
  broker.configure(config);
  const listener = await broker.listen(tools);
  const unprivileged = (args: string[]) =>
    process.platform === "linux" ? ["setpriv", "--no-new-privs", ...args] : args;
  try {
    const gh = Bun.which("gh");
    if (!gh) throw Error("Actual gh required");
    const installer = Bun.spawn(
      unprivileged([
        process.execPath,
        "-e",
        `const {installUserGitHubTools}=await import(${JSON.stringify(join(import.meta.dir, "../src/github-tools.ts"))});await installUserGitHubTools(await Bun.stdin.json())`,
      ]),
      {
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    installer.stdin.write(
      JSON.stringify({
        root: tools,
        socket: listener.socket,
        activation: listener.activation,
        git: "/usr/bin/git",
        gh,
        homes: [home],
      }),
    );
    installer.stdin.end();
    const installerOutput = new Response(installer.stdout).text(),
      installerError = new Response(installer.stderr).text();
    expect(await installer.exited).toBe(0);
    expect(await installerOutput).toBe("");
    expect(await installerError).toBe("");
    for (const revision of ["1", "2"]) {
      token = revision === "1" ? "offline-first-token" : "offline-refreshed-token";
      broker.configure({ ...config, revision });
      const command = Bun.spawn(
        unprivileged([
          "/bin/bash",
          "--noprofile",
          "--norc",
          "-c",
          "printf 'protocol=https\\nhost=github.com\\npath=example/project.git\\n\\n' | git credential fill && GH_REPO=example/project gh auth token",
        ]),
        {
          env: { HOME: home, PATH: `${tools}/bin:/usr/bin:/bin`, GIT_CONFIG_NOSYSTEM: "1" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = new Response(command.stdout).text(),
        errors = new Response(command.stderr).text();
      expect(await command.exited).toBe(0);
      const text = await output;
      expect(text).toContain("password=***");
      expect(text.trim().endsWith("***")).toBe(true);
      expect(text).not.toContain(token);
      expect(await errors).toBe("");
      for (const file of [join(home, ".gitconfig"), join(tools, "bin/git"), join(tools, "bin/gh")])
        expect(await readFile(file, "utf8")).not.toContain(token);
    }
    expect(acquisitions).toBe(4);
  } finally {
    listener.close();
    await rm(root, { recursive: true, force: true });
  }
});
