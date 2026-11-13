import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Actual compiled entrypoint, private exec HOME vs harness HOME, real Git and gh,
// and Linux no-new-privileges. All HTTP stays on the local offline fixture.
test("unprivileged runtime configures and refreshes GitHub before authenticated Git/gh execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "armada-user-github-"));
  let token = "offline-first-token",
    acquisitions = 0;
  const sink = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      expect(await request.json()).toEqual({
        version: 1,
        repository: "example/project",
        operation: expect.any(String),
      });
      acquisitions++;
      return Response.json({ token });
    },
  });
  let child: import("bun").Subprocess<"pipe", "pipe", "pipe"> | undefined;
  try {
    const home = join(root, "home"),
      source = join(root, "source"),
      runtimeRoot = join(root, "runtime");
    await mkdir(home);
    await mkdir(source);
    const preload = join(root, "fixture-preload.ts");
    await writeFile(
      preload,
      `
const serve = Bun.serve;
Bun.serve = ((options) => { const server = serve(options); if (!options.unix) console.log("READY:"+server.port); return server; });
const original = globalThis.fetch;
globalThis.fetch = ((url, options) => original(String(url) === "https://armada.example/api/runtime/github/credentials" ? "http://127.0.0.1:${sink.port}" : url, options));
`,
    );
    const args = [process.execPath, "--preload", preload, join(import.meta.dir, "../dist/main.js")];
    child = Bun.spawn(process.platform === "linux" ? ["setpriv", "--no-new-privs", ...args] : args, {
      env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const grant = {
      token: "offline-private-runner-grant",
      sandboxId: "logical",
      generation: "1",
      expiresAt: Date.now() + 60000,
    };
    child.stdin.write(
      JSON.stringify({
        root: runtimeRoot,
        cwd: home,
        port: 0,
        grant,
        claudeExecutable: "/bin/false",
        codexExecutable: "/bin/false",
        claudeEnv: { HOME: home },
        codexEnv: { HOME: home },
        execEnv: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin" },
        ingestUrl: "http://127.0.0.1:1",
      }),
    );
    child.stdin.end();
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    const address = new TextDecoder().decode(ready.value).trim();
    expect(address).toMatch(/^READY:\d+$/);
    let sequence = 0;
    async function rpc(body: object) {
      const response = await fetch(`http://127.0.0.1:${address.split(":")[1]}/v1`, {
        method: "POST",
        headers: { "x-armada-runner-grant": grant.token },
        body: JSON.stringify({ version: 1, requestId: `request_${++sequence}`, sandboxId: grant.sandboxId, ...body }),
      });
      const value = (await response.json()) as {
        result: { acknowledged?: boolean; exitCode?: number; stdout?: string; stderr?: string };
      };
      expect(response.status).toBe(200);
      return value.result;
    }
    const configuration = {
      version: 1,
      revision: "1",
      generation: "1",
      url: "https://armada.example/api/runtime/github/credentials",
      capability: `armada_gh_${"a".repeat(64)}`,
      expiresAt: grant.expiresAt,
    };
    for (const revision of ["1", "2"]) {
      token = revision === "1" ? "offline-first-token" : "offline-refreshed-token";
      expect((await rpc({ op: "configureGitHub", configuration: { ...configuration, revision } })).acknowledged).toBe(
        true,
      );
      const result = await rpc({
        op: "exec",
        input: {
          sandboxId: "logical",
          command:
            "printf 'protocol=https\\nhost=github.com\\npath=example/project.git\\n\\n' | git credential fill\nGH_REPO=example/project gh auth token",
          cwd: home,
          timeoutSeconds: 30,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("password=***");
      expect(result.stdout).not.toContain(token);
      expect(result.stdout?.trim().endsWith("***")).toBe(true);
      expect(result.stderr).not.toContain(token);
    }
    expect(acquisitions).toBe(4);
    const local = await rpc({
      op: "exec",
      input: {
        sandboxId: "logical",
        cwd: home,
        timeoutSeconds: 30,
        command: `git -C '${source}' init --initial-branch=feature/work\ngit -C '${source}' -c user.name=Offline -c user.email=offline@example.test commit --allow-empty -m offline\ngit clone --single-branch --branch feature/work -- '${source}' '${home}/checkout'\ngit -C '${home}/checkout' log -1 --format=%s`,
      },
    });
    expect(local.exitCode).toBe(0);
    expect(local.stdout?.trim().endsWith("offline")).toBe(true);
    expect(await readFile(join(home, ".gitconfig"), "utf8")).not.toContain(token);
    expect(await readFile(join(home, ".gitconfig"), "utf8")).not.toContain(configuration.capability);
  } finally {
    child?.kill();
    if (child) await child.exited;
    sink.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
